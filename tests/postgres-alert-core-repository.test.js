'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const db = require('../backend/database');
const repository = require('../backend/alert-core/repository');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.join(__dirname, '../backend/db/postgresql/migrations');
const originalSQL = ['001_core_legacy.sql','002_alert_core.sql'].map(name => fs.readFileSync(path.join(directory,name)));
const initialConfig = '{"escalation":[30,60,120],"incidentCritical":true,"badgeThreshold":3,"badgeWindowSeconds":120}';
const stamp = '2026-09-09T10:00:00.000Z';
let root, defaultName;
const databaseName = () => 'securisite_test_pg31_' + randomBytes(6).toString('hex');
function environment(name) {
  const url = new URL(baseEnv.DATABASE_URL); url.pathname = '/' + name;
  return {...baseEnv,DATABASE_URL:url.href,PGIDLE_TIMEOUT_MS:'1000'};
}
async function install(env) {
  return migrate({directory,migrationEnv:env,lockTimeoutMs:2000,retryDelayMs:10});
}
before(async () => {
  root = new Client(db.configuration(baseEnv)); await root.connect();
  defaultName = databaseName(); await root.query('CREATE DATABASE "'+defaultName+'"');
  const env = environment(defaultName);
  await install(env);
  // Only this test process: default repository calls target a dedicated disposable DB.
  Object.assign(process.env,env);
});
after(async () => {
  try {
    await db.close();
    if (defaultName) await root.query('DROP DATABASE "'+defaultName+'" WITH (FORCE)');
  } finally { if (root) await root.end(); }
});

async function fixture(t, migrated = true) {
  const name = databaseName(); let created = false, pool;
  t.after(async () => {
    try { if (pool) await pool.close(); }
    finally { if (created) await root.query('DROP DATABASE "'+name+'" WITH (FORCE)'); }
  });
  await root.query('CREATE DATABASE "'+name+'"'); created = true;
  const env = environment(name);
  if (migrated) await install(env);
  pool = db.createDatabase(env);
  return {db:pool,env,name};
}
function params(id = 'alert-a', overrides = {}) {
  const values = {
    id,createdAt:stamp,updatedAt:stamp,site:'site-A',zone:'zone-B',type:'type-C',level:3,
    origin:'COMMAND',createdBy:77,username:'creator',status:'NOTIFIEE',comment:'comment-D',
    latitude:36.752887,longitude:3.042048,equipment:'equipment-E',policy:'[30,60,120]',
    ...overrides,
  };
  return Object.values(values);
}
const insert = (client,id,overrides) => repository.insertAlert(...params(id,overrides),client);
const ids = rows => rows.map(row => row.id);
async function user(client,id,role='agent') {
  await client.query('INSERT INTO public.users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[id,'user-'+id,'fixture-only',role]);
}
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };

test('PG31: init read-only succeeds; no schema/data/seed added on repeated calls',async t=>{
  const f=await fixture(t);
  const schema=await f.db.all("SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','securisite_meta') ORDER BY 1,2");
  const ledger=await f.db.all('SELECT * FROM securisite_meta.schema_migrations ORDER BY version');
  await f.db.transaction(async client=>{
    await client.query('SET TRANSACTION READ ONLY');
    assert.equal(await repository.init(client),undefined);
    await repository.init(client);
  });
  assert.deepEqual(await f.db.all("SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','securisite_meta') ORDER BY 1,2"),schema);
  assert.deepEqual(await f.db.all('SELECT * FROM securisite_meta.schema_migrations ORDER BY version'),ledger);
  assert.deepEqual(await f.db.all('SELECT * FROM public.alert_rules'),[{id:1,config:initialConfig}]);
  for(const table of ['security_alerts','alert_audit','alert_notifications','alert_config_audit','users'])assert.equal((await f.db.get('SELECT count(*)::int n FROM public.'+table)).n,0);
});
for(const table of ['security_alerts','alert_audit','alert_notifications','alert_config_audit','alert_rules']){
  test('PG31: init refuses missing '+table+' without repair',async t=>{
    const f=await fixture(t);await f.db.query('DROP TABLE public.'+table+' CASCADE');
    await assert.rejects(repository.init(f.db),e=>e.code==='ALERT_SCHEMA_UNAVAILABLE'&&e.message.includes(table));
    assert.equal((await f.db.get('SELECT to_regclass($1) AS relation',['public.'+table])).relation,null);
  });
}
test('PG31: init rejects completely empty database without creating objects',async t=>{
  const f=await fixture(t,false);
  await assert.rejects(repository.init(f.db),e=>e.code==='ALERT_SCHEMA_UNAVAILABLE');
  assert.deepEqual(await f.db.all("SELECT tablename FROM pg_tables WHERE schemaname IN ('public','securisite_meta')"),[]);
});
test('PG31: init and readConfig refuse absent singleton; update does not recreate it',async t=>{
  const f=await fixture(t);await f.db.query('DELETE FROM public.alert_rules');
  await assert.rejects(repository.init(f.db),e=>e.code==='ALERT_CONFIG_MISSING');
  await assert.rejects(repository.readConfig(f.db),e=>e.code==='ALERT_CONFIG_MISSING');
  assert.deepEqual(await repository.updateConfig('{}',f.db),{rowCount:0});
  assert.deepEqual(await f.db.all('SELECT * FROM public.alert_rules'),[]);
});
test('PG31: readConfig returns raw TEXT, including non-JSON content',async t=>{
  const f=await fixture(t);
  assert.equal(await repository.readConfig(f.db),initialConfig);
  assert.deepEqual(await repository.updateConfig('raw legacy text',f.db),{rowCount:1});
  assert.equal(await repository.readConfig(f.db),'raw legacy text');
});

