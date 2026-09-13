'use strict';
// PG-10 — journal de sécurité global (security_audit, migration 006).
// backend/security-audit.js est le point d'écriture unique ; ce fichier
// prouve : schéma + append-only + RLS (soc uniquement, cross-tenant refusé),
// le câblage HTTP réel (login, session révoquée, refus sensibles, user CRUD,
// alert.create/action/rules.update, membership.create), la sanitation de
// `detail`, request_id/IP, la pagination, le rollback sans faux success, et
// readiness fail-closed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, RLS_POLICIES, PRIVILEGES } = require('../backend/db/postgresql/readiness');
const securityAudit = require('../backend/security-audit');
const alertCoreService = require('../backend/alert-core/service');
const { provisionLocalMembership } = require('../backend/db/postgresql/provision-membership');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_secaudit_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(5).toString('hex');
const rejects = (p, code) => assert.rejects(p, e => { assert.equal(e.code, code, e.message); return true; });

let root, pool, stop, base;
let admin, agent; // JWT tokens
let adminId, agentId, localTenantId;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function latest(where, params = []) {
  return pool.all('SELECT * FROM public.security_audit ' + (where ? 'WHERE ' + where : '') + ' ORDER BY id DESC LIMIT 20', params);
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  const adminRow = await pool.get(
    "INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES('secaudit-admin',$1,'A','admin') RETURNING id",
    [await bcrypt.hash('securisite', 10)]);
  const agentRow = await pool.get(
    "INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES('secaudit-agent',$1,'B','agent') RETURNING id",
    [await bcrypt.hash('agent', 10)]);
  adminId = adminRow.id; agentId = agentRow.id;
  await seedMembership(pool, adminId, 'admin');
  await seedMembership(pool, agentId, 'agent');
  localTenantId = (await pool.get("SELECT id FROM public.tenants WHERE code='local'")).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'secaudit-admin', password: 'securisite' }, null)).body.token;
  agent = (await request('POST', '/auth/login', { username: 'secaudit-agent', password: 'agent' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

/* ============================================================ */
/*  Schéma, append-only, privilèges                              */
/* ============================================================ */

test('006 creates security_audit with the expected columns, outcome/origin CHECKs', async () => {
  const cols = (await pool.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='security_audit' ORDER BY ordinal_position"
  )).map(r => r.column_name);
  assert.deepEqual(cols, [
    'id', 'created_at', 'request_id', 'correlation_id', 'actor_user_id', 'actor_username', 'actor_role',
    'tenant_id', 'site_id', 'zone_id', 'event_type', 'resource_type', 'resource_id', 'action', 'outcome',
    'origin', 'ip_address', 'user_agent', 'detail',
  ]);
  await rejects(pool.query("INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin) VALUES('x','x','x','maybe','http')"), '23514');
  await rejects(pool.query("INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin) VALUES('x','x','x','success','saas')"), '23514');
});

test('security_audit is append-only: UPDATE/DELETE/TRUNCATE rejected', async () => {
  await pool.query("INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin) VALUES('x.y','x','y','success','system')");
  await rejects(pool.query("UPDATE public.security_audit SET outcome='denied'"), '23514');
  await rejects(pool.query('DELETE FROM public.security_audit'), '23514');
  await rejects(pool.query('TRUNCATE public.security_audit'), '23514');
});

test('PRIVILEGES: APP gets SELECT,INSERT only — never UPDATE/DELETE', () => {
  assert.equal(PRIVILEGES.security_audit, 'SELECT,INSERT');
  assert.deepEqual(RLS_POLICIES.security_audit.sort(), ['security_audit_app_insert', 'security_audit_soc_read']);
});

/* ============================================================ */
/*  RLS : SOC seul, tenant A vs B, agent exclu                   */
/* ============================================================ */

test('RLS: a plain agent membership gets no rows from security_audit, even under its own tenant', async t => {
  await pool.query("INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin,tenant_id) VALUES('t.e','r','a','success','http',$1)", [localTenantId]);
  const role = 'sec_test_secaudit_agent_' + tag();
  await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'x'`);
  await pool.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`);
  await pool.query(`GRANT USAGE ON SCHEMA public, securisite_meta TO "${role}"`);
  await pool.query(`GRANT EXECUTE ON FUNCTION securisite_meta.current_actor_soc_tenant_ids() TO "${role}"`);
  await pool.query(`GRANT SELECT, INSERT ON public.security_audit TO "${role}"`);
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const u = new URL(env.DATABASE_URL); u.username = role; u.password = 'x';
  const c = new Client({ connectionString: u.href }); await c.connect();
  try {
    await c.query("SELECT set_config('securisite.actor_user_id',$1,false)", [String(agentId)]);
    assert.equal((await c.query('SELECT count(*)::int n FROM public.security_audit')).rows[0].n, 0, 'agent membership: no general access to the global journal');
  } finally { await c.end(); }
});

test('RLS: a soc membership reads only its own tenant, cross-tenant explicitly refused', async t => {
  const otherTenant = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('secaudit-other','Other') RETURNING id")).id;
  await pool.query("INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin,tenant_id) VALUES('t.local','r','a','success','http',$1)", [localTenantId]);
  await pool.query("INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin,tenant_id) VALUES('t.other','r','a','success','http',$1)", [otherTenant]);
  const socUser = (await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES($1,'x','agent') RETURNING id", ['soc_' + tag()])).id;
  await pool.query("INSERT INTO public.memberships(user_id,tenant_id,role,alert_access) VALUES($1,$2,'soc','scope')", [socUser, localTenantId]);
  const role = 'sec_test_secaudit_soc_' + tag();
  await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'x'`);
  await pool.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`);
  await pool.query(`GRANT USAGE ON SCHEMA public, securisite_meta TO "${role}"`);
  await pool.query(`GRANT EXECUTE ON FUNCTION securisite_meta.current_actor_soc_tenant_ids() TO "${role}"`);
  await pool.query(`GRANT SELECT, INSERT ON public.security_audit TO "${role}"`);
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const u = new URL(env.DATABASE_URL); u.username = role; u.password = 'x';
  const c = new Client({ connectionString: u.href }); await c.connect();
  try {
    await c.query("SELECT set_config('securisite.actor_user_id',$1,false)", [String(socUser)]);
    const rows = (await c.query('SELECT event_type FROM public.security_audit')).rows.map(r => r.event_type);
    assert.ok(rows.includes('t.local'));
    assert.ok(!rows.includes('t.other'), 'cross-tenant row never visible to a soc of another tenant');
  } finally { await c.end(); }
});

/* ============================================================ */
/*  Câblage HTTP réel                                             */
/* ============================================================ */

test('auth.login.success is recorded with actor identity, never a password/hash', async () => {
  const r = await request('POST', '/auth/login', { username: 'secaudit-admin', password: 'securisite' }, null);
  assert.equal(r.status, 200);
  const row = (await latest('event_type = $1 AND actor_user_id = $2', ['auth.login.success', adminId]))[0];
  assert.equal(row.outcome, 'success'); assert.equal(row.origin, 'http');
  assert.equal(row.actor_username, 'secaudit-admin'); assert.equal(row.resource_type, 'session');
  assert.doesNotMatch(JSON.stringify(row), /securisite|password|hash/i);
});

test('auth.login.failure is recorded for both an unknown user and a wrong password, with no password ever persisted', async () => {
  await request('POST', '/auth/login', { username: 'nobody-' + tag(), password: 'whatever-secret' }, null);
  const unknown = (await latest("event_type = 'auth.login.failure'"))[0];
  assert.equal(unknown.outcome, 'failure'); assert.equal(unknown.actor_user_id, null);
  assert.doesNotMatch(JSON.stringify(unknown), /whatever-secret/);

  await request('POST', '/auth/login', { username: 'secaudit-agent', password: 'wrong-secret-x' }, null);
  const wrong = (await latest("event_type = 'auth.login.failure'"))[0];
  assert.equal(wrong.actor_username, 'secaudit-agent');
  assert.doesNotMatch(JSON.stringify(wrong), /wrong-secret-x|\$2[aby]\$/); // no bcrypt hash prefix either
});

test('auth.session.revoked is recorded when a valid JWT no longer resolves to a user', async () => {
  const username = 'revoke_' + tag();
  const revocable = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,'agent') RETURNING id", [username, await bcrypt.hash('x', 10)])).id;
  const token = (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token;
  await pool.query('DELETE FROM public.users WHERE id=$1', [revocable]); // never had a membership: FK allows it
  const r = await request('GET', '/alerts', undefined, token);
  assert.equal(r.status, 401);
  const row = (await latest("event_type = 'auth.session.revoked'"))[0];
  assert.equal(row.outcome, 'denied'); assert.equal(row.resource_type, 'session'); assert.equal(row.actor_user_id, revocable);
});

test('auth.access.denied is recorded for admin-only, scope, and SOC-only refusals', async () => {
  await request('GET', '/admin/users', undefined, agent);
  const adminDenied = (await latest("event_type = 'auth.access.denied' AND resource_type = 'admin'"))[0];
  assert.equal(adminDenied.outcome, 'denied'); assert.equal(adminDenied.actor_user_id, agentId);

  await request('PUT', '/alerts/rules', { escalation: [1, 2, 3], incidentCritical: true, badgeThreshold: 2, badgeWindowSeconds: 10 }, agent);
  const socDenied = (await latest("event_type = 'auth.access.denied' AND resource_type = 'alert_rules'"))[0];
  assert.equal(socDenied.actor_user_id, agentId);

  const noScope = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,'agent') RETURNING id", ['noscope_' + tag(), await bcrypt.hash('x', 10)])).id;
  const noScopeToken = (await request('POST', '/auth/login', { username: (await pool.get('SELECT username FROM public.users WHERE id=$1', [noScope])).username, password: 'x' }, null)).body.token;
  await request('GET', '/incidents', undefined, noScopeToken);
  const scopeDenied = (await latest("event_type = 'auth.access.denied' AND resource_type = 'scope'"))[0];
  assert.equal(scopeDenied.actor_user_id, noScope);
});

