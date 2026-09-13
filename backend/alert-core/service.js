const { randomUUID } = require('crypto');
const repository = require('./repository');
const db = require('../database');
const securityAudit = require('../security-audit');
const { atomic } = repository;
// PG-10 : le contexte d'audit (tenant/request/IP/UA) est posé sur `user` par
// le routeur (backend/alerts.js), jamais recalculé ici — mêmes conventions
// que user.alertAccess/isSoc (PG-8). Absent (appels directs de service.js
// dans les tests, ou déclencheurs internes fromIncident/fromBadge) : null,
// jamais une erreur — security_audit accepte un périmètre non résolu.
function auditContext(user) {
  return {
    requestId: user.requestId ?? null, actorUserId: user.id, actorUsername: user.username,
    actorRole: user.role ?? null, tenantId: user.tenantId ?? null,
    ipAddress: user.ipAddress ?? null, userAgent: user.userAgentHeader ?? null,
  };
}
const now = () => new Date().toISOString();
const terminal = ['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE'];
const transitions = { NOTIFIEE: ['ACQUITTEE'], ACQUITTEE: ['EN_INTERVENTION'], EN_INTERVENTION: ['SOUS_CONTROLE'], SOUS_CONTROLE: ['RESOLUE'], RESOLUE: ['CLOTUREE'] };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 200) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
async function audit(id, actor, action, detail = '', client = db) {
  await repository.appendAudit(id, now(), actor, action, detail, client);
}
async function config(client = db) { return JSON.parse(await repository.readConfig(client)); }
async function notify(alert, message, client = db) {
  const recipients = await repository.notificationRecipients(alert.created_by, client);
  const insert = repository.prepareNotificationInsert(client);
  for (const user of recipients) await insert(alert.id, user.id, now(), message);
  await audit(alert.id, 'system', 'NOTIFICATION_INTERNE', `${recipients.length} destinataire(s) : ${message}`, client);
}
// PG-8 : own/scope (résolu par backend/scope.js et posé sur `user` par le
// routeur, jamais recalculé ici) remplace le rôle brut. `user.alertAccess`
// doit valoir 'own' ou 'scope' ; toute autre valeur (absente, périmètre non
// résolu) referme l'accès au lieu de l'ouvrir.
async function get(id, user, client = db) {
  const a = await repository.findAlert(id, client);
  if (!a || (user.alertAccess !== 'scope' && a.created_by !== user.id)) fail('Alerte introuvable', 404);
  return a;
}
async function create(input, user, origin = 'COMMAND', transactionClient = null) {
  const site = text(input.site), type = text(input.type), zone = text(input.zone);
  if (!site || !type || !Number.isInteger(input.level) || input.level < 1 || input.level > 4) fail('Site, type et niveau (1 à 4) requis');
  let lat = input.latitude ?? null, lng = input.longitude ?? null;
  if ((lat !== null || lng !== null) && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180)) fail('Coordonnées GPS invalides');
  const id = 'ALT-' + randomUUID(), stamp = now();
  return atomic(async client => {
    await repository.insertAlert(id,stamp,stamp,site,zone,type,input.level,origin,user.id,user.username,'NOTIFIEE',text(input.comment,4000),lat,lng,text(input.equipment),JSON.stringify((await config(client)).escalation),client);
    await audit(id,user.username,'CREATION', `${type} — niveau ${input.level}`,client);
    const a = await get(id,user,client); await notify(a, `${type} — ${site}`,client);
    // PG-10 : même transaction que la mutation (règle 13) — un échec d'audit
    // annule aussi la création. origin='COMMAND' (action directe /alerts) est
    // 'http' ; INCIDENT/REGLE_BADGE (déclenchement automatique par une règle
    // métier) sont 'system', pas 'http', même si la requête HTTP d'origine
    // (POST /incidents, /pietons) est elle-même auditée séparément par routes.js.
    await securityAudit.record({
      ...auditContext(user), origin: origin === 'COMMAND' ? 'http' : 'system',
      eventType: 'alert.create', resourceType: 'alert', resourceId: id, action: 'create', outcome: 'success',
      detail: { alert_origin: origin, level: input.level },
    }, client);
    return a;
  }, transactionClient);
}
async function escalateDue(time = Date.now(), transactionClient = null) {
  const pending = await repository.pendingEscalations(transactionClient ?? db);
  // Parent transactions retain every row lock after RELEASE. Acquire their full
  // candidate set in stable order, then retain the historical processing order.
  if (transactionClient) {
    for (const id of [...new Set(pending.map(a => a.id))].sort()) {
      await repository.findAlertForUpdate(id, transactionClient);
    }
  }
  for (const candidate of pending) await atomic(async client => {
    const a = await repository.findAlertForUpdate(candidate.id, client);
    if (!a || a.level < 3 || a.acknowledged_at !== null || a.status !== 'NOTIFIEE') return;
    const policy = JSON.parse(a.policy);
    for (let i=a.escalation_step;i<policy.length;i++) {
      if (time - Date.parse(a.created_at) < policy[i]*1000) break;
      await repository.updateEscalation(i+1,now(),a.id,client);
      await audit(a.id,'system','ESCALADE',`Palier ${i+1} après ${policy[i]} s ; relais interne aux administrateurs`,client);
      await notify(a,`Escalade ${i+1} — ${a.type} — ${a.site}`,client);
    }
  }, transactionClient);
}
async function updateRules(c, user, transactionClient = null) {
  if (!Array.isArray(c.escalation) || c.escalation.length!==3 || !c.escalation.every((v,i)=>Number.isInteger(v)&&v>0&&v<=86400&&(!i||v>c.escalation[i-1])) || typeof c.incidentCritical!=='boolean' || !Number.isInteger(c.badgeThreshold) || c.badgeThreshold<2 || c.badgeThreshold>100 || !Number.isInteger(c.badgeWindowSeconds) || c.badgeWindowSeconds<1 || c.badgeWindowSeconds>3600) fail('Règles invalides : trois délais croissants, seuil 2–100, fenêtre 1–3600 s');
  const clean = {escalation:c.escalation,incidentCritical:c.incidentCritical,badgeThreshold:c.badgeThreshold,badgeWindowSeconds:c.badgeWindowSeconds};
  await atomic(async client => {
    const stamp = now();
    const previous = JSON.parse(await repository.readConfigForUpdate(client));
    await repository.appendConfigAudit(stamp,user.username,JSON.stringify(previous),JSON.stringify(clean),client);
    await repository.updateConfig(JSON.stringify(clean),client);
    await securityAudit.record({
      ...auditContext(user), origin: 'http',
      eventType: 'alert.rules.update', resourceType: 'alert_rules', resourceId: '1', action: 'update', outcome: 'success',
    }, client);
  }, transactionClient); return clean;
}
async function readNotification(id, user, transactionClient = null) {
  await atomic(async client=>{
    const n = await repository.findNotificationForUpdate(id,user.id,client);
    if (!n) fail('Notification introuvable',404);
    if (!n.read_at) { await repository.markNotificationRead(now(),n.id,client); await audit(n.alert_id,user.username,'LECTURE_NOTIFICATION','',client); }
  }, transactionClient); return {ok:true};
}
async function list(user, client = db) {
  const rows = user.alertAccess==='scope' ? await repository.allAlerts(client) : await repository.alertsByCreator(user.id,client);
  return rows;
}
async function detail(id, user, client = db) {
  const a = await get(id,user,client);
  return {...a, timeline:await repository.timeline(a.id,client)};
}
async function act(id, input, user, transactionClient = null) {
  const result = await atomic(async client=>{
    const a = await repository.findAlertForUpdate(id,client);
    if (!a || (user.alertAccess !== 'scope' && a.created_by !== user.id)) fail('Alerte introuvable',404);
    const action=input.action, comment=text(input.comment,4000);
    if (terminal.includes(a.status)) fail('Cette alerte est clôturée',409);
    if (action==='COMMENTAIRE') {
      if (!comment) fail('Commentaire requis'); await audit(a.id,user.username,action,comment,client);
    } else if (action==='DEMANDE_ANNULATION') {
      if (a.created_by!==user.id) fail('Seul le déclarant peut demander une annulation',403);
      if (a.cancellation_requested) fail('Demande déjà enregistrée',409);
      await repository.requestCancellation(a.id,client);
      await audit(a.id,user.username,action,comment,client); await notify(a,'Demande d’annulation reçue',client);
    } else {
      if(!user.isSoc) fail('Action réservée au SOC',403);
      if(action==='ESCALADE') { await audit(a.id,user.username,action,comment,client); await notify(a,'Escalade manuelle au SOC',client); }
      else {
        if(action==='FAUSSE_ALERTE' || action==='ANNULEE') { if(!comment) fail('Motif obligatoire'); }
        else if(!(transitions[a.status]||[]).includes(action)) fail('Transition interdite',409);
        const stamp=now();
        await repository.updateState(action,stamp,user.username,action==='ACQUITTEE'?stamp:null,action==='RESOLUE'?stamp:null,a.id,client);
        await audit(a.id,user.username,action,comment,client); await notify(a,`Alerte : ${action}`,client);
      }
    }
    await repository.touchAlert(now(),a.id,client);
    await securityAudit.record({
      ...auditContext(user), origin: 'http',
      eventType: 'alert.action', resourceType: 'alert', resourceId: id, action, outcome: 'success',
    }, client);
    return get(a.id,user,client);
  }, transactionClient); return result;
}
async function fromIncident(i,user,transactionClient = null) {
  if((await config(transactionClient ?? db)).incidentCritical && ['critique','majeur'].includes(i.gravite)) await create({site:i.lieu||'Site non renseigné',zone:i.lieu,type:i.type||'Incident grave',level:3,comment:`Incident ${i.ref} : ${i.description||''}`},user,'INCIDENT',transactionClient);
}
async function fromBadge(p,user,transactionClient = null) {
  if(p.resultat!=='refus'||!p.badge) return;
  await atomic(async client => {
  await repository.lockBadge(p.badge,client);
  const c=await config(client), since=new Date(Date.now()-c.badgeWindowSeconds*1000).toISOString();
  const count=await repository.badgeRefusalCount(p.badge,since,client);
  const equipment=`badge:${p.badge}`;
  if(count>=c.badgeThreshold && !(await repository.recentBadgeAlert(equipment,since,client))) await create({site:p.point||'Accès non renseigné',type:'Badge refusé à répétition',level:3,equipment},user,'REGLE_BADGE',client);
  }, transactionClient);
}

module.exports = {
  init: repository.init, create, escalateDue, fromIncident, fromBadge,
  currentUser: repository.findUser, config, updateRules,
  configAudit: repository.configAudit, notifications: repository.notifications,
  readNotification, list, detail, act
};