test('PG31: insert/find exact 16 parameter order and PostgreSQL types',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await insert(f.db,'distinct',{createdAt:'created',updatedAt:'updated'}),{rowCount:1});
  assert.deepEqual(await repository.findAlert('distinct',f.db),{
    id:'distinct',created_at:'created',updated_at:'updated',site:'site-A',zone:'zone-B',type:'type-C',
    level:3,origin:'COMMAND',created_by:77,username:'creator',status:'NOTIFIEE',owner:null,
    acknowledged_at:null,resolved_at:null,comment:'comment-D',latitude:36.752887,longitude:3.042048,
    equipment:'equipment-E',cancellation_requested:0,escalation_step:0,policy:'[30,60,120]',
  });
});
test('PG31: findAlert absent is null and coordinates remain NULL',async t=>{
  const f=await fixture(t);assert.equal(await repository.findAlert('absent',f.db),null);
  await insert(f.db,'nullable',{latitude:null,longitude:null});
  const a=await repository.findAlert('nullable',f.db);assert.equal(a.latitude,null);assert.equal(a.longitude,null);
});
test('PG31: bound parameters preserve quotes and SQL-like strings without interpretation',async t=>{
  const f=await fixture(t);const value="x'); DROP TABLE users; --";
  await insert(f.db,value,{comment:value,policy:value});
  assert.equal((await repository.findAlert(value,f.db)).comment,value);
  assert.equal((await f.db.get('SELECT count(*)::int n FROM public.users')).n,0);
});
test('PG31: duplicate insert and invalid level propagate PostgreSQL errors',async t=>{
  const f=await fixture(t);await insert(f.db,'same');
  await assert.rejects(insert(f.db,'same'),e=>e.code==='23505');
  await assert.rejects(insert(f.db,'bad',{level:5}),e=>e.code==='23514');
});
test('PG31: appendAudit returns identity; timeline is scoped and ascending',async t=>{
  const f=await fixture(t);await insert(f.db,'a');await insert(f.db,'b');
  const a=await repository.appendAudit('a','time-1','actor-1','CREATE','detail-1',f.db);
  const b=await repository.appendAudit('b','time-2','actor-2','OTHER','detail-2',f.db);
  const c=await repository.appendAudit('a','time-3','actor-3','COMMENTAIRE','detail-3',f.db);
  assert.deepEqual(a,{rowCount:1,id:1});assert.deepEqual(b,{rowCount:1,id:2});assert.deepEqual(c,{rowCount:1,id:3});
  assert.deepEqual(await repository.timeline('a',f.db),[
    {id:1,alert_id:'a',created_at:'time-1',actor:'actor-1',action:'CREATE',detail:'detail-1'},
    {id:3,alert_id:'a',created_at:'time-3',actor:'actor-3',action:'COMMENTAIRE',detail:'detail-3'},
  ]);
  assert.deepEqual(await repository.timeline('absent',f.db),[]);
});
test('PG31: appendConfigAudit identity, exact fields, raw text and descending order',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await repository.appendConfigAudit('old','actor','before','after',f.db),{rowCount:1,id:1});
  await repository.appendConfigAudit('new','actor2','after','last',f.db);
  assert.deepEqual(await repository.configAudit(f.db),[
    {id:2,created_at:'new',actor:'actor2',previous:'after',current:'last'},
    {id:1,created_at:'old',actor:'actor',previous:'before',current:'after'},
  ]);
});
for(const creator of [7,8,999]){
  test('PG31: notification recipients admin OR creator, creator='+creator,async t=>{
    const f=await fixture(t);await user(f.db,7,'admin');await user(f.db,8);await user(f.db,9,'admin');await user(f.db,10,'soc');
    assert.deepEqual(ids(await repository.notificationRecipients(creator,f.db)).sort((a,b)=>a-b),creator===8?[7,8,9]:[7,9]);
  });
}
test('PG31: notification factory performs no I/O and captures exact client until awaited',async t=>{
  const f=await fixture(t);await insert(f.db,'a');let calls=0;
  const cx={query:async(...args)=>{calls++;return f.db.query(...args);},get:(...args)=>f.db.get(...args),all:(...args)=>f.db.all(...args)};
  const notify=repository.prepareNotificationInsert(cx);assert.equal(calls,0);
  assert.deepEqual(await notify('a',77,'notification stamp','message'),{rowCount:1,id:1});
  assert.equal(calls,1);
  assert.deepEqual(await repository.findNotification(1,77,f.db),{id:1,alert_id:'a',user_id:77,created_at:'notification stamp',message:'message',read_at:null});
});
test('PG31: notifications limit 200, descending identity order, user filter, absent empty',async t=>{
  const f=await fixture(t);await insert(f.db,'a');
  await f.db.transaction(async client=>{
    const notify=repository.prepareNotificationInsert(client);
    for(let i=1;i<=205;i++)await notify('a',77,'stamp','n'+i);
    await notify('a',88,'stamp','other');
  });
  const rows=await repository.notifications(77,f.db);
  assert.equal(rows.length,200);assert.deepEqual(ids(rows),Array.from({length:200},(_,i)=>205-i));
  assert.deepEqual(await repository.notifications(999,f.db),[]);
});
test('PG31: findNotification id/user scope; read overwrite remains allowed; missing rowCount=0',async t=>{
  const f=await fixture(t);await insert(f.db,'a');
  const {id}=await repository.prepareNotificationInsert(f.db)('a',77,'stamp','message');
  assert.equal(await repository.findNotification(id,88,f.db),null);
  assert.equal(await repository.findNotification(999,77,f.db),null);
  assert.deepEqual(await repository.markNotificationRead('first',id,f.db),{rowCount:1});
  assert.deepEqual(await repository.markNotificationRead('second',id,f.db),{rowCount:1});
  assert.equal((await repository.findNotification(id,77,f.db)).read_at,'second');
  assert.deepEqual(await repository.markNotificationRead('stamp',999,f.db),{rowCount:0});
});
test('PG31: allAlerts and alertsByCreator retain level/date order and include terminal states',async t=>{
  const f=await fixture(t);
  await insert(f.db,'low',{level:1,createdAt:'2026-09-10',createdBy:77});
  await insert(f.db,'older',{level:4,createdAt:'2026-09-08',createdBy:77});
  await insert(f.db,'other',{level:4,createdAt:'2026-09-09',createdBy:88});
  await insert(f.db,'terminal',{level:4,createdAt:'2026-09-10',createdBy:77,status:'CLOTUREE'});
  assert.deepEqual(ids(await repository.allAlerts(f.db)),['terminal','other','older','low']);
  assert.deepEqual(ids(await repository.alertsByCreator(77,f.db)),['terminal','older','low']);
  assert.deepEqual(await repository.alertsByCreator(999,f.db),[]);
});
test('PG31: empty lists preserve []',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await repository.allAlerts(f.db),[]);
  assert.deepEqual(await repository.pendingEscalations(f.db),[]);
  assert.deepEqual(await repository.configAudit(f.db),[]);
  assert.deepEqual(await repository.notificationRecipients(999,f.db),[]);
});
test('PG31: pendingEscalations exact level/status/NULL acknowledgement without added filters',async t=>{
  const f=await fixture(t);
  await insert(f.db,'n3',{level:3});await insert(f.db,'n4',{level:4});await insert(f.db,'n2',{level:2});
  await insert(f.db,'terminal',{level:4,status:'RESOLUE'});
  await insert(f.db,'acked',{level:4});await insert(f.db,'empty-ack',{level:4});
  await f.db.query("UPDATE public.security_alerts SET acknowledged_at='stamp' WHERE id='acked'");
  await f.db.query("UPDATE public.security_alerts SET acknowledged_at='' WHERE id='empty-ack'");
  await repository.requestCancellation('n3',f.db);
  assert.deepEqual(ids(await repository.pendingEscalations(f.db)).sort(),['n3','n4']);
});
test('PG31: updateEscalation changes only step/date, and missing target reports zero',async t=>{
  const f=await fixture(t);await insert(f.db,'a');const before=await repository.findAlert('a',f.db);
  assert.deepEqual(await repository.updateEscalation(2,'escalated','a',f.db),{rowCount:1});
  assert.deepEqual(await repository.findAlert('a',f.db),{...before,escalation_step:2,updated_at:'escalated'});
  assert.deepEqual(await repository.updateEscalation(2,'stamp','absent',f.db),{rowCount:0});
});
test('PG31: requestCancellation is INTEGER 1; touch preserves all other values',async t=>{
  const f=await fixture(t);await insert(f.db,'a');const before=await repository.findAlert('a',f.db);
  assert.deepEqual(await repository.requestCancellation('a',f.db),{rowCount:1});
  assert.deepEqual(await repository.touchAlert('touched','a',f.db),{rowCount:1});
  assert.deepEqual(await repository.findAlert('a',f.db),{...before,cancellation_requested:1,updated_at:'touched'});
  assert.deepEqual(await repository.requestCancellation('absent',f.db),{rowCount:0});
  assert.deepEqual(await repository.touchAlert('stamp','absent',f.db),{rowCount:0});
});
test('PG31: updateState six parameters and COALESCE preserve existing values',async t=>{
  const f=await fixture(t);await insert(f.db,'a');
  assert.deepEqual(await repository.updateState('ACQUITTEE','updated-1','owner-1','ack-1',null,'a',f.db),{rowCount:1});
  await repository.updateState('RESOLUE','updated-2','owner-2','ack-2','resolved-2','a',f.db);
  await repository.updateState('CLOTUREE','updated-3','owner-3','ack-3','resolved-3','a',f.db);
  const row=await repository.findAlert('a',f.db);
  assert.equal(row.status,'CLOTUREE');assert.equal(row.updated_at,'updated-3');assert.equal(row.owner,'owner-1');assert.equal(row.acknowledged_at,'ack-1');assert.equal(row.resolved_at,'resolved-2');
  assert.deepEqual(await repository.updateState('X','stamp',null,null,null,'absent',f.db),{rowCount:0});
});
test('PG31: findUser exposes only id/username/role, absent is null',async t=>{
  const f=await fixture(t);await user(f.db,77);
  assert.deepEqual(await repository.findUser(77,f.db),{id:77,username:'user-77',role:'agent'});
  assert.equal(await repository.findUser(999,f.db),null);
});
test('PG31: badge count exact badge/refus/inclusive TEXT date conditions',async t=>{
  const f=await fixture(t);assert.equal(await repository.badgeRefusalCount('B',stamp,f.db),0);
  for(const [id,badge,result,date] of [['1','B','refus',stamp],['2','B','refus','2026-09-10'],['3','B','refus','2026-09-08'],['4','C','refus',stamp],['5','B','autorise',stamp],['6','B','refus',null]]){
    await f.db.query('INSERT INTO public.pietons(id,badge,resultat,datetime) VALUES($1,$2,$3,$4)',[id,badge,result,date]);
  }
  assert.equal(await repository.badgeRefusalCount('B',stamp,f.db),2);
});
for(const [value,expected] of [['0',0],['9007199254740991',Number.MAX_SAFE_INTEGER],['0002',2]]){
  test('PG31: COUNT safe string '+value,async()=>{
    assert.equal(await repository.badgeRefusalCount('B',stamp,{get:async()=>({n:value})}),expected);
  });
}
for(const value of ['9007199254740992','-1','1.5','NaN','Infinity','',null,undefined,12]){
  test('PG31: COUNT rejects unsafe or unexpected driver value '+String(value),async()=>{
    await assert.rejects(repository.badgeRefusalCount('B',stamp,{get:async()=>({n:value})}),e=>e.code==='ALERT_COUNT_RANGE');
  });
}
test('PG31: recentBadgeAlert inclusive time, equipment/origin only; no site or status filter',async t=>{
  const f=await fixture(t);
  assert.equal(await repository.recentBadgeAlert('badge:B',stamp,f.db),null);
  await insert(f.db,'old',{origin:'REGLE_BADGE',equipment:'badge:B',createdAt:'2026-09-08'});
  await insert(f.db,'other-origin',{origin:'INCIDENT',equipment:'badge:B'});
  await insert(f.db,'other-equipment',{origin:'REGLE_BADGE',equipment:'badge:C'});
  assert.equal(await repository.recentBadgeAlert('badge:B',stamp,f.db),null);
  await insert(f.db,'match',{origin:'REGLE_BADGE',equipment:'badge:B',site:'other-site',status:'CLOTUREE'});
  assert.deepEqual(await repository.recentBadgeAlert('badge:B',stamp,f.db),{id:'match'});
});