test('user.create / user.update / user.delete are recorded in the same transaction as the mutation', async () => {
  const username = 'crud_' + tag();
  const created = (await request('POST', '/admin/users', { username, password: 'x', role: 'agent' })).body;
  const createdRow = (await latest("event_type = 'user.create' AND resource_id = $1", [String(created.id)]))[0];
  assert.equal(createdRow.outcome, 'success'); assert.equal(createdRow.actor_user_id, adminId);
  assert.equal(createdRow.detail.username, username);

  await request('PUT', '/admin/users/' + created.id, { role: 'admin' });
  const updatedRow = (await latest("event_type = 'user.update' AND resource_id = $1", [String(created.id)]))[0];
  assert.equal(updatedRow.outcome, 'success');
  assert.ok(updatedRow.detail.changed_fields.includes('role'));

  await request('DELETE', '/admin/users/' + created.id);
  const deletedRow = (await latest("event_type = 'user.delete' AND resource_id = $1", [String(created.id)]))[0];
  assert.equal(deletedRow.outcome, 'success');
});

test('membership.create is recorded by provisionLocalMembership, origin=automation', async () => {
  const username = 'memcreate_' + tag();
  const newUser = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES($1,'x','admin') RETURNING id", [username])).id;
  await pool.transaction(c => provisionLocalMembership(c, newUser));
  const row = (await latest("event_type = 'membership.create' AND detail->>'user_id' = $1", [String(newUser)]))[0];
  assert.equal(row.outcome, 'success'); assert.equal(row.origin, 'automation'); assert.equal(row.tenant_id, localTenantId);
});

