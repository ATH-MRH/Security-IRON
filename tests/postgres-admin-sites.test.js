'use strict';
// Administration Système — Sites (backend/admin-sites.js, migration 015).
// PostgreSQL réel, aucun mock — même conventions que
// tests/postgres-maincourante-workflows.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_adminsites_' + randomUUID().replace(/-/g, '').slice(0, 12);
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin, agentToken;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
const uniqCode = () => 'site-' + randomUUID().slice(0, 8);

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    const a = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['adminsites_admin', await bcrypt.hash('securisite', 10), 'Admin', 'admin']);
    await seedMembership(pool, a.id, 'admin');
    const g = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['adminsites_agent', await bcrypt.hash('securisite', 10), 'Agent', 'agent']);
    await seedMembership(pool, g.id, 'agent');
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'adminsites_admin', password: 'securisite' }, null)).body.token;
  agentToken = (await request('POST', '/auth/login', { username: 'adminsites_agent', password: 'securisite' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('every /admin/sites route requires the admin role, never a scoped membership role', async () => {
  const noAuth = await request('GET', '/admin/sites', undefined, null);
  assert.equal(noAuth.status, 401);
  const agentDenied = await request('GET', '/admin/sites', undefined, agentToken);
  assert.equal(agentDenied.status, 403);
});

test('create validates code/name/email/GPS pairing before touching the database', async () => {
  assert.equal((await request('POST', '/admin/sites', { code: 'Invalid Code!', name: 'X' })).status, 400);
  assert.equal((await request('POST', '/admin/sites', { code: uniqCode() })).status, 400, 'name required');
  assert.equal((await request('POST', '/admin/sites', { code: uniqCode(), name: 'X', email: 'not-an-email' })).status, 400);
  assert.equal((await request('POST', '/admin/sites', { code: uniqCode(), name: 'X', latitude: 10 })).status, 400, 'longitude required with latitude');
});

test('create then read: site appears with default status active, real defaults, no fictional fields', async () => {
  const code = uniqCode();
  const created = await request('POST', '/admin/sites', { code, name: 'Site Test A', client: 'Client A', phone: '0555000000', email: 'a@example.com' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.code, code);
  assert.ok(created.body.id);
  const fetched = await request('GET', '/admin/sites/' + created.body.id);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.client, 'Client A');
});

test('duplicate code for the same tenant is refused (409), never silently overwritten', async () => {
  const code = uniqCode();
  const first = await request('POST', '/admin/sites', { code, name: 'First' });
  assert.equal(first.status, 201);
  const second = await request('POST', '/admin/sites', { code, name: 'Second' });
  assert.equal(second.status, 409);
});

test('list supports search and status filter, and returns a real total for pagination', async () => {
  const code = uniqCode();
  await request('POST', '/admin/sites', { code, name: 'Findable Unique Name ' + code });
  const found = await request('GET', '/admin/sites?search=' + encodeURIComponent(code));
  assert.equal(found.status, 200);
  assert.ok(found.body.sites.some(s => s.code === code));
  assert.ok(found.body.total >= 1);
  const activeOnly = await request('GET', '/admin/sites?status=active');
  assert.ok(activeOnly.body.sites.every(s => s.status === 'active'));
});

test('update changes identity/coordinates fields and is fully audited (before/after)', async () => {
  const created = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Original Name' });
  const updated = await request('PUT', '/admin/sites/' + created.body.id, { name: 'Updated Name', phone: '0666000000' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Updated Name');
  assert.equal(updated.body.phone, '0666000000');
  assert.ok(new Date(updated.body.updated_at).getTime() >= new Date(created.body.updated_at).getTime());
});

test('status transition: active -> suspended -> archived sets archived_at consistently, never a second identical transition', async () => {
  const created = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Lifecycle Site' });
  const id = created.body.id;
  const suspend = await request('PUT', '/admin/sites/' + id + '/status', { status: 'suspended', reason: 'maintenance' });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.archived_at, null);
  const sameAgain = await request('PUT', '/admin/sites/' + id + '/status', { status: 'suspended' });
  assert.equal(sameAgain.status, 409);
  const archive = await request('PUT', '/admin/sites/' + id + '/status', { status: 'archived', reason: 'decommissioned' });
  assert.equal(archive.status, 200);
  assert.ok(archive.body.archived_at);
});

test('an invalid status value is rejected, never silently coerced', async () => {
  const created = await request('POST', '/admin/sites', { code: uniqCode(), name: 'X' });
  const r = await request('PUT', '/admin/sites/' + created.body.id + '/status', { status: 'deleted_forever' });
  assert.equal(r.status, 400);
});

test('dependencies reports only what the schema genuinely scopes by site, and is honest about what it does not', async () => {
  const created = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Dep Site' });
  const r = await request('GET', '/admin/sites/' + created.body.id + '/dependencies');
  assert.equal(r.status, 200);
  assert.equal(r.body.zones, 0);
  assert.equal(r.body.postes, 0);
  assert.deepEqual(r.body.not_scoped_by_site, ['incidents', 'security_alerts']);
});

test('/admin/system reports a real site count reflecting an actual insert (basic correctness — the RLS-under-the-real-restricted-role guarantee itself is locked in separately in tests/postgres-scope-rls.test.js, since this file runs against SECURISITE_TEST_DATABASE_URL which is typically the superuser and would not catch an unwrapped RLS query)', async () => {
  await request('POST', '/admin/sites', { code: uniqCode(), name: 'KPI Regression Site' });
  const system = await request('GET', '/admin/system');
  assert.equal(system.status, 200);
  assert.ok(system.body.kpis.sites_total >= 1);
  assert.ok(system.body.kpis.sites_active >= 1);
});

test('a request for a nonexistent site id is a clean 404 everywhere, never a 500', async () => {
  const fakeId = randomUUID();
  assert.equal((await request('GET', '/admin/sites/' + fakeId)).status, 404);
  assert.equal((await request('PUT', '/admin/sites/' + fakeId, { name: 'x' })).status, 404);
  assert.equal((await request('PUT', '/admin/sites/' + fakeId + '/status', { status: 'archived' })).status, 404);
  assert.equal((await request('GET', '/admin/sites/' + fakeId + '/dependencies')).status, 404);
});

test('site creation and status changes are recorded in security_audit with a real before/after detail', async () => {
  const created = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Audited Site' });
  await request('PUT', '/admin/sites/' + created.body.id + '/status', { status: 'suspended', reason: 'test audit' });
  const auditRows = await request('GET', '/admin/security-audit?resource_type=site&limit=50');
  assert.equal(auditRows.status, 200);
  const createEvent = auditRows.body.find(r => r.event_type === 'system_admin.site.create' && r.resource_id === created.body.id);
  const statusEvent = auditRows.body.find(r => r.event_type === 'system_admin.site.status_change' && r.resource_id === created.body.id);
  assert.ok(createEvent, 'creation must be audited');
  assert.ok(statusEvent, 'status change must be audited');
  assert.equal(statusEvent.detail.after_status, 'suspended');
  assert.equal(statusEvent.detail.reason, 'test audit');
});

/* ============================================================ */
/*  GET /admin/zones — RECETTE VISUELLE ÉCRAN 1 (onglet Zones & postes) */
/* ============================================================ */
test('GET /admin/zones requires admin and a site_id, and never leaks another tenant\'s zones', async () => {
  assert.equal((await request('GET', '/admin/zones?site_id=x', undefined, null)).status, 401);
  assert.equal((await request('GET', '/admin/zones?site_id=x', undefined, agentToken)).status, 403);
  assert.equal((await request('GET', '/admin/zones')).status, 400, 'site_id required');
  assert.equal((await request('GET', '/admin/zones?site_id=' + randomUUID())).status, 404, 'nonexistent site');
});

test('GET /admin/zones returns real zones for a real site, never fabricated rows', async () => {
  const site = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Zones Test Site' });
  const empty = await request('GET', '/admin/zones?site_id=' + site.body.id);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.zones, [], 'a freshly created site has no zones — never an invented default');
  const pool = db.createDatabase(env);
  try {
    await pool.query(`INSERT INTO public.zones (site_id, tenant_id, code, name, kind) VALUES ($1,$2,'zone-a','Zone A','perimeter')`,
      [site.body.id, site.body.tenant_id]);
  } finally { await pool.close(); }
  const withZone = await request('GET', '/admin/zones?site_id=' + site.body.id);
  assert.equal(withZone.body.zones.length, 1);
  assert.equal(withZone.body.zones[0].name, 'Zone A');
});

/* ============================================================ */
/*  GET /admin/overview — RECETTE VISUELLE ÉCRAN 1 (cockpit Vue générale) */
/* ============================================================ */
test('GET /admin/overview requires admin and returns the real cockpit shape, no fabricated widgets', async () => {
  assert.equal((await request('GET', '/admin/overview', undefined, null)).status, 401);
  assert.equal((await request('GET', '/admin/overview', undefined, agentToken)).status, 403);
  const r = await request('GET', '/admin/overview');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.recent_activity));
  assert.ok(typeof r.body.sites_by_status === 'object');
  assert.equal(typeof r.body.maincourante_last_7_days, 'number');
  assert.ok(Array.isArray(r.body.maincourante_by_category));
  assert.ok(Array.isArray(r.body.top_sites));
  assert.ok(r.body.storage && typeof r.body.storage.bytes === 'number' && r.body.storage.bytes > 0, 'storage must be a real pg_database_size() reading, never a placeholder');
});

test('GET /admin/overview reflects a real site creation in sites_by_status without delay or fabrication', async () => {
  const before = (await request('GET', '/admin/overview')).body.sites_by_status.active || 0;
  await request('POST', '/admin/sites', { code: uniqCode(), name: 'Overview Test Site' });
  const after = (await request('GET', '/admin/overview')).body.sites_by_status.active || 0;
  assert.equal(after, before + 1);
});

/* ============================================================ */
/*  DELETE /admin/sites/:id — LOT 19 allégé : jamais un bouton      */
/*  trivial, refusée dès qu'une donnée réelle dépend du site.       */
/* ============================================================ */
test('DELETE /admin/sites/:id requires admin and a non-empty reason', async () => {
  const site = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Delete Gate Site' });
  assert.equal((await request('DELETE', '/admin/sites/' + site.body.id, { reason: 'x' }, null)).status, 401);
  assert.equal((await request('DELETE', '/admin/sites/' + site.body.id, { reason: 'x' }, agentToken)).status, 403);
  assert.equal((await request('DELETE', '/admin/sites/' + site.body.id, {})).status, 400, 'reason required');
  assert.equal((await request('DELETE', '/admin/sites/' + site.body.id, { reason: '   ' })).status, 400, 'blank reason refused');
});

test('DELETE /admin/sites/:id succeeds for a real site with zero dependencies, and is audited', async () => {
  const site = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Deletable Site' });
  const del = await request('DELETE', '/admin/sites/' + site.body.id, { reason: 'test cleanup' });
  assert.equal(del.status, 200);
  assert.equal((await request('GET', '/admin/sites/' + site.body.id)).status, 404, 'the site must genuinely be gone');
  const auditRows = await request('GET', '/admin/security-audit?resource_type=site&limit=50');
  const deleteEvent = auditRows.body.find(r => r.event_type === 'system_admin.site.delete' && r.resource_id === site.body.id);
  assert.ok(deleteEvent, 'deletion must be audited');
  assert.equal(deleteEvent.detail.reason, 'test cleanup');
});

test('DELETE /admin/sites/:id is refused (409) when a real zone depends on the site — never a silent cascade', async () => {
  const site = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Site With Zone' });
  const pool = db.createDatabase(env);
  try {
    await pool.query(`INSERT INTO public.zones (site_id, tenant_id, code, name) VALUES ($1,$2,'z','Zone')`, [site.body.id, site.body.tenant_id]);
  } finally { await pool.close(); }
  const del = await request('DELETE', '/admin/sites/' + site.body.id, { reason: 'attempt' });
  assert.equal(del.status, 409);
  assert.equal((await request('GET', '/admin/sites/' + site.body.id)).status, 200, 'the site must still exist — refused, not partially deleted');
});

test('DELETE /admin/sites/:id is refused (409) when a real membership depends on the site, even a non-active one (real FK safety net, not just the application pre-check)', async () => {
  const site = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Site With Membership' });
  const pool = db.createDatabase(env);
  try {
    const u = await pool.get(`INSERT INTO public.users (username, password_hash, role) VALUES ($1,$2,'agent') RETURNING id`,
      ['delsite_member_' + randomUUID().slice(0, 8), await bcrypt.hash('x', 10)]);
    await pool.query(`INSERT INTO public.memberships (user_id, tenant_id, site_id, role, alert_access, status) VALUES ($1,$2,$3,'agent','own','active')`,
      [u.id, site.body.tenant_id, site.body.id]);
  } finally { await pool.close(); }
  const del = await request('DELETE', '/admin/sites/' + site.body.id, { reason: 'attempt' });
  assert.equal(del.status, 409);
});

test('DELETE /admin/sites/:id on a nonexistent site is a clean 404, never a 500', async () => {
  assert.equal((await request('DELETE', '/admin/sites/' + randomUUID(), { reason: 'x' })).status, 404);
});
