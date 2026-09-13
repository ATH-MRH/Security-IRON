'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes,createHash}=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const Module=require('node:module');
const path=require('node:path');
const {Client}=require('pg');
const db=require('../backend/database');
const r=require('../backend/alert-core/repository');
const s=require('../backend/alert-core/service');
const {migrate}=require('../backend/db/postgresql/migrate');
const {testEnvironment}=require('./helpers/postgres-test-config');
const base=testEnvironment(),directory=path.resolve(__dirname,'../backend/db/postgresql/migrations');
// PG-8: service.js reads user.alertAccess/isSoc, resolved server-side from
// memberships by the router — hand-set here 1:1 with the PG-7 backfill shape,
// non-enumerably so any incidental deepEqual against the plain DB row shape
// ({id,username,role}) elsewhere in this file is unaffected.
function withAccess(user,alertAccess,isSoc){
 Object.defineProperty(user,'alertAccess',{value:alertAccess,enumerable:false});
 Object.defineProperty(user,'isSoc',{value:isSoc,enumerable:false});
 return user;
}
const admin=withAccess({id:1,username:'admin-test',role:'admin'},'scope',true),agent=withAccess({id:2,username:'agent-test',role:'agent'},'own',false);
const config={escalation:[30,60,120],incidentCritical:true,badgeThreshold:3,badgeWindowSeconds:120};
const input={site:'S',type:'T',level:3};
let root;
before(async()=>{root=new Client(db.configuration(base));await root.connect();});
after(async()=>{if(root)await root.end();});
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const name='securisite_test_pg32b_'+randomBytes(6).toString('hex');let pool,created=false;
 t.after(async()=>{try{if(pool)await pool.close();}finally{if(created)await root.query('DROP DATABASE "'+name+'" WITH (FORCE)');}});
 await root.query('CREATE DATABASE "'+name+'"');created=true;const url=new URL(base.DATABASE_URL);url.pathname='/'+name;
 const env={...base,DATABASE_URL:url.href,PGPOOL_MAX:'6',PGIDLE_TIMEOUT_MS:'1000'};await migrate({directory,migrationEnv:env});pool=db.createDatabase(env);
 for(const u of [admin,agent])await pool.query('INSERT INTO public.users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[u.id,u.username,'fixture',u.role]);return {db:pool,env};
}
const create=f=>f.db.transaction(c=>s.create(input,agent,'COMMAND',c));
const action=(id,name,user=admin,comment='reason')=>c=>s.act(id,{action:name,comment},user,c);
const detail=(f,a)=>s.detail(a.id,admin,f.db);
const eventCount=(d,name)=>d.timeline.filter(e=>e.action===name).length;
async function blocked(f,waiter,holder){
 const end=Date.now()+4000;while(Date.now()<end){const row=await f.db.get('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiter,holder]);if(row.blocked)return;await delay(10);}throw Error('No PostgreSQL blocking observed');
}
// Lock outside the service savepoint keeps the barrier even when the first
// operation is a rejected business transition. The second must really wait.
async function race(f,lock,one,two,{rollback=false}={}){
 const held=gate(),release=gate(),secondReady=gate();let pid1,pid2,value1,error1;
 const first=f.db.transaction(async c=>{pid1=(await c.get('SELECT pg_backend_pid() pid')).pid;await lock(c);
  try{value1=await one(c);}catch(e){error1=e;}held.resolve();await release.promise;
  if(error1)throw error1;if(rollback)throw Object.assign(Error('holder rollback'),{code:'TEST_ROLLBACK'});return value1;
 });
 const firstDone=first.then(value=>({value}),error=>({error}));
 await Promise.race([held.promise,firstDone.then(x=>{if(x.error)throw x.error;})]);
 const second=f.db.transaction(async c=>{pid2=(await c.get('SELECT pg_backend_pid() pid')).pid;secondReady.resolve();return two(c);});
 const secondDone=second.then(value=>({value}),error=>({error}));
 try{await secondReady.promise;assert.notEqual(pid1,pid2);await blocked(f,pid2,pid1);}finally{release.resolve();}
 return [await firstDone,await secondDone];
}
const rowLock=id=>c=>r.findAlertForUpdate(id,c);
const err=(result,status,message)=>{assert.equal(result.error?.status,status);assert.equal(result.error?.message,message);};

test('PG32B two acknowledgements: one success, one 409, no duplicated effects',async t=>{
 const f=await fixture(t),a=await create(f);const [x,y]=await race(f,rowLock(a.id),action(a.id,'ACQUITTEE'),action(a.id,'ACQUITTEE'));
 assert.equal(x.value.status,'ACQUITTEE');err(y,409,'Transition interdite');const d=await detail(f,a);assert.equal(eventCount(d,'ACQUITTEE'),1);assert.equal((await s.notifications(agent.id,f.db)).length,2);
});
for(const [initial,early,later] of [['NOTIFIEE','ACQUITTEE','EN_INTERVENTION'],['SOUS_CONTROLE','RESOLUE','CLOTUREE']])for(const reverse of [false,true])test('PG32B adjacent transitions '+early+'/'+later+' reverse='+reverse,async t=>{
 const f=await fixture(t),a=await create(f);await f.db.query('UPDATE public.security_alerts SET status=$1 WHERE id=$2',[initial,a.id]);
 const [x,y]=await race(f,rowLock(a.id),action(a.id,reverse?later:early),action(a.id,reverse?early:later));
 if(reverse){err(x,409,'Transition interdite');assert.equal(y.value.status,early);}else{assert.equal(x.value.status,early);assert.equal(y.value.status,later);}
});
for(const special of ['ANNULEE','FAUSSE_ALERTE'])for(const reverse of [false,true])test('PG32B special/transition '+special+' reverse='+reverse,async t=>{
 const f=await fixture(t),a=await create(f);const [x,y]=await race(f,rowLock(a.id),action(a.id,reverse?'ACQUITTEE':special),action(a.id,reverse?special:'ACQUITTEE'));
 assert.ok(x.value);if(reverse)assert.equal(y.value.status,special);else err(y,409,'Cette alerte est clôturée');
});
for(const branch of ['COMMENTAIRE','DEMANDE_ANNULATION'])test('PG32B '+branch+' then transition',async t=>{
 const f=await fixture(t),a=await create(f);const [x,y]=await race(f,rowLock(a.id),action(a.id,branch,agent),action(a.id,'ACQUITTEE'));assert.ok(x.value);assert.equal(y.value.status,'ACQUITTEE');assert.equal(eventCount(await detail(f,a),branch),1);
});
for(const reverse of [false,true])test('PG32B escalation/acknowledgement reverse='+reverse,async t=>{
 const f=await fixture(t),a=await create(f),time=Date.parse(a.created_at)+200000;const escalate=c=>s.escalateDue(time,c);
 const [x,y]=await race(f,rowLock(a.id),reverse?action(a.id,'ACQUITTEE'):escalate,reverse?escalate:action(a.id,'ACQUITTEE'));assert.equal(x.error,undefined);assert.equal(y.error,undefined);
 const d=await detail(f,a);assert.equal(d.status,'ACQUITTEE');assert.equal(d.escalation_step,reverse?0:3);assert.equal(eventCount(d,'ESCALADE'),reverse?0:3);
});
for(const change of ["level=2","status='RESOLUE'","acknowledged_at='ack'"])test('PG32B candidate becomes ineligible '+change,async t=>{
 const f=await fixture(t),a=await create(f),held=gate(),go=gate();let holder,waiter;
 const first=f.db.transaction(async c=>{holder=(await c.get('SELECT pg_backend_pid() pid')).pid;await r.findAlertForUpdate(a.id,c);held.resolve();await go.promise;await c.query('UPDATE public.security_alerts SET '+change+' WHERE id=$1',[a.id]);});await held.promise;
 const second=f.db.transaction(async c=>{waiter=(await c.get('SELECT pg_backend_pid() pid')).pid;return s.escalateDue(Date.now()+200000,c);});const observed=second.then(()=>null,e=>e);
 try{while(!waiter)await delay(1);await blocked(f,waiter,holder);}finally{go.resolve();}await first;assert.equal(await observed,null);assert.equal(eventCount(await detail(f,a),'ESCALADE'),0);
});
for(const initial of [null,''])test('PG32B notification readers initial='+JSON.stringify(initial),async t=>{
 const f=await fixture(t),a=await create(f),n=(await s.notifications(agent.id,f.db))[0];await f.db.query('UPDATE public.alert_notifications SET read_at=$1 WHERE id=$2',[initial,n.id]);
 const [x,y]=await race(f,c=>r.findNotificationForUpdate(n.id,agent.id,c),c=>s.readNotification(n.id,agent,c),c=>s.readNotification(n.id,agent,c));assert.deepEqual(x.value,{ok:true});assert.deepEqual(y.value,{ok:true});assert.equal(eventCount(await detail(f,a),'LECTURE_NOTIFICATION'),1);
});
test('PG32B rules concurrent previous/current chain',async t=>{
 const f=await fixture(t),one={...config,badgeThreshold:4},two={...config,badgeThreshold:5};const [x,y]=await race(f,c=>r.readConfigForUpdate(c),c=>s.updateRules(one,admin,c),c=>s.updateRules(two,admin,c));assert.deepEqual(x.value,one);assert.deepEqual(y.value,two);
 const rows=(await s.configAudit(f.db)).reverse();assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>[JSON.parse(x.previous),JSON.parse(x.current)]),[[config,one],[one,two]]);
});
async function seedBadge(f,badge){for(let i=0;i<3;i++)await f.db.query('INSERT INTO public.pietons(id,badge,resultat,datetime) VALUES($1,$2,$3,$4)',[badge+i,badge,'refus',new Date().toISOString()]);}
const badgeCall=badge=>c=>s.fromBadge({badge,resultat:'refus',point:'S'},agent,c);
test('PG32B rollback badge holder releases and second recalculates',async t=>{
 const f=await fixture(t);await seedBadge(f,'B');const [x,y]=await race(f,c=>r.lockBadge('B',c),badgeCall('B'),badgeCall('B'),{rollback:true});assert.equal(x.error.code,'TEST_ROLLBACK');assert.equal(y.error,undefined);assert.equal((await s.list(admin,f.db)).length,1);
});
test('PG32B rollback alert holder allows second acknowledgement',async t=>{
 const f=await fixture(t),a=await create(f);const [x,y]=await race(f,rowLock(a.id),action(a.id,'ACQUITTEE'),action(a.id,'ACQUITTEE'),{rollback:true});assert.equal(x.error.code,'TEST_ROLLBACK');assert.equal(y.value.status,'ACQUITTEE');assert.equal(eventCount(await detail(f,a),'ACQUITTEE'),1);
});
test('PG32B audit failure rolls back action and propagates original SQL error',async t=>{
 const f=await fixture(t),a=await create(f);await assert.rejects(f.db.transaction(c=>s.act(a.id,{action:'ACQUITTEE'},admin,{...c,query:async(sql,args)=>{
 if(sql.startsWith('INSERT INTO public.alert_audit')){args=[...args];args[4]=null;}return c.query(sql,args);
 }})),e=>e.code==='23502');const d=await detail(f,a);assert.equal(d.status,'NOTIFIEE');assert.equal(eventCount(d,'ACQUITTEE'),0);assert.equal((await s.notifications(agent.id,f.db)).length,1);
});
for(const isolation of ['READ COMMITTED','REPEATABLE READ','SERIALIZABLE'])test('PG32B isolation '+isolation,async t=>{
 const f=await fixture(t),a=await create(f);const operation=f.db.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL '+isolation);return s.act(a.id,{action:'ACQUITTEE'},admin,c);});
 if(isolation==='READ COMMITTED')assert.equal((await operation).status,'ACQUITTEE');else await assert.rejects(operation,e=>e.code==='ALERT_ISOLATION_REQUIRED'&&e.status===undefined);
});
test('PG32B locking primitives refuse absent clients and autocommit pool',async t=>{
 const f=await fixture(t);for(const run of [()=>r.findAlertForUpdate('x'),()=>r.readConfigForUpdate(),()=>r.findNotificationForUpdate(1,1),()=>r.lockBadge('B')])await assert.rejects(run(),e=>e.code==='ALERT_TRANSACTION_REQUIRED');
 let lockQueries=0;const pool={...f.db,get:async(sql,args)=>{if(sql.includes('FOR UPDATE'))lockQueries++;return f.db.get(sql,args);}};
 await assert.rejects(r.findAlertForUpdate('x',pool),e=>e.code==='ALERT_TRANSACTION_REQUIRED');assert.equal(lockQueries,0);
 await f.db.transaction(async c=>{await assert.rejects(r.readConfigForUpdate(f.db),/client transactionnel/);assert.ok(await r.readConfigForUpdate(c));});
});
for(const value of ['0','-1','1.5','abc','60001',''])test('PG32B invalid timeout '+JSON.stringify(value),async t=>{
 const f=await fixture(t),old=process.env.SECURISITE_ALERT_LOCK_TIMEOUT_MS;process.env.SECURISITE_ALERT_LOCK_TIMEOUT_MS=value;
 try{await assert.rejects(f.db.transaction(c=>r.readConfigForUpdate(c)),e=>e.code==='ALERT_LOCK_CONFIG_INVALID');}finally{if(old===undefined)delete process.env.SECURISITE_ALERT_LOCK_TIMEOUT_MS;else process.env.SECURISITE_ALERT_LOCK_TIMEOUT_MS=old;}
});
test('PG32B local timeout respects stricter parent, maps timeout and restores savepoint context',async t=>{
 const f=await fixture(t),a=await create(f),held=gate(),release=gate();let pid;
 const owner=f.db.transaction(async c=>{pid=(await c.get('SELECT pg_backend_pid() pid')).pid;await r.findAlertForUpdate(a.id,c);held.resolve();await release.promise;});await held.promise;
 try{await f.db.transaction(async c=>{
  await c.query("SELECT set_config('lock_timeout','80ms',true)");let seen;
  const cx={...c,get:async(sql,args)=>{if(sql.includes('FOR UPDATE'))seen=(await c.get("SELECT setting FROM pg_settings WHERE name='lock_timeout'")).setting;return c.get(sql,args);}};
  await assert.rejects(s.act(a.id,{action:'ACQUITTEE'},admin,cx),e=>e.code==='ALERT_LOCK_TIMEOUT'&&e.cause.code==='55P03'&&e.status===undefined&&e.message==='Opération temporairement indisponible');assert.equal(seen,'80');
  assert.equal((await c.get("SELECT setting FROM pg_settings WHERE name='lock_timeout'")).setting,'80');assert.equal((await r.findAlert(a.id,c)).status,'NOTIFIEE');
 });}finally{release.resolve();await owner;}
 assert.equal(eventCount(await detail(f,a),'ACQUITTEE'),0);
 await f.db.transaction(async c=>{await c.query("SELECT set_config('lock_timeout','0',true)");let during;await r.findAlertForUpdate(a.id,{...c,get:async(sql,args)=>{if(sql.includes('FOR UPDATE'))during=(await c.get("SELECT setting FROM pg_settings WHERE name='lock_timeout'")).setting;return c.get(sql,args);}});assert.equal(during,'2000');assert.equal((await c.get("SELECT setting FROM pg_settings WHERE name='lock_timeout'")).setting,'0');});
});
test('PG32B stable parent alert lock order preserves original candidate processing order',async t=>{
 const f=await fixture(t),a=await create(f),b=await create(f);const candidates=await r.pendingEscalations(f.db),locks=[],updates=[];
 await f.db.transaction(c=>s.escalateDue(Date.now()+200000,{...c,get:async(sql,args)=>{if(sql.includes('security_alerts')&&sql.endsWith('FOR UPDATE'))locks.push(args[0]);return c.get(sql,args);},query:async(sql,args)=>{if(sql.startsWith('UPDATE public.security_alerts SET escalation_step')&&args[0]===1)updates.push(args[2]);return c.query(sql,args);}}));
 assert.deepEqual(locks.slice(0,2),[a.id,b.id].sort());assert.deepEqual(updates,candidates.map(x=>x.id));
});
test('PG32B composed parent follows badge rules notification alert order on one PID',async t=>{
 const f=await fixture(t),a=await create(f),n=(await s.notifications(agent.id,f.db))[0];const pids=[];
 await f.db.transaction(async c=>{const cx={};for(const method of ['query','get','all'])cx[method]=async(...args)=>{pids.push((await c.get('SELECT pg_backend_pid() pid')).pid);return c[method](...args);};
 await r.lockBadge('B',cx);await r.readConfigForUpdate(cx);await r.findNotificationForUpdate(n.id,agent.id,cx);await r.findAlertForUpdate(a.id,cx);
 await s.updateRules(config,admin,cx);await s.readNotification(n.id,agent,cx);await s.act(a.id,{action:'ACQUITTEE'},admin,cx);
 });assert.equal(new Set(pids).size,1);
});
// Worker code is supplied in memory: no helper file or deployment dependency.
const workerCode=`
const db=require('./backend/database'),r=require('./backend/alert-core/repository'),s=require('./backend/alert-core/service');
let release;const gate=new Promise(x=>release=x);process.on('message',m=>{if(m==='release')release();});
(async()=>{const task=JSON.parse(process.env.PG32B_TASK);await db.transaction(async c=>{
 process.send({pid:(await c.get('SELECT pg_backend_pid() pid')).pid});
 const cx={...c,query:async(sql,args)=>{if(sql.includes('pg_advisory_xact_lock'))process.send({key:args[0]});return c.query(sql,args);}};
 if(task.kind==='escalate')await s.escalateDue(task.time,cx);
 else await s.fromBadge({badge:task.badge,resultat:'refus',point:'S'},{id:2,username:'agent-test',role:'agent'},cx);
 process.send({held:true});if(task.hold)await gate;
 });await db.close();process.send({done:true});process.disconnect();})().catch(async e=>{process.send({error:{code:e.code,message:e.message}});await db.close();process.disconnect();process.exitCode=1;});`;