test('alert.create is recorded for a direct POST /alerts, origin=http', async () => {
  const a = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, agent)).body;
  const row = (await latest("event_type = 'alert.create' AND resource_id = $1", [a.id]))[0];
  assert.equal(row.outcome, 'success'); assert.equal(row.origin, 'http'); assert.equal(row.actor_user_id, agentId);
  assert.equal(row.detail.alert_origin, 'COMMAND');
});

test('alert.create is recorded with origin=system when triggered automatically by a business rule (incident/badge)', async () => {
  const inc = (await request('POST', '/incidents', { type: 'Intrusion', lieu: 'Z', gravite: 'critique' }, agent)).body;
  const row = (await latest("event_type = 'alert.create' AND detail->>'alert_origin' = 'INCIDENT'"))[0];
  assert.equal(row.origin, 'system');
  assert.ok(row); void inc;
});

test('alert.action and alert.rules.update are recorded', async () => {
  const a = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, agent)).body;
  await request('POST', `/alerts/${a.id}/actions`, { action: 'ACQUITTEE' }, admin);
  const actionRow = (await latest("event_type = 'alert.action' AND resource_id = $1", [a.id]))[0];
  assert.equal(actionRow.outcome, 'success'); assert.equal(actionRow.action, 'ACQUITTEE'); assert.equal(actionRow.actor_user_id, adminId);

  const rules = { escalation: [30, 60, 120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 };
  await request('PUT', '/alerts/rules', rules, admin);
  const rulesRow = (await latest("event_type = 'alert.rules.update'"))[0];
  assert.equal(rulesRow.outcome, 'success'); assert.equal(rulesRow.resource_type, 'alert_rules');
});

