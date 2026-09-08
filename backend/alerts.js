const express = require('express');
const { randomUUID } = require('crypto');
const db = require('./database');
const router = express.Router();
const sql = () => db.raw;
const now = () => new Date().toISOString();
function atomic(fn) {
  const name = 'alert_' + randomUUID().replaceAll('-', '');
  sql().exec('SAVEPOINT ' + name);
  try { const result = fn(); sql().exec('RELEASE ' + name); return result; }
  catch (error) { sql().exec('ROLLBACK TO ' + name); sql().exec('RELEASE ' + name); throw error; }
}
const terminal = ['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE'];
const transitions = { NOTIFIEE: ['ACQUITTEE'], ACQUITTEE: ['EN_INTERVENTION'], EN_INTERVENTION: ['SOUS_CONTROLE'], SOUS_CONTROLE: ['RESOLUE'], RESOLUE: ['CLOTUREE'] };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 200) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
function init() {
  sql().exec(`
    CREATE TABLE IF NOT EXISTS security_alerts (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      site TEXT NOT NULL, zone TEXT NOT NULL, type TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),
      origin TEXT NOT NULL, created_by INTEGER NOT NULL, username TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT, acknowledged_at TEXT, resolved_at TEXT,
      comment TEXT NOT NULL DEFAULT '', latitude REAL, longitude REAL, equipment TEXT NOT NULL DEFAULT '',
      cancellation_requested INTEGER NOT NULL DEFAULT 0, escalation_step INTEGER NOT NULL DEFAULT 0,
      policy TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_audit (
      id INTEGER PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES security_alerts(id),
      created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS alert_audit_no_update BEFORE UPDATE ON alert_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TRIGGER IF NOT EXISTS alert_audit_no_delete BEFORE DELETE ON alert_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TABLE IF NOT EXISTS alert_notifications (
      id INTEGER PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES security_alerts(id), user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alert_config_audit (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, previous TEXT NOT NULL, current TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS alert_config_no_update BEFORE UPDATE ON alert_config_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TRIGGER IF NOT EXISTS alert_config_no_delete BEFORE DELETE ON alert_config_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TABLE IF NOT EXISTS alert_rules (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS alert_status_idx ON security_alerts(status, level, created_at);
    CREATE INDEX IF NOT EXISTS alert_notification_user_idx ON alert_notifications(user_id, id);
  `);
  sql().prepare('INSERT OR IGNORE INTO alert_rules VALUES (1,?)').run(JSON.stringify({ escalation: [30,60,120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 }));
}
function audit(id, actor, action, detail = '') {
  sql().prepare('INSERT INTO alert_audit(alert_id,created_at,actor,action,detail) VALUES(?,?,?,?,?)').run(id, now(), actor, action, detail);
}
function config() { return JSON.parse(sql().prepare('SELECT config FROM alert_rules WHERE id=1').get().config); }
function notify(alert, message) {
  const recipients = sql().prepare("SELECT id FROM users WHERE role='admin' OR id=?").all(alert.created_by);
  const insert = sql().prepare('INSERT INTO alert_notifications(alert_id,user_id,created_at,message) VALUES(?,?,?,?)');
  for (const user of recipients) insert.run(alert.id, user.id, now(), message);
  audit(alert.id, 'system', 'NOTIFICATION_INTERNE', `${recipients.length} destinataire(s) : ${message}`);
}
function get(id, user) {
  const a = sql().prepare('SELECT * FROM security_alerts WHERE id=?').get(id);
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
    sql().prepare(`INSERT INTO security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,latitude,longitude,equipment,policy)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,stamp,stamp,site,zone,type,input.level,origin,user.id,user.username,'NOTIFIEE',text(input.comment,4000),lat,lng,text(input.equipment),JSON.stringify(config().escalation));
    audit(id,user.username,'CREATION', `${type} — niveau ${input.level}`);
    const a = get(id,user); notify(a, `${type} — ${site}`); return a;
  });
}
function escalateDue(time = Date.now()) {
  const pending = sql().prepare("SELECT * FROM security_alerts WHERE level>=3 AND acknowledged_at IS NULL AND status='NOTIFIEE'").all();
  for (const a of pending) atomic(() => {
    const policy = JSON.parse(a.policy);
    for (let i=a.escalation_step;i<policy.length;i++) {
      if (time - Date.parse(a.created_at) < policy[i]*1000) break;
      sql().prepare('UPDATE security_alerts SET escalation_step=?,updated_at=? WHERE id=?').run(i+1,now(),a.id);
      audit(a.id,'system','ESCALADE',`Palier ${i+1} après ${policy[i]} s ; relais interne aux administrateurs`);
      notify(a,`Escalade ${i+1} — ${a.type} — ${a.site}`);
    }
  });
}
router.use((req,res,next) => {
  const user = sql().prepare('SELECT id, username, role FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(401).json({error:'Session révoquée'});
  req.user=user; next();
});
const admin = (req,res,next) => req.user.role === 'admin' ? next() : res.status(403).json({error:'Action réservée au SOC (administrateur)'});
router.get('/rules', admin, (req,res) => res.json(config()));
router.put('/rules', admin, (req,res) => {
  const c = req.body;
  if (!Array.isArray(c.escalation) || c.escalation.length!==3 || !c.escalation.every((v,i)=>Number.isInteger(v)&&v>0&&v<=86400&&(!i||v>c.escalation[i-1])) || typeof c.incidentCritical!=='boolean' || !Number.isInteger(c.badgeThreshold) || c.badgeThreshold<2 || c.badgeThreshold>100 || !Number.isInteger(c.badgeWindowSeconds) || c.badgeWindowSeconds<1 || c.badgeWindowSeconds>3600) fail('Règles invalides : trois délais croissants, seuil 2–100, fenêtre 1–3600 s');
  const clean = {escalation:c.escalation,incidentCritical:c.incidentCritical,badgeThreshold:c.badgeThreshold,badgeWindowSeconds:c.badgeWindowSeconds};
  atomic(() => {
    sql().prepare('INSERT INTO alert_config_audit(created_at,actor,previous,current) VALUES(?,?,?,?)').run(now(),req.user.username,JSON.stringify(config()),JSON.stringify(clean));
    sql().prepare('UPDATE alert_rules SET config=? WHERE id=1').run(JSON.stringify(clean));
  }); res.json(clean);
});
router.get('/rules/audit', admin, (req,res) => res.json(sql().prepare('SELECT * FROM alert_config_audit ORDER BY id DESC').all()));
router.get('/notifications', (req,res) => res.json(sql().prepare('SELECT * FROM alert_notifications WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id)));
router.post('/notifications/:id/read', (req,res) => {
  atomic(()=>{
    const n = sql().prepare('SELECT * FROM alert_notifications WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
    if (!n) fail('Notification introuvable',404);
    if (!n.read_at) { sql().prepare('UPDATE alert_notifications SET read_at=? WHERE id=?').run(now(),n.id); audit(n.alert_id,req.user.username,'LECTURE_NOTIFICATION'); }
  }); res.json({ok:true});
});
router.get('/', (req,res) => {
  const rows = req.user.role==='admin' ? sql().prepare('SELECT * FROM security_alerts ORDER BY level DESC, created_at DESC').all() : sql().prepare('SELECT * FROM security_alerts WHERE created_by=? ORDER BY level DESC,created_at DESC').all(req.user.id);
  res.json(rows);
});
router.post('/', (req,res) => res.status(201).json(create(req.body,req.user)));
router.get('/:id', (req,res) => {
  const a = get(req.params.id,req.user);
  res.json({...a, timeline:sql().prepare('SELECT * FROM alert_audit WHERE alert_id=? ORDER BY id').all(a.id)});
});
router.post('/:id/actions', (req,res) => {
  const result = atomic(()=>{
    let a = get(req.params.id,req.user); const action=req.body.action, comment=text(req.body.comment,4000);
    if (terminal.includes(a.status)) fail('Cette alerte est clôturée',409);
    if (action==='COMMENTAIRE') {
      if (!comment) fail('Commentaire requis'); audit(a.id,req.user.username,action,comment);
    } else if (action==='DEMANDE_ANNULATION') {
      if (a.created_by!==req.user.id) fail('Seul le déclarant peut demander une annulation',403);
      if (a.cancellation_requested) fail('Demande déjà enregistrée',409);
      sql().prepare('UPDATE security_alerts SET cancellation_requested=1 WHERE id=?').run(a.id);
      audit(a.id,req.user.username,action,comment); notify(a,'Demande d’annulation reçue');
    } else {
      if(req.user.role!=='admin') fail('Action réservée au SOC',403);
      if(action==='ESCALADE') { audit(a.id,req.user.username,action,comment); notify(a,'Escalade manuelle au SOC'); }
      else {
        if(action==='FAUSSE_ALERTE' || action==='ANNULEE') { if(!comment) fail('Motif obligatoire'); }
        else if(!(transitions[a.status]||[]).includes(action)) fail('Transition interdite',409);
        const stamp=now();
        sql().prepare('UPDATE security_alerts SET status=?,updated_at=?,owner=COALESCE(owner,?),acknowledged_at=COALESCE(acknowledged_at,?),resolved_at=COALESCE(resolved_at,?) WHERE id=?')
          .run(action,stamp,req.user.username,action==='ACQUITTEE'?stamp:null,action==='RESOLUE'?stamp:null,a.id);
        audit(a.id,req.user.username,action,comment); notify(a,`Alerte : ${action}`);
      }
    }
    sql().prepare('UPDATE security_alerts SET updated_at=? WHERE id=?').run(now(),a.id);
    return get(a.id,req.user);
  }); res.json(result);
});
router.use((req,res) => res.status(404).json({error:'Route Alert Core introuvable'}));
router.use((err,req,res,next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({error:err.message});
  next(err);
});
function fromIncident(i,user) {
  if(config().incidentCritical && ['critique','majeur'].includes(i.gravite)) create({site:i.lieu||'Site non renseigné',zone:i.lieu,type:i.type||'Incident grave',level:3,comment:`Incident ${i.ref} : ${i.description||''}`},user,'INCIDENT');
}
function fromBadge(p,user) {
  if(p.resultat!=='refus'||!p.badge) return;
  const c=config(), since=new Date(Date.now()-c.badgeWindowSeconds*1000).toISOString();
  const count=sql().prepare("SELECT COUNT(*) AS n FROM pietons WHERE badge=? AND resultat='refus' AND datetime>=?").get(p.badge,since).n;
  const equipment=`badge:${p.badge}`;
  if(count>=c.badgeThreshold && !sql().prepare("SELECT id FROM security_alerts WHERE equipment=? AND created_at>=? AND origin='REGLE_BADGE'").get(equipment,since)) create({site:p.point||'Accès non renseigné',type:'Badge refusé à répétition',level:3,equipment},user,'REGLE_BADGE');
}
module.exports = {router,init,create,escalateDue,fromIncident,fromBadge};