function worker(t,f,task){
 const child=spawn(process.execPath,['-e',workerCode],{cwd:path.resolve(__dirname,'..'),env:{...process.env,...f.env,PG32B_TASK:JSON.stringify(task)},stdio:['ignore','pipe','pipe','ipc']});const messages=[];let ended=false;const waiters=[];
 child.on('message',m=>{messages.push(m);for(const wake of waiters.splice(0))wake();});child.on('exit',()=>{ended=true;for(const wake of waiters.splice(0))wake();});
 let stderr='';child.stderr.on('data',x=>stderr+=x);child.stdout.resume();
 t.after(()=>{if(!ended)child.kill('SIGKILL');});
 return {release:()=>child.send('release'),async wait(key){const until=Date.now()+8000;while(Date.now()<until){const error=messages.find(m=>m.error);if(error)throw Error(JSON.stringify(error));const m=messages.find(m=>key in m);if(m)return m[key];if(ended)throw Error('worker exited '+stderr);await Promise.race([new Promise(r=>waiters.push(r)),delay(20)]);}throw Error('worker timeout '+key);}};
}
test('PG32B separate processes escalation workers really block and do not duplicate',async t=>{
 const f=await fixture(t),a=await create(f),time=Date.parse(a.created_at)+200000;const first=worker(t,f,{kind:'escalate',time,hold:true});const pid=await first.wait('pid');await first.wait('held');
 const second=worker(t,f,{kind:'escalate',time});try{await blocked(f,await second.wait('pid'),pid);}finally{first.release();}await first.wait('done');await second.wait('done');const d=await detail(f,a);assert.equal(eventCount(d,'ESCALADE'),3);assert.equal((await s.notifications(agent.id,f.db)).length,4);
});
test('PG32B separate processes same badge/key, lock retained after savepoint release',async t=>{
 const f=await fixture(t);await seedBadge(f,'Exact é B');const first=worker(t,f,{kind:'badge',badge:'Exact é B',hold:true});const pid=await first.wait('pid');await first.wait('held');
 const second=worker(t,f,{kind:'badge',badge:'Exact é B'});try{await blocked(f,await second.wait('pid'),pid);assert.equal(await first.wait('key'),await second.wait('key'));const expected=createHash('sha256').update('securisite:alert-core:badge:v1\0').update('Exact é B').digest().readBigInt64BE(0).toString();assert.equal(await first.wait('key'),expected);}finally{first.release();}
 await first.wait('done');await second.wait('done');assert.equal((await s.list(admin,f.db)).length,1);
});
test('PG32B different badge processes progress while first transaction remains open',async t=>{
 const f=await fixture(t);await seedBadge(f,'A');await seedBadge(f,'B');const first=worker(t,f,{kind:'badge',badge:'A',hold:true});await first.wait('held');
 try{const second=worker(t,f,{kind:'badge',badge:'B'});await second.wait('done');assert.notEqual(await first.wait('key'),await second.wait('key'));assert.equal((await s.list(admin,f.db)).length,1);}finally{first.release();}await first.wait('done');assert.equal((await s.list(admin,f.db)).length,2);
});
test('PG32B deliberate reversed row order reports deadlock without retry or false commit',async t=>{
 const f=await fixture(t),a=await create(f),b=await create(f),ready1=gate(),ready2=gate();let attempts=0;
 const run=(first,second,own,other)=>f.db.transaction(async c=>{attempts++;await c.query("SET LOCAL deadlock_timeout='50ms'");await r.findAlertForUpdate(first.id,c);own.resolve();await other.promise;await r.findAlertForUpdate(second.id,c);await s.act(first.id,{action:'ACQUITTEE'},admin,c);});
 const results=await Promise.allSettled([run(a,b,ready1,ready2),run(b,a,ready2,ready1)]);assert.equal(attempts,2);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'40P01');
 const rows=await s.list(admin,f.db);assert.equal(rows.filter(x=>x.status==='ACQUITTEE').length,1);
});