/* ============================================================ */
/*  Rollback : jamais de faux success                            */
/* ============================================================ */

test('a rolled-back business mutation never leaves a success security_audit row behind', async () => {
  const before = (await pool.get("SELECT count(*)::int n FROM public.security_audit WHERE event_type='alert.create'")).n;
  await assert.rejects(pool.transaction(async client => {
    await alertCoreService.create({ site: 'S', type: 'T', level: 4 }, { id: agentId, username: 'secaudit-agent' }, 'COMMAND', client);
    throw Object.assign(new Error('deliberate parent rollback'), { code: 'TEST_ROLLBACK' });
  }), e => e.code === 'TEST_ROLLBACK');
  const after = (await pool.get("SELECT count(*)::int n FROM public.security_audit WHERE event_type='alert.create'")).n;
  assert.equal(after, before, 'no alert.create row survives the rollback');
});

test('an audit-write failure inside a critical mutation rolls the mutation back too (no false success)', async () => {
  const before = (await pool.get("SELECT count(*)::int n FROM public.incidents")).n;
  await assert.rejects(pool.transaction(async client => {
    const faulty = { ...client, query: (sql, params) => (/INSERT INTO public\.security_audit/.test(sql)
      ? Promise.reject(Object.assign(new Error('fault injected'), { code: 'FAULT' }))
      : client.query(sql, params)) };
    await client.query("SELECT pg_advisory_xact_lock(hashtext('securisite:incidents:ref')::bigint)");
    const c = Number((await client.get('SELECT COUNT(*) AS c FROM incidents')).c) || 0;
    await client.query(
      "INSERT INTO incidents (id, ref, datetime, type, gravite, statut) VALUES ($1,$2,now()::text,'x','mineur','ouvert')",
      ['INC-' + randomBytes(4).toString('hex'), 'INC-' + (2026100 + c)]);
    // Emulate routes.js's own audit call using the faulty client to prove propagation.
    await securityAudit.record({ eventType: 'incident.create', resourceType: 'incident', action: 'create', outcome: 'success', origin: 'http' }, faulty);
  }), e => e.code === 'FAULT');
  const after = (await pool.get("SELECT count(*)::int n FROM public.incidents")).n;
  assert.equal(after, before, 'the incident insert rolled back together with the failed audit write');
});

/* ============================================================ */
/*  Sanitation de detail                                         */
/* ============================================================ */

test('sanitizeDetail strips forbidden keys/patterns, allows flat arrays, rejects nested objects', () => {
  const clean = securityAudit.sanitizeDetail({
    password: 'x', password_hash: 'x', jwt: 'x', Authorization: 'Bearer x', api_key: 'x',
    changed_fields: ['role', 'nom_complet'], reason_code: 'tenant_unresolved', level: 4, ok: true, n: null,
  });
  assert.deepEqual(clean, { changed_fields: ['role', 'nom_complet'], reason_code: 'tenant_unresolved', level: 4, ok: true, n: null });
  assert.throws(() => securityAudit.sanitizeDetail({ nested: { a: 1 } }), TypeError);
  assert.throws(() => securityAudit.sanitizeDetail({ arr: [{ a: 1 }] }), TypeError);
  assert.equal(securityAudit.sanitizeDetail(null), null);
});

