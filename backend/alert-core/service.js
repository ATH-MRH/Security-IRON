const { randomUUID } = require('crypto');
const repository = require('./repository');
const recipients = require('./recipients');
const db = require('../database');
const scope = require('../scope');
const securityAudit = require('../security-audit');
const realtime = require('../realtime');
const { atomic } = repository;
// PCS01 (Lot E) : security_alerts est désormais protégée par RLS (migration
// 012) — une lecture au niveau top (aucun `client` explicite, donc encore
// `db`, le pool nu) doit poser l'acteur PostgreSQL (SET LOCAL, transaction
// dédiée) avant de toucher la table, exactement comme backend/map.js
// #listSites et backend/alert-core/recipients.js. Un `client` déjà fourni
// signifie que l'appelant (create()/act(), plus bas) a déjà posé cet
// acteur sur SA transaction — jamais un second contexte imbriqué, jamais
// un oubli non plus : la seule alternative à "déjà posé" est "pas encore
// posé du tout", jamais une troisième possibilité silencieuse.
async function withActor(user, client, fn) {
  if (client !== db) return fn(client);
  return scope.withActorContext(user.id, fn);
}
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
// PG-15 : 'SOS' est, comme 'COMMAND', une action humaine directe déclenchée
// depuis une requête HTTP en cours — jamais un déclenchement système différé.
const HTTP_ORIGINS = new Set(['COMMAND', 'SOS']);
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
// PG-16 : tenant_id (migration 009) vérifié inconditionnellement, même pour
// une alerte propre à l'appelant — jamais de fuite intertenant, même pour
// « own » (voir tests/postgres-soc.test.js).
// PCS01 (Lot C) : un destinataire explicite (alert_recipients, migration
// 011) voit CETTE alerte précise même sous own/scope='own' — jamais une
// ouverture plus large que l'alerte réellement ciblée ; le créateur et le
// SOC gardent exactement l'accès qu'ils avaient déjà (rien retiré).
async function get(id, user, client = db) {
  return withActor(user, client, async c => {
  const a = await repository.findAlert(id, c);
  if (!a || a.tenant_id !== user.tenantId) fail('Alerte introuvable', 404);
  if (user.alertAccess !== 'scope' && a.created_by !== user.id) {
    if (!(await recipients.isRecipient(id, user.id, c))) fail('Alerte introuvable', 404);
  }
  return a;
  });
}
async function create(input, user, origin = 'COMMAND', transactionClient = null) {
  const site = text(input.site), type = text(input.type), zone = text(input.zone);
  if (!site || !type || !Number.isInteger(input.level) || input.level < 1 || input.level > 4) fail('Site, type et niveau (1 à 4) requis');
  let lat = input.latitude ?? null, lng = input.longitude ?? null;
  if ((lat !== null || lng !== null) && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180)) fail('Coordonnées GPS invalides');
  const id = 'ALT-' + randomUUID(), stamp = now();
  if (!user.tenantId) fail('Périmètre non résolu', 403);
  // Bouton SOS réel (« panic button ») : rempli UNIQUEMENT pour origin='SOS'
  // par recipients.broadcastToSosDesignated() ci-dessous — la seule
  // information nouvelle dont realtime.js/realtime-routes.js a besoin pour
  // livrer aussi aux destinataires désignés "own" qui ne verraient sinon
  // jamais cet événement (même contrat que broadcastAlert() plus bas).
  let sosRecipientIds = [];
  const result = await atomic(async client => {
    // PCS01 (Lot E) : atomic() ouvre sa propre transaction, jamais encore
    // posée comme contexte d'acteur (contrairement à scope.withActorContext) —
    // security_alerts (RLS, migration 012) exige que ce soit fait ici, en
    // premier, avant le moindre accès à la table dans cette transaction.
    await repository.setActorContext(client, user.id);
    await repository.insertAlert(id,stamp,stamp,site,zone,type,input.level,origin,user.id,user.username,'NOTIFIEE',text(input.comment,4000),lat,lng,text(input.equipment),JSON.stringify((await config(client)).escalation),user.tenantId,client);
    await audit(id,user.username,'CREATION', `${type} — niveau ${input.level}`,client);
    const a = await get(id,user,client); await notify(a, `${type} — ${site}`,client);
    // Bouton SOS réel : chaque compte désigné (users.sos_recipient=true,
    // migration 021) reçoit une ligne alert_recipients dans CETTE MÊME
    // transaction — jamais un second appel séparé qui pourrait réussir
    // alors que la création elle-même échoue. Réservé à origin='SOS' :
    // une alerte COMMAND/INCIDENT/REGLE_BADGE garde le ciblage manuel
    // existant (broadcastAlert(), plus bas), jamais un envoi automatique.
    if (origin === 'SOS') {
      const sosResult = await recipients.broadcastToSosDesignated(a, user.id, client);
      sosRecipientIds = sosResult.recipientUserIds;
    }
    // PG-10 : même transaction que la mutation (règle 13) — un échec d'audit
    // annule aussi la création. origin='COMMAND'/'SOS' (action humaine directe)
    // est 'http' ; INCIDENT/REGLE_BADGE (déclenchement automatique par une
    // règle métier) sont 'system', pas 'http', même si la requête HTTP
    // d'origine (POST /incidents, /pietons) est elle-même auditée séparément
    // par routes.js.
    await securityAudit.record({
      ...auditContext(user), origin: HTTP_ORIGINS.has(origin) ? 'http' : 'system',
      eventType: 'alert.create', resourceType: 'alert', resourceId: id, action: 'create', outcome: 'success',
      detail: { alert_origin: origin, level: input.level },
    }, client);
    return a;
  }, transactionClient);
  // PG-12 : émis une fois atomic() résolu (savepoint relâché / transaction
  // validée), jamais avant — au prix d'un risque résiduel faible et assumé
  // (une transaction PARENTE peut encore annuler après coup un appel
  // fromIncident/fromBadge imbriqué : au pire un rafraîchissement client
  // inutile, jamais une fuite — aucun contenu n'est transmis, voir realtime.js).
  realtime.emit('alert:created', { id: result.id, tenantId: user.tenantId ?? null, createdBy: result.created_by, recipientUserIds: sosRecipientIds });
  return result;
}
// PG-15 : bouton de détresse. Zéro champ requis — sous contrainte réelle,
// aucune friction — niveau et type ne sont JAMAIS au choix de l'appelant
// (toujours 4 / 'SOS', jamais dégradés ni décidés par autre chose qu'un
// humain qui déclenche). Réutilise create() telle quelle : même transaction,
// même audit (règle 13), même émission temps réel/push (PG-12/13) — aucune
// IA n'intervient nulle part dans ce chemin, et ne doit jamais y être insérée
// (une future intégration IA, PG-19+, ne doit jamais devenir l'autorité
// d'une transition SOS — voir docs/sos.md).
async function sos(input, user, transactionClient = null) {
  const site = text(input?.site) || ('Position non précisée — ' + user.username);
  return create({
    site, zone: text(input?.zone), type: 'SOS', level: 4,
    comment: input?.comment, equipment: input?.equipment,
    latitude: input?.latitude ?? null, longitude: input?.longitude ?? null,
  }, user, 'SOS', transactionClient);
}
// PCS01 (Lot E) : job planifié (server.js), jamais une requête HTTP — aucun
// acteur humain à poser (voir l'en-tête de la migration 012). db.transaction
// ouvre sa PROPRE transaction ; set_config(...,true) (SET LOCAL) n'a de sens
// qu'à l'intérieur de celle-ci, jamais posé via le pool nu (db) hors
// transaction. Réservé exclusivement à escalateDue() ci-dessous — jamais
// accessible depuis une route HTTP.
async function withSystemJob(fn) {
  return db.transaction(async client => {
    await repository.setSystemJob(client);
    return fn(client);
  });
}
async function escalateDue(time = Date.now(), transactionClient = null) {
  // transactionClient fourni : uniquement des harnais de test (connexion
  // superutilisateur, RLS déjà sans effet) — le marqueur système n'y est
  // jamais nécessaire ; absent (invocation réelle, server.js) : chaque appel
  // ouvre ses propres transactions, chacune doit poser le marqueur elle-même.
  const pending = transactionClient
    ? await repository.pendingEscalations(transactionClient)
    : await withSystemJob(client => repository.pendingEscalations(client));
  // Parent transactions retain every row lock after RELEASE. Acquire their full
  // candidate set in stable order, then retain the historical processing order.
  if (transactionClient) {
    for (const id of [...new Set(pending.map(a => a.id))].sort()) {
      await repository.findAlertForUpdate(id, transactionClient);
    }
  }
  for (const candidate of pending) await atomic(async client => {
    // PCS01 (Lot E) : atomic(fn,null) (repository.js) ouvre une transaction
    // NEUVE par candidat quand transactionClient est absent — le marqueur
    // posé lors de la lecture initiale ci-dessus ne couvre pas celle-ci.
    if (!transactionClient) await repository.setSystemJob(client);
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
  // PCS01 (Lot E) : security_alerts (RLS, migration 012) — voir withActor
  // ci-dessus. Un `client` déjà fourni (aucun appelant actuel ne le fait
  // pour list(), gardé pour cohérence avec get()) signifie un contexte déjà posé.
  return withActor(user, client, async c => {
  if (user.alertAccess === 'scope') return repository.allAlerts(user.tenantId, c);
  // own : ses propres alertes + celles où il est destinataire explicite
  // (PCS01, Lot C) — jamais toutes les alertes du tenant, uniquement
  // celles-ci deux sources précises.
  // Deux appels successifs, jamais combinés en parallèle : PG32A
  // (tests/postgres-alert-core-service.test.js) interdit toute primitive
  // de concurrence nouvelle dans ce fichier — ce sont deux SELECT
  // indépendants sans aucun enjeu de verrouillage, un gain négligeable au
  // prix d'un écart architectural (verrous/concurrence restent l'affaire
  // de repository.js).
  const mine = await repository.alertsByCreator(user.id, user.tenantId, c);
  const targeted = await recipients.alertsForRecipient(user.id, user.tenantId, c);
  const byId = new Map(mine.map(a => [a.id, a]));
  for (const a of targeted) if (!byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.level - a.level || (a.created_at < b.created_at ? 1 : -1));
  });
}
// PCS01 (Lot E) : detail() délègue entièrement à get() (déjà posé sur
// security_alerts via withActor ci-dessus) puis lit alert_audit — table hors
// RLS (jamais dans RLS_POLICIES, backend/db/postgresql/readiness.js) — donc
// sans contexte d'acteur à poser ici pour ce second accès.
async function detail(id, user, client = db) {
  const a = await get(id,user,client);
  return {...a, timeline:await repository.timeline(a.id,client)};
}
async function act(id, input, user, transactionClient = null) {
  const result = await atomic(async client=>{
    // PCS01 (Lot E) : voir le commentaire équivalent dans create() ci-dessus.
    await repository.setActorContext(client, user.id);
    const a = await repository.findAlertForUpdate(id,client);
    if (!a || a.tenant_id !== user.tenantId) fail('Alerte introuvable',404);
    if (user.alertAccess !== 'scope' && a.created_by !== user.id) {
      if (!(await recipients.isRecipient(id, user.id, client))) fail('Alerte introuvable',404);
    }
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
  }, transactionClient);
  // PG-12 : même principe que create() — voir son commentaire ci-dessus.
  realtime.emit('alert:updated', { id: result.id, tenantId: user.tenantId ?? null, createdBy: result.created_by });
  return result;
}
// PCS01 (Lot C) : diffuser une alerte déjà créée vers des destinataires
// explicites. Réservé au SOC — même porte que toute action SOC dans act()
// ci-dessus ; `tenant_wide` n'a aujourd'hui aucune permission plus fine
// (voir recipients.js). L'alerte doit déjà être visible par l'opérateur
// (get() applique own/scope/recipient normalement) avant toute diffusion.
async function broadcastAlert(id, input, user, transactionClient = null) {
  if (!user.isSoc) fail('Action réservée au SOC', 403);
  const a = await get(id, user, transactionClient ?? db);
  const result = await recipients.broadcast(a, user, input, transactionClient);
  await securityAudit.record({
    ...auditContext(user), origin: 'http',
    eventType: 'alert.broadcast', resourceType: 'alert', resourceId: id, action: 'broadcast', outcome: 'success',
    detail: { recipient_type: input && input.recipientType, recipient_count: result.recipientCount },
  }, transactionClient ?? db);
  // Jamais le contenu de l'alerte — même contrat que alert:created/updated
  // (realtime.js). recipientUserIds : la SEULE information nouvelle dont
  // backend/realtime-routes.js a besoin pour livrer aussi aux destinataires
  // "own" qui ne verraient sinon jamais cet événement (own filtre sur
  // createdBy, jamais sur une cible de diffusion).
  realtime.emit('alert:broadcast', { id, tenantId: user.tenantId ?? null, recipientUserIds: result.recipientUserIds });
  return result;
}
// L'appelant doit être le destinataire lui-même (userId depuis le JWT du
// routeur, jamais depuis le corps de la requête — voir backend/alerts.js).
async function receiptAlert(id, userId, status, transactionClient = null) {
  return recipients.markReceipt(id, userId, status, transactionClient);
}
// PCS01 (Lot E) : get() ci-dessous pose déjà son propre contexte d'acteur
// (client=db) pour vérifier l'alerte — listReceipts() ne touche ensuite que
// alert_recipients/users, hors RLS (comme detail() ci-dessus), donc sans
// contexte à poser pour ce second accès.
async function alertReceipts(id, user, client = db) {
  if (!user.isSoc) fail('Action réservée au SOC', 403);
  await get(id, user, client); // 404 cohérent si l'alerte n'est pas dans le périmètre, avant de lister quoi que ce soit
  return recipients.listReceipts(id, client);
}
async function recipientCandidates(user) {
  if (!user.isSoc) fail('Action réservée au SOC', 403);
  return recipients.userCandidates(user.id, user.tenantId);
}
async function fromIncident(i,user,transactionClient = null) {
  if((await config(transactionClient ?? db)).incidentCritical && ['critique','majeur'].includes(i.gravite)) await create({site:i.lieu||'Site non renseigné',zone:i.lieu,type:i.type||'Incident grave',level:3,comment:`Incident ${i.ref} : ${i.description||''}`},user,'INCIDENT',transactionClient);
}
async function fromBadge(p,user,transactionClient = null) {
  if(p.resultat!=='refus'||!p.badge) return;
  await atomic(async client => {
  // PCS01 (Lot E) : recentBadgeAlert() ci-dessous lit security_alerts (RLS,
  // migration 012) directement dans CETTE transaction, avant tout appel à
  // create() (qui pose son propre contexte, voir plus haut) — doit donc
  // être posé ici aussi, en premier.
  await repository.setActorContext(client, user.id);
  await repository.lockBadge(p.badge,client);
  const c=await config(client), since=new Date(Date.now()-c.badgeWindowSeconds*1000).toISOString();
  const count=await repository.badgeRefusalCount(p.badge,since,client);
  const equipment=`badge:${p.badge}`;
  if(count>=c.badgeThreshold && !(await repository.recentBadgeAlert(equipment,since,client))) await create({site:p.point||'Accès non renseigné',type:'Badge refusé à répétition',level:3,equipment},user,'REGLE_BADGE',client);
  }, transactionClient);
}

module.exports = {
  init: repository.init, create, sos, escalateDue, fromIncident, fromBadge,
  currentUser: repository.findUser, config, updateRules,
  configAudit: repository.configAudit, notifications: repository.notifications,
  readNotification, list, detail, act,
  broadcastAlert, receiptAlert, alertReceipts, recipientCandidates,
};
