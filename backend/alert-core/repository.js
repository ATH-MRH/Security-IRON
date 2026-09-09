const { randomUUID } = require('crypto');
const db = require('../database');

function withCleanupError(primary, name, secondary) {
  try {
    Object.defineProperty(primary, name, { value: secondary, configurable: true });
    return primary;
  } catch {
    const wrapped = new Error('Échec transactionnel Alert Core', { cause: primary });
    if (primary?.code) wrapped.code = primary.code;
    Object.defineProperty(wrapped, name, { value: secondary, configurable: true });
    return wrapped;
  }
}

// The parent client must come from PG-1's transaction callback, never from a pool.
async function atomic(fn, transactionClient = null) {
  if (typeof fn !== 'function') throw new TypeError('Callback transactionnel requis');
  if (transactionClient === null) return db.transaction(client => fn(client));
  const name = 'alert_' + randomUUID().replaceAll('-', '');
  await transactionClient.query('SAVEPOINT ' + name);
  try {
    const result = await fn(transactionClient);
    await transactionClient.query('RELEASE SAVEPOINT ' + name);
    return result;
  } catch (primary) {
    try { await transactionClient.query('ROLLBACK TO SAVEPOINT ' + name); }
    catch (error) { primary = withCleanupError(primary, 'rollbackError', error); }
    try { await transactionClient.query('RELEASE SAVEPOINT ' + name); }
    catch (error) { primary = withCleanupError(primary, 'releaseError', error); }
    throw primary;
  }
}

// Read-only readiness check. Deployment owns migrations and configuration seeding.
async function init(client = db) {
  const required = ['security_alerts', 'alert_audit', 'alert_notifications', 'alert_config_audit', 'alert_rules'];
  const missing = await client.all(`
    SELECT required.name FROM unnest($1::text[]) AS required(name)
    LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.' || required.name)
    WHERE c.oid IS NULL OR c.relkind NOT IN ('r','p')
  `, [required]);
  if (missing.length) throw Object.assign(new Error('Schéma Alert Core indisponible : ' + missing.map(row => row.name).join(', ')), { code: 'ALERT_SCHEMA_UNAVAILABLE' });
  await readConfig(client);
}

