const { randomUUID } = require('crypto');
const db = require('../database');
const sql = () => db.raw;

// Synchronous savepoints: callers may already be inside a métier transaction.
function atomic(fn) {
  const name = 'alert_' + randomUUID().replaceAll('-', '');
  sql().exec('SAVEPOINT ' + name);
  try { const result = fn(); sql().exec('RELEASE ' + name); return result; }
  catch (error) { sql().exec('ROLLBACK TO ' + name); sql().exec('RELEASE ' + name); throw error; }
}

// Compatibility entry point: schema creation belongs exclusively to database.init().
function init() {
  db.assertSchemaReady();
}

function appendAudit(id, stamp, actor, action, detail) {
  return sql().prepare('INSERT INTO alert_audit(alert_id,created_at,actor,action,detail) VALUES(?,?,?,?,?)').run(id, stamp, actor, action, detail);
}
function readConfig() {
  return sql().prepare('SELECT config FROM alert_rules WHERE id=1').get().config;
}
function notificationRecipients(createdBy) {
  return sql().prepare("SELECT id FROM users WHERE role='admin' OR id=?").all(createdBy);
}
function prepareNotificationInsert() {
  const insert = sql().prepare('INSERT INTO alert_notifications(alert_id,user_id,created_at,message) VALUES(?,?,?,?)');
  return (...params) => insert.run(...params);
}
function findAlert(id) {
  return sql().prepare('SELECT * FROM security_alerts WHERE id=?').get(id);
}
function insertAlert(...params) {
  return sql().prepare(`INSERT INTO security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,latitude,longitude,equipment,policy)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...params);
}
function pendingEscalations() {
  return sql().prepare("SELECT * FROM security_alerts WHERE level>=3 AND acknowledged_at IS NULL AND status='NOTIFIEE'").all();
}
function updateEscalation(step, stamp, id) {
  return sql().prepare('UPDATE security_alerts SET escalation_step=?,updated_at=? WHERE id=?').run(step,stamp,id);
}
function findUser(id) {
  return sql().prepare('SELECT id, username, role FROM users WHERE id=?').get(id);
}
function appendConfigAudit(stamp, actor, previous, current) {
  return sql().prepare('INSERT INTO alert_config_audit(created_at,actor,previous,current) VALUES(?,?,?,?)').run(stamp,actor,previous,current);
}
function updateConfig(config) {
  return sql().prepare('UPDATE alert_rules SET config=? WHERE id=1').run(config);
}
function configAudit() {
  return sql().prepare('SELECT * FROM alert_config_audit ORDER BY id DESC').all();
}
function notifications(userId) {
  return sql().prepare('SELECT * FROM alert_notifications WHERE user_id=? ORDER BY id DESC LIMIT 200').all(userId);
}
function findNotification(id, userId) {
  return sql().prepare('SELECT * FROM alert_notifications WHERE id=? AND user_id=?').get(id,userId);
}
function markNotificationRead(stamp, id) {
  return sql().prepare('UPDATE alert_notifications SET read_at=? WHERE id=?').run(stamp,id);
}
function allAlerts() {
  return sql().prepare('SELECT * FROM security_alerts ORDER BY level DESC, created_at DESC').all();
}
function alertsByCreator(userId) {
  return sql().prepare('SELECT * FROM security_alerts WHERE created_by=? ORDER BY level DESC,created_at DESC').all(userId);
}
function timeline(id) {
  return sql().prepare('SELECT * FROM alert_audit WHERE alert_id=? ORDER BY id').all(id);
}
function requestCancellation(id) {
  return sql().prepare('UPDATE security_alerts SET cancellation_requested=1 WHERE id=?').run(id);
}
function updateState(...params) {
  return sql().prepare('UPDATE security_alerts SET status=?,updated_at=?,owner=COALESCE(owner,?),acknowledged_at=COALESCE(acknowledged_at,?),resolved_at=COALESCE(resolved_at,?) WHERE id=?').run(...params);
}
function touchAlert(stamp, id) {
  return sql().prepare('UPDATE security_alerts SET updated_at=? WHERE id=?').run(stamp,id);
}
function badgeRefusalCount(badge, since) {
  return sql().prepare("SELECT COUNT(*) AS n FROM pietons WHERE badge=? AND resultat='refus' AND datetime>=?").get(badge,since).n;
}
function recentBadgeAlert(equipment, since) {
  return sql().prepare("SELECT id FROM security_alerts WHERE equipment=? AND created_at>=? AND origin='REGLE_BADGE'").get(equipment,since);
}

module.exports = {
  atomic, init,
  appendAudit,
  readConfig,
  notificationRecipients,
  prepareNotificationInsert,
  findAlert,
  insertAlert,
  pendingEscalations,
  updateEscalation,
  findUser,
  appendConfigAudit,
  updateConfig,
  configAudit,
  notifications,
  findNotification,
  markNotificationRead,
  allAlerts,
  alertsByCreator,
  timeline,
  requestCancellation,
  updateState,
  touchAlert,
  badgeRefusalCount,
  recentBadgeAlert
};