// Load the reviewed historical service in memory, without rewriting the checkout.
function historicalBadgeService(){
 const filename=path.resolve(__dirname,'../backend/alert-core/service.js');
 const historical=new Module(filename,module);historical.filename=filename;historical.paths=Module._nodeModulePaths(path.dirname(filename));
 historical._compile(execFileSync('git',['show','5219313f91b68637021f4f1387e38a6d749e8234:backend/alert-core/service.js'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'}),filename);
 return historical.exports;
}
for(const badge of ['123',123])test('PG32B badge TEXT parity '+typeof badge,async t=>{
 const f=await fixture(t);await seedBadge(f,'123');
 await f.db.transaction(async c=>{
  const since=new Date(Date.now()-120000).toISOString();
  assert.equal(await r.badgeRefusalCount(badge,since,c),3);
  await s.fromBadge({badge,resultat:'refus',point:'S'},agent,c);
  const rows=await s.list(admin,c);assert.equal(rows.length,1);assert.equal(rows[0].equipment,'badge:123');
  assert.equal((await r.recentBadgeAlert('badge:123',since,c)).id,rows[0].id);
  await s.fromBadge({badge:typeof badge==='number'?'123':123,resultat:'refus',point:'S'},agent,c);
  assert.equal((await s.list(admin,c)).length,1);
 });
});
test('PG32B numeric badge direct historical HEAD parity after rollback',async t=>{
 const f=await fixture(t);await seedBadge(f,'123');const historical=historicalBadgeService(),rollback=Error('parity fixture rollback');let before;
 const snapshot=async c=>{
  const rows=await s.list(admin,c);assert.equal(rows.length,1);const d=await s.detail(rows[0].id,admin,c);
  const {id,created_at,updated_at,timeline,...fields}=d;
  return {fields,timeline:timeline.map(({actor,action,detail})=>({actor,action,detail})),notifications:await c.all('SELECT user_id,message,read_at FROM public.alert_notifications ORDER BY user_id,message')};
 };
 await assert.rejects(f.db.transaction(async c=>{
  assert.equal(await historical.fromBadge({badge:123,resultat:'refus',point:'S'},agent,c),undefined);
  before=await snapshot(c);assert.equal(before.fields.equipment,'badge:123');throw rollback;
 }),e=>e===rollback);
 assert.equal((await s.list(admin,f.db)).length,0);
 await f.db.transaction(async c=>{assert.equal(await s.fromBadge({badge:123,resultat:'refus',point:'S'},agent,c),undefined);assert.deepEqual(await snapshot(c),before);});
});
for(const badge of [null,undefined])test('PG32B badge '+String(badge)+' keeps historical no-op',async()=>{
 const forbidden=()=>{throw Error('Unexpected database access');};const client={query:forbidden,get:forbidden,all:forbidden};
 for(const service of [historicalBadgeService(),s])assert.equal(await service.fromBadge({badge,resultat:'refus',point:'S'},agent,client),undefined);
 await assert.rejects(r.lockBadge(badge,client),e=>e.code==='ERR_INVALID_ARG_TYPE');
});
for(const [left,right] of [['123','123'],[123,123],[123,'123']])test('PG32B numeric/text badge processes '+typeof left+'/'+typeof right,async t=>{
 const f=await fixture(t);await seedBadge(f,'123');const first=worker(t,f,{kind:'badge',badge:left,hold:true});const pid=await first.wait('pid');await first.wait('held');
 const second=worker(t,f,{kind:'badge',badge:right});
 try{
  await blocked(f,await second.wait('pid'),pid);
  assert.equal(await first.wait('key'),await second.wait('key'));
  const expected=createHash('sha256').update('securisite:alert-core:badge:v1\0').update('123').digest().readBigInt64BE(0).toString();
  assert.equal(await first.wait('key'),expected);
 }finally{first.release();}
 await first.wait('done');await second.wait('done');const rows=await s.list(admin,f.db);assert.equal(rows.length,1);assert.equal(rows[0].equipment,'badge:123');
});
for(const [left,right] of [[' 123 ','123'],['ABC','abc'],['é','e\u0301']])test('PG32B badge identity remains distinct '+JSON.stringify([left,right]),async t=>{
 const f=await fixture(t);let keys=[];
 await f.db.transaction(async c=>{
  const capture={...c,query:async(sql,args)=>{if(sql.includes('pg_advisory_xact_lock'))keys.push(args[0]);return c.query(sql,args);}};
  await r.lockBadge(left,capture);await r.lockBadge(right,capture);
 });
 assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
 for(let i=0;i<2;i++)assert.equal(keys[i],createHash('sha256').update('securisite:alert-core:badge:v1\0').update([left,right][i]).digest().readBigInt64BE(0).toString());
});