async function appendAudit(id, stamp, actor, action, detail, client = db) {
  const result = await client.query('INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES($1,$2,$3,$4,$5) RETURNING id', [id, stamp, actor, action, detail]);
  return { rowCount: result.rowCount, id: result.rows[0].id };
}
async function readConfig(client = db) {
  const row = await client.get('SELECT config FROM public.alert_rules WHERE id=1');
  if (!row) throw Object.assign(new Error('Configuration Alert Core indisponible : règle id=1 absente'), { code: 'ALERT_CONFIG_MISSING' });
  return row.config;
}
async function notificationRecipients(createdBy, client = db) {
  return client.all("SELECT id FROM public.users WHERE role='admin' OR id=$1", [createdBy]);
}
function prepareNotificationInsert(client = db) {
  return async (alertId, userId, stamp, message) => {
    const result = await client.query('INSERT INTO public.alert_notifications(alert_id,user_id,created_at,message) VALUES($1,$2,$3,$4) RETURNING id', [alertId, userId, stamp, message]);
    return { rowCount: result.rowCount, id: result.rows[0].id };
  };
}
async function findAlert(id, client = db) {
  return client.get('SELECT * FROM public.security_alerts WHERE id=$1', [id]);
}
async function insertAlert(id, createdAt, updatedAt, site, zone, type, level, origin, createdBy, username, status, comment, latitude, longitude, equipment, policy, client = db) {
  const result = await client.query(`INSERT INTO public.security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,latitude,longitude,equipment,policy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
  [id, createdAt, updatedAt, site, zone, type, level, origin, createdBy, username, status, comment, latitude, longitude, equipment, policy]);
  return { rowCount: result.rowCount };
}
async function pendingEscalations(client = db) {
  return client.all("SELECT * FROM public.security_alerts WHERE level>=3 AND acknowledged_at IS NULL AND status='NOTIFIEE'");
}
async function updateEscalation(step, stamp, id, client = db) {
  const result = await client.query('UPDATE public.security_alerts SET escalation_step=$1,updated_at=$2 WHERE id=$3', [step, stamp, id]);
  return { rowCount: result.rowCount };
}
async function findUser(id, client = db) {
  return client.get('SELECT id, username, role FROM public.users WHERE id=$1', [id]);
}
async function appendConfigAudit(stamp, actor, previous, current, client = db) {
  const result = await client.query('INSERT INTO public.alert_config_audit(created_at,actor,previous,current) VALUES($1,$2,$3,$4) RETURNING id', [stamp, actor, previous, current]);
  return { rowCount: result.rowCount, id: result.rows[0].id };
}
async function updateConfig(config, client = db) {
  const result = await client.query('UPDATE public.alert_rules SET config=$1 WHERE id=1', [config]);
  return { rowCount: result.rowCount };
}
async function configAudit(client = db) {
  return client.all('SELECT * FROM public.alert_config_audit ORDER BY id DESC');
}
async function notifications(userId, client = db) {
  return client.all('SELECT * FROM public.alert_notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 200', [userId]);
}
async function findNotification(id, userId, client = db) {
  return client.get('SELECT * FROM public.alert_notifications WHERE id=$1 AND user_id=$2', [id, userId]);
}
async function markNotificationRead(stamp, id, client = db) {
  const result = await client.query('UPDATE public.alert_notifications SET read_at=$1 WHERE id=$2', [stamp, id]);
  return { rowCount: result.rowCount };
}
async function allAlerts(client = db) {
  return client.all('SELECT * FROM public.security_alerts ORDER BY level DESC, created_at DESC');
}
async function alertsByCreator(userId, client = db) {
  return client.all('SELECT * FROM public.security_alerts WHERE created_by=$1 ORDER BY level DESC,created_at DESC', [userId]);
}
async function timeline(id, client = db) {
  return client.all('SELECT * FROM public.alert_audit WHERE alert_id=$1 ORDER BY id', [id]);
}
async function requestCancellation(id, client = db) {
  const result = await client.query('UPDATE public.security_alerts SET cancellation_requested=1 WHERE id=$1', [id]);
  return { rowCount: result.rowCount };
}
async function updateState(status, stamp, owner, acknowledgedAt, resolvedAt, id, client = db) {
  const result = await client.query('UPDATE public.security_alerts SET status=$1,updated_at=$2,owner=COALESCE(owner,$3),acknowledged_at=COALESCE(acknowledged_at,$4),resolved_at=COALESCE(resolved_at,$5) WHERE id=$6', [status, stamp, owner, acknowledgedAt, resolvedAt, id]);
  return { rowCount: result.rowCount };
}
async function touchAlert(stamp, id, client = db) {
  const result = await client.query('UPDATE public.security_alerts SET updated_at=$1 WHERE id=$2', [stamp, id]);
  return { rowCount: result.rowCount };
}
async function badgeRefusalCount(badge, since, client = db) {
  const row = await client.get("SELECT COUNT(*) AS n FROM public.pietons WHERE badge=$1 AND resultat='refus' AND datetime>=$2", [badge, since]);
  const value = row?.n;
  // pg returns COUNT (int8) as TEXT. Validate before conversion; no global parser.
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(new Error('Nombre de refus badge hors plage entière sûre'), { code: 'ALERT_COUNT_RANGE' });
  }
  return Number(value);
}
async function recentBadgeAlert(equipment, since, client = db) {
  return client.get("SELECT id FROM public.security_alerts WHERE equipment=$1 AND created_at>=$2 AND origin='REGLE_BADGE'", [equipment, since]);
}

module.exports = {
  atomic, init, appendAudit, readConfig, notificationRecipients, prepareNotificationInsert,
  findAlert, insertAlert, pendingEscalations, updateEscalation, findUser, appendConfigAudit,
  updateConfig, configAudit, notifications, findNotification, markNotificationRead,
  allAlerts, alertsByCreator, timeline, requestCancellation, updateState, touchAlert,
  badgeRefusalCount, recentBadgeAlert
};
