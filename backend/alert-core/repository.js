const { randomUUID, createHash } = require('crypto');
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

// Locking primitives require a live, explicit transaction. Two observations also
// reject an autocommit executor, without changing PG-1 or trusting a pool-shaped object.
async function concurrencyTransaction(client) {
  if (!client || !['query','get','all'].every(method => typeof client[method] === 'function')) {
    throw Object.assign(new Error('Client transactionnel Alert Core requis'), { code: 'ALERT_TRANSACTION_REQUIRED' });
  }
  const sql = "SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation";
  const first = await client.get(sql);
  const second = await client.get(sql);
  if (!first || !second || first.xid !== second.xid || first.pid !== second.pid) {
    throw Object.assign(new Error('Client transactionnel Alert Core requis'), { code: 'ALERT_TRANSACTION_REQUIRED' });
  }
  if (second.isolation !== 'read committed') {
    throw Object.assign(new Error('Isolation READ COMMITTED requise pour Alert Core'), { code: 'ALERT_ISOLATION_REQUIRED' });
  }
}

async function acquireLock(client, operation) {
  const raw = process.env.SECURISITE_ALERT_LOCK_TIMEOUT_MS ?? '2000';
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 60000) {
    throw Object.assign(new Error('SECURISITE_ALERT_LOCK_TIMEOUT_MS invalide : entier de 1 à 60000 requis'), { code: 'ALERT_LOCK_CONFIG_INVALID' });
  }
  await concurrencyTransaction(client);
  // pg_settings exposes lock_timeout in milliseconds, independent of SHOW units.
  const previous = (await client.get("SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout'")).setting;
  const timeout = Number(previous) > 0 ? Math.min(Number(previous), Number(raw)) : Number(raw);
  const changed = timeout !== Number(previous);
  if (changed) await client.query("SELECT set_config('lock_timeout',$1,true)", [String(timeout) + 'ms']);
  let result;
  try { result = await operation(); }
  catch (cause) {
    // Only acquisition statements below can reach this mapping; no NOWAIT SQL.
    // Do not issue cleanup SQL in the failed transaction: atomic owns rollback.
    if (cause.code === '55P03') throw Object.assign(new Error('Opération temporairement indisponible', { cause }), { code: 'ALERT_LOCK_TIMEOUT' });
    throw cause;
  }
  if (changed) await client.query("SELECT set_config('lock_timeout',$1,true)", [previous + 'ms']);
  return result;
}

async function findAlertForUpdate(id, client) {
  return acquireLock(client, () => client.get('SELECT * FROM public.security_alerts WHERE id=$1 FOR UPDATE', [id]));
}
async function findNotificationForUpdate(id, userId, client) {
  return acquireLock(client, () => client.get('SELECT * FROM public.alert_notifications WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId]));
}
async function readConfigForUpdate(client) {
  const row = await acquireLock(client, () => client.get('SELECT config FROM public.alert_rules WHERE id=1 FOR UPDATE'));
  if (!row) throw Object.assign(new Error('Configuration Alert Core indisponible : règle id=1 absente'), { code: 'ALERT_CONFIG_MISSING' });
  return row.config;
}
async function lockBadge(badge, client) {
  const badgeText = typeof badge === 'number' ? String(badge) : badge;
  const bytes = createHash('sha256').update('securisite:alert-core:badge:v1').update(Buffer.from([0])).update(badgeText, 'utf8').digest();
  const key = bytes.readBigInt64BE(0).toString();
  await acquireLock(client, () => client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]));
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
// PG-16 : tenantId requis (jamais optionnel) — security_alerts.tenant_id est
// NOT NULL depuis la migration 009, qui ferme la fuite intertenant qu'une
// absence de colonne rendait possible (voir son en-tête).
async function insertAlert(id, createdAt, updatedAt, site, zone, type, level, origin, createdBy, username, status, comment, latitude, longitude, equipment, policy, tenantId, client = db) {
  const result = await client.query(`INSERT INTO public.security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,latitude,longitude,equipment,policy,tenant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [id, createdAt, updatedAt, site, zone, type, level, origin, createdBy, username, status, comment, latitude, longitude, equipment, policy, tenantId]);
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
// PG-16 : tenantId requis — sans lui, un SOC 'scope' verrait toutes les
// alertes de tous les tenants (voir migration 009 et tests/postgres-soc.test.js).
async function allAlerts(tenantId, client = db) {
  return client.all('SELECT * FROM public.security_alerts WHERE tenant_id=$1 ORDER BY level DESC, created_at DESC', [tenantId]);
}
async function alertsByCreator(userId, tenantId, client = db) {
  return client.all('SELECT * FROM public.security_alerts WHERE created_by=$1 AND tenant_id=$2 ORDER BY level DESC,created_at DESC', [userId, tenantId]);
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
// PCS01 (Lot E) : security_alerts est désormais protégée par RLS (migration
// 012) — service.js n'écrit jamais de SQL brut lui-même (PG32A), donc ces
// deux poseurs de marqueur de session (SET LOCAL, comme backend/scope.js
// #withActorContext) vivent ici, appelés depuis les transactions déjà
// ouvertes par service.js (atomic()/db.transaction), jamais sur le pool nu.
async function setActorContext(client, userId) {
  await client.query("SELECT set_config('securisite.actor_user_id', $1, true)", [String(userId)]);
}
async function setSystemJob(client) {
  await client.query("SELECT set_config('securisite.system_job', 'escalation', true)");
}

module.exports = {
  findAlertForUpdate, findNotificationForUpdate, readConfigForUpdate, lockBadge,
  atomic, init, appendAudit, readConfig, notificationRecipients, prepareNotificationInsert,
  findAlert, insertAlert, pendingEscalations, updateEscalation, findUser, appendConfigAudit,
  updateConfig, configAudit, notifications, findNotification, markNotificationRead,
  allAlerts, alertsByCreator, timeline, requestCancellation, updateState, touchAlert,
  badgeRefusalCount, recentBadgeAlert, setActorContext, setSystemJob
};