test('PG31: atomic top-level awaits async callback and commits its result',async()=>{
  const id='top-success';
  const value=await repository.atomic(async client=>{
    await insert(client,id);
    await Promise.resolve();
    await repository.appendAudit(id,stamp,'actor','CREATE','detail',client);
    return 'committed';
  });
  assert.equal(value,'committed');assert.equal((await repository.findAlert(id)).id,id);
  assert.equal((await repository.timeline(id)).length,1);
});
test('PG31: atomic top-level rollback preserves primary and removes alert/audit',async()=>{
  const error=new Error('primary');
  await assert.rejects(repository.atomic(async client=>{
    await insert(client,'top-rollback');await repository.appendAudit('top-rollback',stamp,'actor','CREATE','detail',client);throw error;
  }),e=>e===error);
  assert.equal(await repository.findAlert('top-rollback'),null);assert.deepEqual(await repository.timeline('top-rollback'),[]);
});
test('PG31: parent savepoint success uses same connection; outer rollback still undoes child',async t=>{
  const f=await fixture(t);const error=new Error('outer rollback');
  await assert.rejects(f.db.transaction(async client=>{
    const pid=(await client.get('SELECT pg_backend_pid() pid')).pid;
    assert.equal(await repository.atomic(async child=>{
      assert.equal(child,client);assert.equal((await child.get('SELECT pg_backend_pid() pid')).pid,pid);
      await insert(child,'child');return 42;
    },client),42);
    assert.equal((await repository.findAlert('child',client)).id,'child');throw error;
  }),e=>e===error);
  assert.equal(await repository.findAlert('child',f.db),null);
});
test('PG31: SQL error rolls back only child savepoint; parent can continue and commit',async t=>{
  const f=await fixture(t);
  await f.db.transaction(async client=>{
    await insert(client,'parent-before');
    await assert.rejects(repository.atomic(async child=>{
      await insert(child,'child');await insert(child,'child');
    },client),e=>e.code==='23505');
    assert.equal(await repository.findAlert('child',client),null);
    await insert(client,'parent-after');
  });
  assert.deepEqual(ids(await repository.allAlerts(f.db)).sort(),['parent-after','parent-before']);
});
test('PG31: nested savepoints have unique internal names and no transaction-parent COMMIT',async t=>{
  const f=await fixture(t);const commands=[];
  await f.db.transaction(async client=>{
    const cx={...client,query:async(sql,args)=>{commands.push(sql);return client.query(sql,args);}};
    await repository.atomic(child=>repository.atomic(inner=>insert(inner,'nested'),child),cx);
  });
  const saves=commands.filter(s=>s.startsWith('SAVEPOINT '));assert.equal(saves.length,2);assert.notEqual(saves[0],saves[1]);
  for(const s of saves)assert.match(s,/^SAVEPOINT alert_[0-9a-f]{32}$/);
  assert.ok(!commands.some(s=>/^(BEGIN|COMMIT|ROLLBACK$)/.test(s)));
});
test('PG31: no RELEASE before deferred callback resolves; late child error rolls back',async t=>{
  const f=await fixture(t),entered=deferred(),gate=deferred();let released=false;
  await f.db.transaction(async client=>{
    const cx={...client,query:async(sql,args)=>{if(sql.startsWith('RELEASE SAVEPOINT'))released=true;return client.query(sql,args);}};
    const error=new Error('late callback');
    const operation=repository.atomic(async child=>{await insert(child,'deferred');entered.resolve();await gate.promise;throw error;},cx);
    const rejected=assert.rejects(operation,e=>e===error);
    await entered.promise;assert.equal(released,false);gate.resolve();await rejected;assert.equal(released,true);
    assert.equal(await repository.findAlert('deferred',client),null);
  });
});
for(const mode of ['rollback','release','both','frozen']){
  test('PG31: primary callback error survives savepoint cleanup failure '+mode,async t=>{
    const f=await fixture(t);const primary=new Error('primary'),rollback=new Error('rollback failure'),release=new Error('release failure');
    if(mode==='frozen')Object.freeze(primary);
    let attemptedRollback=false,attemptedRelease=false;
    await assert.rejects(f.db.transaction(client=>{
      const cx={...client,query:async(sql,args)=>{
        if(sql.startsWith('ROLLBACK TO')){attemptedRollback=true;if(['rollback','both','frozen'].includes(mode))throw rollback;}
        if(sql.startsWith('RELEASE SAVEPOINT')){attemptedRelease=true;if(['release','both','frozen'].includes(mode))throw release;}
        return client.query(sql,args);
      }};
      return repository.atomic(async child=>{await insert(child,'cleanup');throw primary;},cx);
    }),e=>{
      assert.equal(mode==='frozen'?e.cause:e,primary);
      if(['rollback','both','frozen'].includes(mode))assert.equal(e.rollbackError,rollback);
      if(['release','both','frozen'].includes(mode))assert.equal(e.releaseError,release);
      return true;
    });
    assert.equal(attemptedRollback,true);assert.equal(attemptedRelease,true);assert.equal(await repository.findAlert('cleanup',f.db),null);
  });
}
test('PG31: successful callback followed by RELEASE failure cannot report success',async t=>{
  const f=await fixture(t),error=new Error('release failed');let attempted=0;
  await assert.rejects(f.db.transaction(client=>{
    const cx={...client,query:async(sql,args)=>{if(sql.startsWith('RELEASE SAVEPOINT')&&++attempted===1)throw error;return client.query(sql,args);}};
    return repository.atomic(child=>insert(child,'release-failure'),cx);
  }),e=>e===error);
  assert.equal(await repository.findAlert('release-failure',f.db),null);
});
test('PG31: expired transaction client and pool escapes are refused without fallback',async t=>{
  const f=await fixture(t);let escaped;
  await f.db.transaction(async client=>{
    escaped=client;
    await assert.rejects(repository.findAlert('x'),/client transactionnel/);
    await assert.rejects(repository.findAlert('x',f.db),/client transactionnel/);
    await assert.rejects(repository.atomic(async()=>null),/imbriquées/);
    await insert(client,'safe');
  });
  await assert.rejects(repository.findAlert('safe',escaped),/durée de vie/);
  await assert.rejects(repository.prepareNotificationInsert(escaped)('safe',77,stamp,'late'),/durée de vie/);
  assert.equal((await repository.findAlert('safe',f.db)).id,'safe');
});