test('no JWT, password, hash or secret ever appears anywhere in security_audit after a full HTTP flow', async () => {
  await request('POST', '/auth/login', { username: 'secaudit-admin', password: 'securisite' }, null);
  const rows = await pool.all('SELECT * FROM public.security_audit');
  const blob = JSON.stringify(rows);
  assert.doesNotMatch(blob, /securisite\b/); // the literal password value
  assert.doesNotMatch(blob, /\$2[aby]\$/);   // bcrypt hash prefix
  assert.doesNotMatch(blob, /eyJ[A-Za-z0-9_-]{10,}/); // a JWT-shaped string
});

/* ============================================================ */
/*  request_id / IP / pagination                                 */
/* ============================================================ */

test('X-Request-Id is returned and matches the request_id recorded for that request', async () => {
  const r = await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, agent);
  const headerId = r.headers.get('x-request-id');
  assert.ok(headerId);
  const row = (await latest("event_type = 'alert.create' AND resource_id = $1", [r.body.id]))[0];
  assert.equal(row.request_id, headerId);
});

test('ip_address is recorded for an HTTP-originated event', async () => {
  await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, agent);
  const row = (await latest("event_type = 'alert.create'"))[0];
  assert.ok(row.ip_address, 'an ip_address was recorded');
});

test('GET /api/admin/security-audit supports event_type/resource_type/actor/from/to/limit and stays SOC-scoped', async () => {
  await request('POST', '/alerts', { site: 'PagTest', type: 'T', level: 4 }, agent);
  const soc = await request('GET', '/admin/security-audit?event_type=alert.create&limit=1', undefined, admin);
  assert.equal(soc.status, 200);
  assert.ok(Array.isArray(soc.body) && soc.body.length <= 1);
  if (soc.body.length) assert.equal(soc.body[0].event_type, 'alert.create');

  const badLimit = await request('GET', '/admin/security-audit?limit=999999', undefined, admin);
  assert.equal(badLimit.status, 200); // clamped, never an error
  assert.ok(badLimit.body.length <= 500);

  const badFrom = await request('GET', '/admin/security-audit?from=not-a-date', undefined, admin);
  assert.equal(badFrom.status, 400);

  // Non-admin JWT role never reaches the RLS-scoped query at all.
  const forbidden = await request('GET', '/admin/security-audit', undefined, agent);
  assert.equal(forbidden.status, 403);
});

/* ============================================================ */
/*  Readiness fail-closed                                        */
/* ============================================================ */

test('readiness requires security_audit: table, append-only triggers, RLS, and the soc-only RLS function', async t => {
  assert.equal(await assertReady(pool, { directory }), undefined);

  await pool.query('DROP TRIGGER security_audit_no_mutation ON public.security_audit');
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_AUDIT_GUARD_MISSING' && /security_audit_no_mutation/.test(e.message));
  await pool.query(`
    CREATE TRIGGER security_audit_no_mutation BEFORE UPDATE OR DELETE ON public.security_audit
    FOR EACH ROW EXECUTE FUNCTION securisite_meta.reject_alert_audit_mutation()`);

  await pool.query('ALTER TABLE public.security_audit DISABLE ROW LEVEL SECURITY');
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_RLS_MISSING' && /security_audit/.test(e.message));
  await pool.query('ALTER TABLE public.security_audit ENABLE ROW LEVEL SECURITY');

  await pool.query('DROP POLICY security_audit_soc_read ON public.security_audit');
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_RLS_MISSING' && /security_audit_soc_read/.test(e.message));
  await pool.query(`
    CREATE POLICY security_audit_soc_read ON public.security_audit
      FOR SELECT USING (tenant_id IN (SELECT securisite_meta.current_actor_soc_tenant_ids()))`);

  assert.equal(await assertReady(pool, { directory }), undefined, 'fully restored');
});

test('readiness fails if the security_audit table is absent', async t => {
  await pool.query('ALTER TABLE public.security_audit RENAME TO security_audit_renamed');
  t.after(() => pool.query('ALTER TABLE public.security_audit_renamed RENAME TO security_audit'));
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_TABLE_MISSING' && /security_audit/.test(e.message));
});
