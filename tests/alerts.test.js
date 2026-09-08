const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'securisite-alert-test-'));
process.env.SECURISITE_DATA_DIR=dir;
const { start } = require('../server');
const db = require('../backend/database');
const alerts = require('../backend/alerts');
let server, base, admin, agent;
async function request(method,url,body,token=admin) {
  const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json()};
}
before(async()=>{
  const started=await start({port:0,host:'127.0.0.1'});server=started.server;base='http://127.0.0.1:'+started.port;
  admin=(await request('POST','/auth/login',{username:'admin',password:'securisite'},null)).body.token;
  agent=(await request('POST','/auth/login',{username:'agent',password:'agent'},null)).body.token;
});
after(async()=>{if(server) await new Promise(resolve=>server.close(resolve));db.raw.close();fs.rmSync(dir,{recursive:true,force:true});});
const newAlert = async (token=admin,level=4)=> (await request('POST','/alerts',{site:'Oran',zone:'Quai B',type:'SOS',level},token)).body;
test('authentication, validation and user visibility',async()=>{
  assert.equal((await request('GET','/alerts',null,null)).status,401);
  assert.equal((await request('POST','/alerts',{site:'Oran',type:'SOS',level:9})).status,400);
  assert.equal((await request('POST','/alerts',{site:'Oran',type:'SOS',level:4,latitude:99,longitude:0})).status,400);
  const a=await newAlert();
  assert.equal(a.status,'NOTIFIEE');assert.ok(a.created_at);
  assert.equal((await request('GET','/alerts/'+a.id,null,agent)).status,404);
  assert.ok(!(await request('GET','/alerts',null,agent)).body.some(x=>x.id===a.id));
});
test('critical workflow, competing acknowledgement and immutable history',async()=>{
  const a=await newAlert(agent);
  assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action:'ACQUITTEE'},agent)).status,403);
  assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action:'CLOTUREE'})).status,409);
  const attempts=await Promise.all([1,2].map(()=>request('POST',`/alerts/${a.id}/actions`,{action:'ACQUITTEE'})));
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  for(const action of ['EN_INTERVENTION','SOUS_CONTROLE','RESOLUE','CLOTUREE']) assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action})).status,200);
  const detail=(await request('GET','/alerts/'+a.id)).body;
  assert.ok(detail.acknowledged_at);assert.ok(detail.resolved_at);assert.equal(detail.owner,'admin');
  assert.equal(detail.timeline.filter(t=>t.action==='ACQUITTEE').length,1);
  assert.throws(()=>db.raw.prepare('DELETE FROM alert_audit WHERE alert_id=?').run(a.id),/Audit immuable/);
  assert.throws(()=>db.raw.prepare("UPDATE alert_audit SET actor='x' WHERE alert_id=?").run(a.id),/Audit immuable/);
  assert.equal((await request('DELETE','/alerts/'+a.id)).status,404);
});
test('cancellation request is retained until SOC decision',async()=>{
  const a=await newAlert(agent);
  assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action:'DEMANDE_ANNULATION'},agent)).status,200);
  assert.equal((await request('GET','/alerts/'+a.id)).body.status,'NOTIFIEE');
  assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action:'FAUSSE_ALERTE'},agent)).status,403);
  assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action:'FAUSSE_ALERTE'})).status,400);
  assert.equal((await request('POST',`/alerts/${a.id}/actions`,{action:'FAUSSE_ALERTE',comment:'Erreur confirmée par téléphone'})).status,200);
});
test('escalations recover overdue steps, do not duplicate, stop on acknowledgement',async()=>{
  const a=await newAlert();
  const t=Date.parse(a.created_at);
  alerts.escalateDue(t+31000);alerts.escalateDue(t+61000);alerts.escalateDue(t+121000);alerts.escalateDue(t+130000);
  let detail=(await request('GET','/alerts/'+a.id)).body;
  assert.equal(detail.escalation_step,3);assert.equal(detail.timeline.filter(t=>t.action==='ESCALADE').length,3);
  const b=await newAlert();await request('POST',`/alerts/${b.id}/actions`,{action:'ACQUITTEE'});
  alerts.escalateDue(Date.parse(b.created_at)+200000);
  assert.equal((await request('GET','/alerts/'+b.id)).body.escalation_step,0);
});
test('notification reads are scoped and audited once',async()=>{
  const a=await newAlert();
  const n=(await request('GET','/alerts/notifications')).body.find(x=>x.alert_id===a.id);
  assert.equal((await request('POST',`/alerts/notifications/${n.id}/read`,{},agent)).status,404);
  await request('POST',`/alerts/notifications/${n.id}/read`,{});await request('POST',`/alerts/notifications/${n.id}/read`,{});
  assert.equal((await request('GET','/alerts/'+a.id)).body.timeline.filter(t=>t.action==='LECTURE_NOTIFICATION').length,1);
});
test('config validates values and existing alerts retain their escalation policy',async()=>{
  const a=await newAlert();
  const c={escalation:[40,80,160],incidentCritical:true,badgeThreshold:3,badgeWindowSeconds:120};
  assert.equal((await request('PUT','/alerts/rules',c,agent)).status,403);
  assert.equal((await request('PUT','/alerts/rules',{...c,escalation:[30,10,60]})).status,400);
  assert.equal((await request('PUT','/alerts/rules',c)).status,200);
  assert.equal((await request('GET','/alerts/rules/audit')).body[0].actor,'admin');
  assert.deepEqual(JSON.parse((await request('GET','/alerts/'+a.id)).body.policy),[30,60,120]);
  assert.deepEqual(JSON.parse((await newAlert()).policy),[40,80,160]);
});
test('incident and repeated badge refusals feed the alert center',async()=>{
  const incident=await request('POST','/incidents',{type:'Intrusion',lieu:'Oran',gravite:'critique',description:'Porte forcée'},agent);
  assert.equal(incident.status,200);
  for(let i=0;i<4;i++)assert.equal((await request('POST','/pietons',{badge:'TEST-42',nom:'Test',point:'Porte B',sens:'entree',resultat:'refus'},agent)).status,200);
  const rows=(await request('GET','/alerts')).body;
  assert.ok(rows.some(a=>a.origin==='INCIDENT'&&a.comment.includes(incident.body.ref)));
  assert.equal(rows.filter(a=>a.origin==='REGLE_BADGE'&&a.equipment==='badge:TEST-42').length,1);
});