test('PG31: every repository SQL operation uses supplied transaction client/PID',async t=>{
  const f=await fixture(t);await user(f.db,77);const seen=[];
  await f.db.transaction(async client=>{
    const pid=(await client.get('SELECT pg_backend_pid() pid')).pid;
    const cx={};
    for(const method of ['query','get','all'])cx[method]=async(...args)=>{
      seen.push((await client.get('SELECT pg_backend_pid() pid')).pid);
      return client[method](...args);
    };
    await repository.init(cx);await repository.readConfig(cx);await insert(cx,'all');
    await repository.findAlert('all',cx);await repository.findUser(77,cx);
    await repository.notificationRecipients(77,cx);
    await repository.appendAudit('all',stamp,'actor','CREATE','detail',cx);
    await repository.timeline('all',cx);
    await repository.appendConfigAudit(stamp,'actor','before','after',cx);await repository.configAudit(cx);
    await repository.updateConfig(initialConfig,cx);
    const n=await repository.prepareNotificationInsert(cx)('all',77,stamp,'message');
    await repository.notifications(77,cx);await repository.findNotification(n.id,77,cx);await repository.markNotificationRead(stamp,n.id,cx);
    await repository.allAlerts(cx);await repository.alertsByCreator(77,cx);await repository.pendingEscalations(cx);
    await repository.updateEscalation(1,stamp,'all',cx);await repository.requestCancellation('all',cx);
    await repository.updateState('ACQUITTEE',stamp,'owner',stamp,null,'all',cx);await repository.touchAlert(stamp,'all',cx);
    await repository.badgeRefusalCount('B',stamp,cx);await repository.recentBadgeAlert('B',stamp,cx);
    assert.ok(seen.length>=23);assert.ok(seen.every(n=>n===pid));
  });
});
test('PG31: audit INSERT error rolls back related alert mutation',async t=>{
  const f=await fixture(t);await insert(f.db,'a');
  await assert.rejects(f.db.transaction(client=>repository.atomic(async child=>{
    await repository.updateState('ACQUITTEE','changed','owner',stamp,null,'a',child);
    await repository.appendAudit('a',stamp,'actor','ACK',null,child);
  },client)),e=>e.code==='23502');
  assert.equal((await repository.findAlert('a',f.db)).status,'NOTIFIEE');
  assert.deepEqual(await repository.timeline('a',f.db),[]);
});
test('PG31: config audit and configuration rollback together',async t=>{
  const f=await fixture(t),error=new Error('after writes');
  await assert.rejects(f.db.transaction(client=>repository.atomic(async child=>{
    await repository.appendConfigAudit(stamp,'actor',await repository.readConfig(child),'changed',child);
    await repository.updateConfig('changed',child);throw error;
  },client)),e=>e===error);
  assert.equal(await repository.readConfig(f.db),initialConfig);assert.deepEqual(await repository.configAudit(f.db),[]);
});
test('PG31: notification and audit rollback together if audit insert fails',async t=>{
  const f=await fixture(t);await insert(f.db,'a');
  await assert.rejects(f.db.transaction(client=>repository.atomic(async child=>{
    await repository.prepareNotificationInsert(child)('a',77,stamp,'message');
    await repository.appendAudit('a',stamp,null,'NOTIFICATION_INTERNE','detail',child);
  },client)),e=>e.code==='23502');
  assert.deepEqual(await repository.notifications(77,f.db),[]);assert.deepEqual(await repository.timeline('a',f.db),[]);
});
test('PG31: repository audit operations issue INSERT only; PG23 protections remain authoritative',async t=>{
  const f=await fixture(t);await insert(f.db,'a');const queries=[];
  const cx={...f.db,query:async(sql,args)=>{queries.push(sql);return f.db.query(sql,args);}};
  await repository.appendAudit('a',stamp,'actor','CREATE','detail',cx);
  await repository.appendConfigAudit(stamp,'actor','before','after',cx);
  assert.equal(queries.length,2);assert.ok(queries.every(sql=>sql.startsWith('INSERT INTO public.alert_')&&!sql.includes('ON CONFLICT')));
  for(const table of ['alert_audit','alert_config_audit']){
    await assert.rejects(f.db.query('DELETE FROM public.'+table),e=>e.code==='23514'&&e.message==='Audit immuable');
    assert.equal((await f.db.get('SELECT count(*)::int n FROM public.'+table)).n,1);
  }
});
test('PG31: reopen database/repository readiness neither migrates nor reseeds',async t=>{
  const f=await fixture(t);await repository.updateConfig('custom',f.db);
  const ledger=await f.db.all('SELECT * FROM securisite_meta.schema_migrations ORDER BY version');
  await f.db.close();const reopened=db.createDatabase(f.env);
  try{
    await repository.init(reopened);assert.equal(await repository.readConfig(reopened),'custom');
    assert.deepEqual(await reopened.all('SELECT * FROM securisite_meta.schema_migrations ORDER BY version'),ledger);
    assert.deepEqual(await reopened.all("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('memberships')"),[]);
  }finally{await reopened.close();}
  originalSQL.forEach((bytes,i)=>assert.deepEqual(fs.readFileSync(path.join(directory,['001_core_legacy.sql','002_alert_core.sql'][i])),bytes));
});
test('PG31: independent top-level transactions keep distinct clients and results',async()=>{
  const entered=deferred(),gate=deferred();let pidA,pidB;
  const a=repository.atomic(async client=>{
    pidA=(await client.get('SELECT pg_backend_pid() pid')).pid;await insert(client,'concurrent-A');entered.resolve();await gate.promise;return 'A';
  });
  await entered.promise;
  try{
    const b=await repository.atomic(async client=>{
      pidB=(await client.get('SELECT pg_backend_pid() pid')).pid;
      assert.equal(await repository.findAlert('concurrent-A',client),null);
      await insert(client,'concurrent-B');return 'B';
    });
    assert.equal(b,'B');assert.notEqual(pidA,pidB);
  }finally{gate.resolve();}
  assert.equal(await a,'A');assert.ok(await repository.findAlert('concurrent-A'));assert.ok(await repository.findAlert('concurrent-B'));
});
