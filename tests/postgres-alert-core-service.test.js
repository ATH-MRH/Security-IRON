'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const {Client}=require('pg');
const db=require('../backend/database');
const repository=require('../backend/alert-core/repository');
const service=require('../backend/alert-core/service');
const {migrate}=require('../backend/db/postgresql/migrate');
const {testEnvironment}=require('./helpers/postgres-test-config');
const base=testEnvironment();
const directory=path.resolve(__dirname,'../backend/db/postgresql/migrations');
// PG-8: service.js reads user.alertAccess/isSoc (resolved server-side from
// memberships by the router / backend/scope.js), never user.role directly.
// Attached non-enumerably: readable by service.js like any property, but
// invisible to this file's `assert.deepEqual(currentUser(...), admin)`
// checks, which must keep matching the plain {id,username,role} DB row.
function withAccess(user,alertAccess,isSoc){
 Object.defineProperty(user,'alertAccess',{value:alertAccess,enumerable:false});
 Object.defineProperty(user,'isSoc',{value:isSoc,enumerable:false});
 return user;
}
const admin=withAccess({id:1,username:'admin-fixture',role:'admin'},'scope',true);
const agent=withAccess({id:2,username:'agent-fixture',role:'agent'},'own',false);
const other=withAccess({id:3,username:'other-fixture',role:'agent'},'own',false);
const rules={escalation:[30,60,120],incidentCritical:true,badgeThreshold:3,badgeWindowSeconds:120};
const input={site:'Oran',zone:'Quai B',type:'SOS',level:4,comment:'initial'};
const name=()=> 'securisite_test_pg32a_'+randomBytes(6).toString('hex');
const environment=n=>{const u=new URL(base.DATABASE_URL);u.pathname='/'+n;return {...base,DATABASE_URL:u.href,PGIDLE_TIMEOUT_MS:'1000'};};
let root,defaultName,defaultCreated=false;
async function install(env){await migrate({directory,migrationEnv:env});}
async function users(c){for(const u of [admin,agent,other])await c.query('INSERT INTO public.users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[u.id,u.username,'test-only',u.role]);}
before(async()=>{
  root=new Client(db.configuration(base));await root.connect();defaultName=name();
  await root.query('CREATE DATABASE "'+defaultName+'"');defaultCreated=true;
  const env=environment(defaultName);await install(env);Object.assign(process.env,env);await users(db);
});
after(async()=>{try{await db.close();if(defaultCreated)await root.query('DROP DATABASE "'+defaultName+'" WITH (FORCE)');}finally{if(root)await root.end();}});
async function fixture(t){
  const n=name();let pool,created=false;
  t.after(async()=>{try{if(pool)await pool.close();}finally{if(created)await root.query('DROP DATABASE "'+n+'" WITH (FORCE)');}});
  await root.query('CREATE DATABASE "'+n+'"');created=true;const env=environment(n);await install(env);pool=db.createDatabase(env);await users(pool);return pool;
}
const create=(f,u=agent,data=input)=>f.transaction(c=>service.create(data,u,'COMMAND',c));
const act=(f,a,action,u=admin,comment='')=>f.transaction(c=>service.act(a.id,{action,comment},u,c));
const checkError=(status,message)=>e=>{assert.equal(e.status,status);assert.equal(e.message,message);return true;};
function resolved(value){assert.ok(!value||typeof value.then!=='function','nested Promise');if(value&&typeof value==='object')for(const x of Object.values(value))resolved(x);}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function history(f,a){return service.detail(a.id,admin,f);}
const audits=(d,action)=>d.timeline.filter(x=>x.action===action);
async function counts(f){const result={};for(const table of ['security_alerts','alert_audit','alert_notifications','alert_config_audit'])result[table]=(await f.get('SELECT count(*)::int n FROM public.'+table)).n;return result;}
function faultClient(c,pattern){return {...c,query:async(sql,args)=>{
  if(pattern.test(sql))return c.query(sql,args.map((v,i)=>i===args.length-1?null:v));
  return c.query(sql,args);
}};}

test('PG32A config and aliases resolve their public shapes',async t=>{
 const f=await fixture(t);assert.equal(await service.init(f),undefined);assert.deepEqual(await service.config(f),rules);
 assert.deepEqual(await service.currentUser(1,f),admin);assert.equal(await service.currentUser(99,f),null);
 assert.deepEqual(await service.configAudit(f),[]);assert.deepEqual(await service.notifications(99,f),[]);
});
test('PG32A invalid JSON and missing config remain technical errors without fallback',async t=>{
 const f=await fixture(t);await repository.updateConfig('invalid',f);await assert.rejects(service.config(f),SyntaxError);
 await f.query('DELETE FROM public.alert_rules');await assert.rejects(service.config(f),e=>e.code==='ALERT_CONFIG_MISSING'&&e.status===undefined);
});
for(const bad of [{site:''},{type:''},{level:0},{level:5},{level:2.5},{level:'3'},{site:'x'.repeat(201)}])test('PG32A create validation '+JSON.stringify(bad),async()=>{
 let calls=0;const client={query:async()=>{calls++;throw Error('must not enter transaction');}};
 await assert.rejects(service.create({...input,...bad},agent,'COMMAND',client),checkError(400,'Site, type et niveau (1 à 4) requis'));assert.equal(calls,0);
});
for(const coords of [{latitude:91,longitude:0},{latitude:0,longitude:181},{latitude:0},{latitude:'0',longitude:0}])test('PG32A coordinate validation '+JSON.stringify(coords),async()=>{
 await assert.rejects(service.create({...input,...coords},agent),checkError(400,'Coordonnées GPS invalides'));
});
test('PG32A top-level create commits complete data, policy, audits and both recipients',async()=>{
 const a=await service.create(input,agent);resolved(a);assert.match(a.id,/^ALT-/);assert.equal(a.status,'NOTIFIEE');assert.equal(a.origin,'COMMAND');assert.equal(a.owner,null);assert.equal(a.latitude,null);assert.equal(a.longitude,null);assert.equal(a.comment,'initial');assert.equal(a.created_at,a.updated_at);assert.deepEqual(JSON.parse(a.policy),rules.escalation);
 const d=await service.detail(a.id,agent);resolved(d);assert.deepEqual(d.timeline.map(x=>x.action),['CREATION','NOTIFICATION_INTERNE']);
 assert.equal(d.timeline[0].detail,'SOS — niveau 4');assert.equal(d.timeline[0].actor,agent.username);assert.equal(d.timeline[1].detail,'2 destinataire(s) : SOS — Oran');assert.equal(d.timeline[1].actor,'system');
 for(const u of [admin,agent]){const n=await service.notifications(u.id);assert.equal(n.filter(n=>n.alert_id===a.id).length,1);assert.equal(n.find(n=>n.alert_id===a.id).message,'SOS — Oran');}
 assert.equal((await service.notifications(other.id)).length,0);
});
test('PG32A creator admin not duplicated; zero recipients still audited',async t=>{
 const f=await fixture(t);const a=await create(f,admin);assert.equal((await service.notifications(admin.id,f)).length,1);assert.match((await history(f,a)).timeline[1].detail,/^1 destinataire/);
 await f.query('DELETE FROM public.users');const orphan=await create(f,agent);assert.equal((await f.get('SELECT count(*)::int n FROM public.alert_notifications WHERE alert_id=$1',[orphan.id])).n,0);assert.match((await history(f,orphan)).timeline[1].detail,/^0 destinataire/);
});
test('PG32A text cleaning and GPS keep historical values',async t=>{
 const f=await fixture(t);const a=await create(f,agent,{...input,site:' Oran ',zone:42,comment:'x'.repeat(4001),equipment:99,latitude:90,longitude:-180});
 assert.equal(a.site,'Oran');assert.equal(a.zone,'');assert.equal(a.comment,'');assert.equal(a.equipment,'');assert.equal(a.latitude,90);assert.equal(a.longitude,-180);
});
test('PG32A create waits every notification and audit, with one client/PID and sequential calls',async t=>{
 const f=await fixture(t),entered=deferred(),gate=deferred();let settled=false,inFlight=0,max=0,notif=0;const trace=[],pids=[];
 const operation=f.transaction(async c=>{
  const cx={};for(const method of ['query','get','all'])cx[method]=async(sql,args)=>{
   inFlight++;max=Math.max(max,inFlight);
   try{pids.push((await c.get('SELECT pg_backend_pid() pid')).pid);trace.push(sql);
    if(sql.startsWith('INSERT INTO public.alert_notifications')&&++notif===2){entered.resolve();await gate.promise;}
    return await c[method](sql,args);
   }finally{inFlight--;}
  };
  return service.create(input,agent,'COMMAND',cx);
 });
 operation.then(()=>{settled=true;},()=>{settled=true;});
 await entered.promise;assert.equal(settled,false);assert.equal((await counts(f)).security_alerts,0);gate.resolve();const a=await operation;
 assert.equal(max,1);assert.equal(new Set(pids).size,1);assert.equal(notif,2);assert.ok(trace.at(-1).startsWith('RELEASE SAVEPOINT'));
 assert.equal((await history(f,a)).timeline.length,2);assert.equal((await counts(f)).alert_notifications,2);
});
for(const [label,pattern] of [['audit',/^INSERT INTO public.alert_audit/],['notification',/^INSERT INTO public.alert_notifications/]])test('PG32A create rollback after '+label+' error',async t=>{
 const f=await fixture(t);await assert.rejects(f.transaction(c=>service.create(input,agent,'COMMAND',faultClient(c,pattern))),e=>e.code==='23502');
 assert.deepEqual(await counts(f),{security_alerts:0,alert_audit:0,alert_notifications:0,alert_config_audit:0});
});
test('PG32A list visibility/order and resolved detail',async t=>{
 const f=await fixture(t);const a=await create(f,agent,{...input,level:1});const b=await create(f,other);const c=await create(f,agent,{...input,level:3});
 assert.deepEqual((await service.list(admin,f)).map(x=>x.id),[b.id,c.id,a.id]);assert.deepEqual((await service.list(agent,f)).map(x=>x.id),[c.id,a.id]);
 for(const id of [b.id,'absent'])await assert.rejects(service.detail(id,agent,f),checkError(404,'Alerte introuvable'));
 resolved(await service.detail(a.id,agent,f));
});
const invalidRules=[{escalation:[]},{escalation:[30,10,60]},{escalation:[0,60,120]},{escalation:[30,60,86401]},{escalation:[1.5,60,120]},{incidentCritical:1},{badgeThreshold:1},{badgeThreshold:101},{badgeWindowSeconds:0},{badgeWindowSeconds:3601}];
for(const change of invalidRules)test('PG32A rules validation '+JSON.stringify(change),async()=>{
 await assert.rejects(service.updateRules({...rules,...change},admin),checkError(400,'Règles invalides : trois délais croissants, seuil 2–100, fenêtre 1–3600 s'));
});
test('PG32A rules previous/current serialization, clean return and copied policy',async t=>{
 const f=await fixture(t);const a=await create(f);await repository.updateConfig(JSON.stringify(rules,null,2),f);
 const next={...rules,escalation:[40,80,160]};const clean=await f.transaction(c=>service.updateRules({...next,ignored:'x'},admin,c));assert.deepEqual(clean,next);resolved(clean);
 const audit=await service.configAudit(f);assert.equal(audit[0].previous,JSON.stringify(rules));assert.equal(audit[0].current,JSON.stringify(next));assert.equal(audit[0].actor,admin.username);
 assert.deepEqual(JSON.parse((await history(f,a)).policy),rules.escalation);assert.deepEqual(JSON.parse((await create(f)).policy),next.escalation);
});
test('PG32A rules rollback keeps config and audit together',async t=>{
 const f=await fixture(t);await assert.rejects(f.transaction(c=>service.updateRules({...rules,badgeThreshold:4},admin,faultClient(c,/^UPDATE public.alert_rules/))),e=>e.code==='23502');
 assert.deepEqual(await service.config(f),rules);assert.deepEqual(await service.configAudit(f),[]);
});
for(const initial of [null,''])test('PG32A notification first/second read, initial='+JSON.stringify(initial),async t=>{
 const f=await fixture(t),a=await create(f);const n=(await service.notifications(agent.id,f))[0];await f.query('UPDATE public.alert_notifications SET read_at=$1 WHERE id=$2',[initial,n.id]);
 await assert.rejects(f.transaction(c=>service.readNotification(n.id,other,c)),checkError(404,'Notification introuvable'));
 await assert.rejects(f.transaction(c=>service.readNotification(-1,agent,c)),checkError(404,'Notification introuvable'));
 assert.deepEqual(await f.transaction(c=>service.readNotification(n.id,agent,c)),{ok:true});const read=(await repository.findNotification(n.id,agent.id,f)).read_at;assert.ok(read);
 assert.deepEqual(await f.transaction(c=>service.readNotification(n.id,agent,c)),{ok:true});assert.equal((await repository.findNotification(n.id,agent.id,f)).read_at,read);
 const audit=audits(await history(f,a),'LECTURE_NOTIFICATION');assert.equal(audit.length,1);assert.equal(audit[0].detail,'');
});
test('PG32A read rollback restores unread when audit fails',async t=>{
 const f=await fixture(t),a=await create(f),n=(await service.notifications(agent.id,f))[0];
 await assert.rejects(f.transaction(c=>service.readNotification(n.id,agent,faultClient(c,/^INSERT INTO public.alert_audit/))),e=>e.code==='23502');
 assert.equal((await repository.findNotification(n.id,agent.id,f)).read_at,null);assert.equal(audits(await history(f,a),'LECTURE_NOTIFICATION').length,0);
});
test('PG32A full lifecycle preserves owner, dates and final returned state',async t=>{
 const f=await fixture(t),a=await create(f);let ack,res;
 for(const action of ['ACQUITTEE','EN_INTERVENTION','SOUS_CONTROLE','RESOLUE','CLOTUREE']){
  const row=await act(f,a,action);resolved(row);assert.equal(row.status,action);assert.equal(row.owner,admin.username);assert.equal(row.comment,'initial');assert.ok(row.updated_at);ack??=row.acknowledged_at;assert.equal(row.acknowledged_at,ack);if(action==='RESOLUE')res=row.resolved_at;if(action==='CLOTUREE')assert.equal(row.resolved_at,res);
  assert.equal(audits(await history(f,a),action).length,1);
 }
 assert.equal((await service.notifications(agent.id,f)).length,6);
});
test('PG32A comment touches without notification or replacing original comment',async t=>{
 const f=await fixture(t),a=await create(f);await f.query("UPDATE public.security_alerts SET updated_at='old' WHERE id=$1",[a.id]);
 const row=await act(f,a,'COMMENTAIRE',agent,' note ');assert.equal(row.status,'NOTIFIEE');assert.equal(row.comment,'initial');assert.notEqual(row.updated_at,'old');assert.equal((await service.notifications(agent.id,f)).length,1);assert.equal(audits(await history(f,a),'COMMENTAIRE')[0].detail,'note');
});
test('PG32A cancellation creator only, duplicate rejected; flag does not change status',async t=>{
 const f=await fixture(t),a=await create(f);
 await assert.rejects(act(f,a,'DEMANDE_ANNULATION',admin),checkError(403,'Seul le déclarant peut demander une annulation'));
 const row=await act(f,a,'DEMANDE_ANNULATION',agent);assert.equal(row.cancellation_requested,1);assert.equal(row.status,'NOTIFIEE');
 await assert.rejects(act(f,a,'DEMANDE_ANNULATION',agent),checkError(409,'Demande déjà enregistrée'));
 assert.equal(audits(await history(f,a),'DEMANDE_ANNULATION').length,1);assert.equal((await service.notifications(agent.id,f))[0].message,'Demande d’annulation reçue');
});
test('PG32A manual escalation does not change status or automatic step',async t=>{
 const f=await fixture(t),a=await create(f);const row=await act(f,a,'ESCALADE',admin,'manual');assert.equal(row.status,'NOTIFIEE');assert.equal(row.escalation_step,0);assert.equal(audits(await history(f,a),'ESCALADE')[0].detail,'manual');assert.equal((await service.notifications(agent.id,f))[0].message,'Escalade manuelle au SOC');
});
for(const action of ['FAUSSE_ALERTE','ANNULEE'])test('PG32A special outcome '+action,async t=>{
 const f=await fixture(t),a=await create(f);await assert.rejects(act(f,a,action),checkError(400,'Motif obligatoire'));
 const row=await act(f,a,action,admin,'reason');assert.equal(row.status,action);assert.equal(row.cancellation_requested,0);assert.equal(audits(await history(f,a),action)[0].detail,'reason');
});
for(const action of ['ACQUITTEE','EN_INTERVENTION','SOUS_CONTROLE','RESOLUE','CLOTUREE','FAUSSE_ALERTE','ANNULEE','ESCALADE','UNKNOWN'])test('PG32A administrative permission before transition '+action,async t=>{
 const f=await fixture(t),a=await create(f);await assert.rejects(act(f,a,action,agent),checkError(403,'Action réservée au SOC'));
});
for(const state of ['CLOTUREE','FAUSSE_ALERTE','ANNULEE'])test('PG32A terminal precedence '+state,async t=>{
 const f=await fixture(t),a=await create(f);await f.query('UPDATE public.security_alerts SET status=$1 WHERE id=$2',[state,a.id]);
 await assert.rejects(act(f,a,'UNKNOWN',agent),checkError(409,'Cette alerte est clôturée'));
 await assert.rejects(act(f,a,'COMMENTAIRE',agent),checkError(409,'Cette alerte est clôturée'));
});
test('PG32A missing/invisible, comment and transition errors keep exact messages',async t=>{
 const f=await fixture(t),a=await create(f);
 await assert.rejects(act(f,a,'COMMENTAIRE',other,'x'),checkError(404,'Alerte introuvable'));
 await assert.rejects(act(f,{id:'missing'},'UNKNOWN'),checkError(404,'Alerte introuvable'));
 await assert.rejects(act(f,a,'COMMENTAIRE',agent,' '),checkError(400,'Commentaire requis'));
 for(const action of ['UNKNOWN','RESOLUE','CLOTUREE','NOUVELLE'])await assert.rejects(act(f,a,action),checkError(409,'Transition interdite'));
 await act(f,a,'ACQUITTEE');await assert.rejects(act(f,a,'ACQUITTEE'),checkError(409,'Transition interdite'));
});
test('PG32A action audit failure rolls back mutation, timestamps and notifications',async t=>{
 const f=await fixture(t),a=await create(f),before=await history(f,a),n=await counts(f);
 await assert.rejects(f.transaction(c=>service.act(a.id,{action:'ACQUITTEE'},admin,faultClient(c,/^INSERT INTO public.alert_audit/))),e=>e.code==='23502');
 assert.deepEqual(await history(f,a),before);assert.deepEqual(await counts(f),n);
});
test('PG32A no candidates resolves undefined',async t=>{const f=await fixture(t);assert.equal(await f.transaction(c=>service.escalateDue(Date.now(),c)),undefined);});
test('PG32A escalation boundaries, catch-up, exact audit and notifications',async t=>{
 const f=await fixture(t),a=await create(f),time=Date.parse(a.created_at);
 for(const [seconds,step] of [[29,0],[30,1],[59,1],[60,2],[120,3],[130,3]]){
  assert.equal(await f.transaction(c=>service.escalateDue(time+seconds*1000,c)),undefined);assert.equal((await history(f,a)).escalation_step,step);
 }
 const d=await history(f,a);assert.deepEqual(audits(d,'ESCALADE').map(x=>x.detail),[30,60,120].map((s,i)=>`Palier ${i+1} après ${s} s ; relais interne aux administrateurs`));
 assert.equal(audits(d,'NOTIFICATION_INTERNE').length,4);assert.equal((await service.notifications(agent.id,f)).length,4);
 const b=await create(f);await act(f,b,'ACQUITTEE');await f.transaction(c=>service.escalateDue(Date.parse(b.created_at)+999000,c));assert.equal((await history(f,b)).escalation_step,0);
});
test('PG32A escalation candidates and savepoints remain sequential while callbacks wait',async t=>{
 const f=await fixture(t);await create(f);await create(f);const entered=deferred(),gate=deferred();let savepoints=0,releases=0,settled=false;
 const op=f.transaction(c=>service.escalateDue(Date.now()+200000,{...c,query:async(sql,args)=>{
  if(sql.startsWith('SAVEPOINT'))savepoints++;if(sql.startsWith('RELEASE'))releases++;
  if(sql.startsWith('UPDATE public.security_alerts SET escalation_step')&&args[0]===1&&savepoints===1){entered.resolve();await gate.promise;}
  return c.query(sql,args);
 }}));op.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;assert.equal(savepoints,1);assert.equal(releases,0);assert.equal(settled,false);gate.resolve();await op;assert.equal(savepoints,2);assert.equal(releases,2);
 for(const a of await service.list(admin,f)){assert.equal(a.escalation_step,3);assert.equal(audits(await history(f,a),'ESCALADE').length,3);}
});
for(const severity of ['critique','majeur'])test('PG32A incident producer '+severity+' keeps undefined return and fields',async t=>{
 const f=await fixture(t);assert.equal(await f.transaction(c=>service.fromIncident({gravite:severity,ref:'INC-1',lieu:'Gate',type:'Intrusion',description:'Door'},agent,c)),undefined);
 const a=(await service.list(agent,f))[0];assert.equal(a.origin,'INCIDENT');assert.equal(a.level,3);assert.equal(a.site,'Gate');assert.equal(a.zone,'Gate');assert.equal(a.comment,'Incident INC-1 : Door');assert.equal((await history(f,a)).timeline.length,2);
});
test('PG32A incident disabled/noncritical and fallback fields',async t=>{
 const f=await fixture(t);for(const gravite of ['mineur','CRITIQUE',undefined])assert.equal(await f.transaction(c=>service.fromIncident({gravite},agent,c)),undefined);
 await repository.updateConfig(JSON.stringify({...rules,incidentCritical:false}),f);await f.transaction(c=>service.fromIncident({gravite:'critique'},agent,c));assert.deepEqual(await service.list(admin,f),[]);
 await repository.updateConfig(JSON.stringify(rules),f);await f.transaction(c=>service.fromIncident({gravite:'critique',ref:'X'},agent,c));const a=(await service.list(admin,f))[0];assert.equal(a.type,'Incident grave');assert.equal(a.site,'Site non renseigné');assert.equal(a.zone,'');assert.equal(a.comment,'Incident X :');
});
test('PG32A parent rollback removes source incident, alert, audit and notification',async t=>{
 const f=await fixture(t),error=new Error('parent rollback');
 await assert.rejects(f.transaction(async c=>{
  await c.query("INSERT INTO public.incidents(id,ref,gravite) VALUES('source','INC-P','critique')");
  await service.fromIncident({gravite:'critique',ref:'INC-P'},agent,c);assert.equal((await service.list(admin,c)).length,1);throw error;
 }),e=>e===error);assert.equal((await f.all('SELECT * FROM public.incidents')).length,0);assert.equal((await counts(f)).security_alerts,0);assert.equal((await counts(f)).alert_audit,0);assert.equal((await counts(f)).alert_notifications,0);
});
async function refusal(c,id,badge='B',datetime=new Date().toISOString(),resultat='refus'){
 await c.query('INSERT INTO public.pietons(id,badge,datetime,resultat) VALUES($1,$2,$3,$4)',[id,badge,datetime,resultat]);
 return {id,badge,datetime,resultat,point:'Gate'};
}
test('PG32A badge early guards perform no config read',async()=>{
 const c={get:async()=>{throw Error('unexpected read');}};assert.equal(await service.fromBadge({resultat:'autorise',badge:'B'},agent,c),undefined);assert.equal(await service.fromBadge({resultat:'refus',badge:''},agent,c),undefined);
});
test('PG32A badge threshold, historical dedup including terminal alert and exact boundary',async t=>{
 const f=await fixture(t),fixed=Date.now(),original=Date.now;Date.now=()=>fixed;
 try{
  await f.transaction(async c=>{
   const since=new Date(fixed-120000).toISOString();await refusal(c,'old','B',new Date(fixed-120001).toISOString());
   let p=await refusal(c,'one','B',since);await service.fromBadge(p,agent,c);assert.deepEqual(await service.list(admin,c),[]);
   p=await refusal(c,'two');await service.fromBadge(p,agent,c);assert.deepEqual(await service.list(admin,c),[]);
   p=await refusal(c,'three');assert.equal(await service.fromBadge(p,agent,c),undefined);
   const a=(await service.list(admin,c))[0];assert.equal(a.type,'Badge refusé à répétition');assert.equal(a.origin,'REGLE_BADGE');assert.equal(a.equipment,'badge:B');assert.equal(a.level,3);assert.equal(a.site,'Gate');
   await service.act(a.id,{action:'ANNULEE',comment:'reason'},admin,c);
   await service.fromBadge(await refusal(c,'four'),agent,c);assert.equal((await service.list(admin,c)).length,1);
  });
 }finally{Date.now=original;}
});
test('PG32A badge parent rollback removes source and complete alert effects',async t=>{
 const f=await fixture(t),error=new Error('rollback badge');await assert.rejects(f.transaction(async c=>{
  for(let i=0;i<3;i++){const p=await refusal(c,'p'+i);await service.fromBadge(p,agent,c);}
  assert.equal((await service.list(admin,c)).length,1);throw error;
 }),e=>e===error);assert.deepEqual(await f.all('SELECT * FROM public.pietons'),[]);assert.deepEqual(await counts(f),{security_alerts:0,alert_audit:0,alert_notifications:0,alert_config_audit:0});
});
test('PG32A parent catches failed create savepoint and continues without pool fallback',async t=>{
 const f=await fixture(t);await f.transaction(async c=>{
  await assert.rejects(service.create(input,agent,'COMMAND',faultClient(c,/^INSERT INTO public.alert_notifications/)),e=>e.code==='23502');
  assert.equal((await service.list(admin,c)).length,0);const a=await service.create(input,agent,'COMMAND',c);assert.ok(a.id);
  await assert.rejects(service.list(admin),/client transactionnel/);await assert.rejects(service.config(),/client transactionnel/);
 });assert.equal((await service.list(admin,f)).length,1);
});
test('PG32A all explicit-client public operations and aliases resolve without nested Promises',async t=>{
 const f=await fixture(t);await f.transaction(async c=>{
  assert.equal(await service.init(c),undefined);resolved(await service.currentUser(1,c));resolved(await service.config(c));
  const a=await service.create(input,agent,'COMMAND',c);resolved(a);resolved(await service.list(agent,c));resolved(await service.detail(a.id,agent,c));resolved(await service.notifications(agent.id,c));
  resolved(await service.updateRules(rules,admin,c));resolved(await service.configAudit(c));
  const n=(await service.notifications(agent.id,c))[0];resolved(await service.readNotification(n.id,agent,c));resolved(await service.act(a.id,{action:'COMMENTAIRE',comment:'x'},agent,c));
 });
});
test('PG32A service adds no SQL, parallel savepoints or concurrency primitives',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../backend/alert-core/service.js'),'utf8');
 assert.doesNotMatch(source,/FOR UPDATE|pg_advisory|Promise\.all|forEach\s*\(|\.query\s*\(|\.run\s*\(|db\.raw/);
 assert.deepEqual(Object.keys(service).sort(),['init','create','escalateDue','fromIncident','fromBadge','currentUser','config','updateRules','configAudit','notifications','readNotification','list','detail','act'].sort());
});
test('PG32A producers without parent await their own complete creation',async()=>{
 assert.equal(await service.fromIncident({gravite:'majeur',ref:'STANDALONE'},agent),undefined);
 const incident=(await service.list(admin)).find(a=>a.origin==='INCIDENT'&&a.comment.includes('STANDALONE'));assert.ok(incident);assert.equal((await service.detail(incident.id,admin)).timeline.length,2);
 for(let i=0;i<3;i++){const p=await refusal(db,'standalone-'+i,'STANDALONE');assert.equal(await service.fromBadge(p,agent),undefined);}
 const badge=(await service.list(admin)).find(a=>a.equipment==='badge:STANDALONE');assert.ok(badge);assert.equal((await service.detail(badge.id,admin)).timeline.length,2);
});
test('PG32A rules return waits update completion and transaction release',async t=>{
 const f=await fixture(t),entered=deferred(),gate=deferred();let settled=false,released=false;
 const next={...rules,badgeThreshold:4};
 const operation=f.transaction(c=>service.updateRules(next,admin,{...c,query:async(sql,args)=>{
  if(sql.startsWith('UPDATE public.alert_rules')){entered.resolve();await gate.promise;}
  if(sql.startsWith('RELEASE'))released=true;
  return c.query(sql,args);
 }}));operation.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;assert.equal(settled,false);assert.equal(released,false);assert.deepEqual(await service.config(f),rules);gate.resolve();assert.deepEqual(await operation,next);assert.equal(released,true);assert.deepEqual(await service.config(f),next);
});
