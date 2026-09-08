const { randomUUID } = require('crypto');
const repository = require('./repository');
const { atomic } = repository;
const now = () => new Date().toISOString();
const terminal = ['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE'];
const transitions = { NOTIFIEE: ['ACQUITTEE'], ACQUITTEE: ['EN_INTERVENTION'], EN_INTERVENTION: ['SOUS_CONTROLE'], SOUS_CONTROLE: ['RESOLUE'], RESOLUE: ['CLOTUREE'] };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 200) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
function audit(id, actor, action, detail = '') {
  repository.appendAudit(id, now(), actor, action, detail);
}
function config() { return JSON.parse(repository.readConfig()); }
function notify(alert, message) {
  const recipients = repository.notificationRecipients(alert.created_by);
  const insert = repository.prepareNotificationInsert();
  for (const user of recipients) insert(alert.id, user.id, now(), message);
  audit(alert.id, 'system', 'NOTIFICATION_INTERNE', `${recipients.length} destinataire(s) : ${message}`);
}
function get(id, user) {
  const a = repository.findAlert(id);
  if (!a || (user.role !== 'admin' && a.created_by !== user.id)) fail('Alerte introuvable', 404);
  return a;
}
function create(input, user, origin = 'COMMAND') {
  const site = text(input.site), type = text(input.type), zone = text(input.zone);
  if (!site || !type || !Number.isInteger(input.level) || input.level < 1 || input.level > 4) fail('Site, type et niveau (1 à 4) requis');
  let lat = input.latitude ?? null, lng = input.longitude ?? null;
  if ((lat !== null || lng !== null) && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180)) fail('Coordonnées GPS invalides');
  const id = 'ALT-' + randomUUID(), stamp = now();
  return atomic(() => {
    repository.insertAlert(id,stamp,stamp,site,zone,type,input.level,origin,user.id,user.username,'NOTIFIEE',text(input.comment,4000),lat,lng,text(input.equipment),JSON.stringify(config().escalation));
    audit(id,user.username,'CREATION', `${type} — niveau ${input.level}`);
    const a = get(id,user); notify(a, `${type} — ${site}`); return a;
  });
}
function escalateDue(time = Date.now()) {
  const pending = repository.pendingEscalations();
  for (const a of pending) atomic(() => {
    const policy = JSON.parse(a.policy);
    for (let i=a.escalation_step;i<policy.length;i++) {
      if (time - Date.parse(a.created_at) < policy[i]*1000) break;
      repository.updateEscalation(i+1,now(),a.id);
      audit(a.id,'system','ESCALADE',`Palier ${i+1} après ${policy[i]} s ; relais interne aux administrateurs`);
      notify(a,`Escalade ${i+1} — ${a.type} — ${a.site}`);
    }
  });
}
function updateRules(c, user) {
  if (!Array.isArray(c.escalation) || c.escalation.length!==3 || !c.escalation.every((v,i)=>Number.isInteger(v)&&v>0&&v<=86400&&(!i||v>c.escalation[i-1])) || typeof c.incidentCritical!=='boolean' || !Number.isInteger(c.badgeThreshold) || c.badgeThreshold<2 || c.badgeThreshold>100 || !Number.isInteger(c.badgeWindowSeconds) || c.badgeWindowSeconds<1 || c.badgeWindowSeconds>3600) fail('Règles invalides : trois délais croissants, seuil 2–100, fenêtre 1–3600 s');
  const clean = {escalation:c.escalation,incidentCritical:c.incidentCritical,badgeThreshold:c.badgeThreshold,badgeWindowSeconds:c.badgeWindowSeconds};
  atomic(() => {
    repository.appendConfigAudit(now(),user.username,JSON.stringify(config()),JSON.stringify(clean));
    repository.updateConfig(JSON.stringify(clean));
  }); return clean;
}
function readNotification(id, user) {
  atomic(()=>{
    const n = repository.findNotification(id,user.id);
    if (!n) fail('Notification introuvable',404);
    if (!n.read_at) { repository.markNotificationRead(now(),n.id); audit(n.alert_id,user.username,'LECTURE_NOTIFICATION'); }
  }); return {ok:true};
}
function list(user) {
  const rows = user.role==='admin' ? repository.allAlerts() : repository.alertsByCreator(user.id);
  return rows;
}
function detail(id, user) {
  const a = get(id,user);
  return {...a, timeline:repository.timeline(a.id)};
}
function act(id, input, user) {
  const result = atomic(()=>{
    let a = get(id,user); const action=input.action, comment=text(input.comment,4000);
    if (terminal.includes(a.status)) fail('Cette alerte est clôturée',409);
    if (action==='COMMENTAIRE') {
      if (!comment) fail('Commentaire requis'); audit(a.id,user.username,action,comment);
    } else if (action==='DEMANDE_ANNULATION') {
      if (a.created_by!==user.id) fail('Seul le déclarant peut demander une annulation',403);
      if (a.cancellation_requested) fail('Demande déjà enregistrée',409);
      repository.requestCancellation(a.id);
      audit(a.id,user.username,action,comment); notify(a,'Demande d’annulation reçue');
    } else {
      if(user.role!=='admin') fail('Action réservée au SOC',403);
      if(action==='ESCALADE') { audit(a.id,user.username,action,comment); notify(a,'Escalade manuelle au SOC'); }
      else {
        if(action==='FAUSSE_ALERTE' || action==='ANNULEE') { if(!comment) fail('Motif obligatoire'); }
        else if(!(transitions[a.status]||[]).includes(action)) fail('Transition interdite',409);
        const stamp=now();
        repository.updateState(action,stamp,user.username,action==='ACQUITTEE'?stamp:null,action==='RESOLUE'?stamp:null,a.id);
        audit(a.id,user.username,action,comment); notify(a,`Alerte : ${action}`);
      }
    }
    repository.touchAlert(now(),a.id);
    return get(a.id,user);
  }); return result;
}
function fromIncident(i,user) {
  if(config().incidentCritical && ['critique','majeur'].includes(i.gravite)) create({site:i.lieu||'Site non renseigné',zone:i.lieu,type:i.type||'Incident grave',level:3,comment:`Incident ${i.ref} : ${i.description||''}`},user,'INCIDENT');
}
function fromBadge(p,user) {
  if(p.resultat!=='refus'||!p.badge) return;
  const c=config(), since=new Date(Date.now()-c.badgeWindowSeconds*1000).toISOString();
  const count=repository.badgeRefusalCount(p.badge,since);
  const equipment=`badge:${p.badge}`;
  if(count>=c.badgeThreshold && !repository.recentBadgeAlert(equipment,since)) create({site:p.point||'Accès non renseigné',type:'Badge refusé à répétition',level:3,equipment},user,'REGLE_BADGE');
}

module.exports = {
  init: repository.init, create, escalateDue, fromIncident, fromBadge,
  currentUser: repository.findUser, config, updateRules,
  configAudit: repository.configAudit, notifications: repository.notifications,
  readNotification, list, detail, act
};
