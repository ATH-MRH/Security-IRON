'use strict';
// PG-8 — activation du périmètre applicatif : backend/scope.js (résolution
// centrale, hiérarchie tenant > site > zone, own/scope) et son application
// sur les routes historiques (backend/routes.js) et Alert Core (backend/alerts.js).
// Décisions métier figées (checkpoint humain) : bascule sans mode legacy
// parallèle, admin historique = soc/scope SANS accès implicite à un autre
// tenant, 403 (jamais une liste vide) sans périmètre, PG-8 = enforcement
// applicatif seul (RLS = PG-9, non touchée ici).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { resolveScope } = require('../backend/scope');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_scope_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, pool;
const ids = {}; // tenantA/tenantB/siteA1/siteA2/zoneA1a/zoneA1b/siteB1/zoneB1a
const uid = () => randomBytes(4).toString('hex');

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}

// Direct fixture creation (never through provisionLocalMembership: this suite
// exercises the full tenant/site/zone/role/alert_access/status matrix, not
// just the local-tenant backfill shape).
async function createUser(role = 'agent') {
  const username = 'scope_' + uid();
  const row = await pool.get(
    'INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES($1,$2,$3,$4) RETURNING id',
    [username, await bcrypt.hash('x', 10), username, role]);
  return { id: row.id, username };
}
async function grant(userId, { tenantId, siteId = null, zoneId = null, role = 'agent', alertAccess = 'own', status = 'active' }) {
  await pool.query(
    `INSERT INTO public.memberships(user_id,tenant_id,site_id,zone_id,role,alert_access,status)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [userId, tenantId, siteId, zoneId, role, alertAccess, status]);
}
async function login(username) {
  return (await request('POST', '/auth/login', { username, password: 'x' })).body.token;
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);

  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('ta','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('tb','Tenant B') RETURNING id")).id;
  ids.siteA1 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'sa1','Site A1') RETURNING id", [ids.tenantA])).id;
  ids.siteA2 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'sa2','Site A2') RETURNING id", [ids.tenantA])).id;
  ids.zoneA1a = (await pool.get("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'za1a','Zone A1a') RETURNING id", [ids.siteA1, ids.tenantA])).id;
  ids.zoneA1b = (await pool.get("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'za1b','Zone A1b') RETURNING id", [ids.siteA1, ids.tenantA])).id;
  ids.siteB1 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'sb1','Site B1') RETURNING id", [ids.tenantB])).id;
  ids.zoneB1a = (await pool.get("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'zb1a','Zone B1a') RETURNING id", [ids.siteB1, ids.tenantB])).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

/* ============================================================ */
/*  backend/scope.js — resolveScope: hiérarchie, own/scope,     */
/*  suspended/archived, memberships multiples, tenant/site/zone */
/*  forgés (unitaire, contre PostgreSQL réel)                   */
/* ============================================================ */

test('no membership: hasAccess is false and nothing is covered', async () => {
  const u = await createUser('agent');
  const s = await resolveScope(u.id, pool);
  assert.equal(s.hasAccess, false);
  assert.equal(s.allows(ids.tenantA), false);
  assert.equal(s.resolveTenant(), null);
});

test('tenant-level SOC membership covers every site and zone under that tenant, and nothing under another tenant', async () => {
  const u = await createUser('admin');
  await grant(u.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const s = await resolveScope(u.id, pool);
  assert.equal(s.hasAccess, true);
  assert.equal(s.resolveTenant(), ids.tenantA);
  assert.equal(s.allows(ids.tenantA), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA1), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA1, ids.zoneA1a), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA2), true);
  // Tenant B: no membership there at all. PG-8 decision #2: no implicit
  // cross-tenant access for a historical/soc admin.
  assert.equal(s.allows(ids.tenantB), false);
  assert.equal(s.allows(ids.tenantB, ids.siteB1), false);
  assert.equal(s.resolveTenant(ids.tenantB), null);
});

test('site-level membership covers its own zones but not a sibling site, even in the same tenant', async () => {
  const u = await createUser('agent');
  await grant(u.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'site_manager', alertAccess: 'own' });
  const s = await resolveScope(u.id, pool);
  assert.equal(s.allows(ids.tenantA), false, 'no unconditional tenant-wide coverage');
  assert.equal(s.allows(ids.tenantA, ids.siteA1), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA1, ids.zoneA1a), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA1, ids.zoneA1b), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA2), false, 'sibling site A2 not covered');
});

test('zone-level membership covers only that exact zone, not a sibling zone of the same site', async () => {
  const u = await createUser('agent');
  await grant(u.id, { tenantId: ids.tenantA, siteId: ids.siteA1, zoneId: ids.zoneA1a, role: 'agent', alertAccess: 'own' });
  const s = await resolveScope(u.id, pool);
  assert.equal(s.allows(ids.tenantA, ids.siteA1), false, 'no whole-site coverage from a zone membership');
  assert.equal(s.allows(ids.tenantA, ids.siteA1, ids.zoneA1a), true);
  assert.equal(s.allows(ids.tenantA, ids.siteA1, ids.zoneA1b), false, 'sibling zone A1b not covered');
});

test('own vs scope is the alert_access column, independent of the membership role label', async () => {
  const u = await createUser('agent'); // NOT an admin/soc account
  await grant(u.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'scope' });
  const s = await resolveScope(u.id, pool);
  // No username/role exception: role stays 'agent', yet alert_access='scope' widens tenant visibility.
  assert.equal(s.tenantAccess(ids.tenantA), 'scope');
  assert.equal(s.hasRole(ids.tenantA, 'soc'), false, 'alert_access=scope does not imply SOC action capability');
});

test('suspended and archived memberships grant no coverage at all', async () => {
  const suspended = await createUser('agent'); await grant(suspended.id, { tenantId: ids.tenantA, status: 'suspended', alertAccess: 'scope', role: 'soc' });
  const archived = await createUser('agent'); await grant(archived.id, { tenantId: ids.tenantA, status: 'archived', alertAccess: 'scope', role: 'soc' });
  for (const u of [suspended, archived]) {
    const s = await resolveScope(u.id, pool);
    assert.equal(s.hasAccess, false);
    assert.equal(s.allows(ids.tenantA), false);
  }
});

test('a membership pointing at a suspended tenant grants no coverage even though the membership row itself is active', async () => {
  const tenantId = (await pool.get("INSERT INTO public.tenants(code,name,status) VALUES('tsusp','Suspended tenant','suspended') RETURNING id")).id;
  const u = await createUser('agent');
  await grant(u.id, { tenantId, role: 'soc', alertAccess: 'scope' });
  const s = await resolveScope(u.id, pool);
  assert.equal(s.hasAccess, false, 'the only membership points at a non-active tenant');
});

test('multiple memberships: distinct per-tenant coverage, and the widest alert_access wins within one tenant', async () => {
  const u = await createUser('agent');
  await grant(u.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  await grant(u.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'site_manager', alertAccess: 'scope' });
  await grant(u.id, { tenantId: ids.tenantB, role: 'client_viewer', alertAccess: 'own' });
  const s = await resolveScope(u.id, pool);
  assert.deepEqual([...s.tenantIds].sort(), [ids.tenantA, ids.tenantB].sort());
  assert.equal(s.tenantAccess(ids.tenantA), 'scope', 'widest of own+scope under tenant A is scope');
  assert.equal(s.tenantAccess(ids.tenantB), 'own');
  assert.equal(s.allows(ids.tenantA, ids.siteA2), true, 'the tenant-level grant alone already covers every site under tenant A');
  assert.equal(s.resolveTenant(), null, 'ambiguous without an explicit tenant_id: more than one covered tenant');
  assert.equal(s.resolveTenant(ids.tenantA), ids.tenantA);
  assert.equal(s.resolveTenant(ids.tenantB), ids.tenantB);
});

test('forged tenant/site/zone identifiers never resolve, real ones covered by the membership do', async () => {
  const u = await createUser('agent');
  await grant(u.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'site_manager', alertAccess: 'own' });
  const s = await resolveScope(u.id, pool);
  const forged = '00000000-0000-0000-0000-000000000000';
  assert.equal(s.resolveTenant(forged), null);
  assert.equal(s.allows(forged), false);
  assert.equal(s.allows(ids.tenantA, forged), false, 'a forged site under a covered tenant is still refused');
  assert.equal(s.allows(ids.tenantB, ids.siteA1), false, 'the real site id under the wrong tenant is refused');
  assert.equal(s.resolveTenant(ids.tenantA), ids.tenantA);
});

/* ============================================================ */
/*  HTTP enforcement: routes.js (business) and alerts.js        */
/* ============================================================ */

test('HTTP: a user with no membership is refused on business and Alert Core routes with the stable 403 message, never an empty list', async () => {
  const u = await createUser('agent');
  const token = await login(u.username);
  for (const [method, route] of [['GET', '/incidents'], ['GET', '/pietons'], ['GET', '/visiteurs'], ['GET', '/vehicules'],
    ['GET', '/maincourante'], ['GET', '/employes'], ['GET', '/parametres'], ['GET', '/stats/dashboard'], ['GET', '/alerts']]) {
    const r = await request(method, route, undefined, token);
    assert.equal(r.status, 403, route);
    assert.deepEqual(r.body, { error: 'Accès au périmètre refusé' }, route);
  }
});

test('HTTP: suspended and archived memberships give no operational access even though login still succeeds', async () => {
  for (const status of ['suspended', 'archived']) {
    const u = await createUser('agent');
    await grant(u.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope', status });
    const token = await login(u.username);
    assert.ok(token, 'authentication still succeeds: ' + status);
    assert.equal((await request('GET', '/auth/me', undefined, token)).status, 200, '/me still works: ' + status);
    assert.equal((await request('GET', '/incidents', undefined, token)).status, 403, status);
    assert.equal((await request('GET', '/alerts', undefined, token)).status, 403, status);
  }
});

test('HTTP: an active membership grants business route access and admin endpoints stay role-gated, not scope-gated', async () => {
  const u = await createUser('agent');
  await grant(u.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents', undefined, token)).status, 200);
  assert.equal((await request('GET', '/pietons', undefined, token)).status, 200);
  // /admin/* is account/system administration (role='admin' JWT), not scope: a
  // membership-bearing but non-admin agent is still refused there by role, not scope.
  assert.equal((await request('GET', '/admin/users', undefined, token)).status, 403);
  assert.deepEqual((await request('GET', '/admin/users', undefined, token)).body, { error: 'Accès administrateur requis' });
});

test('HTTP: a forged tenant_id/site_id/zone_id query filter is refused; a covered one passes through', async () => {
  const u = await createUser('agent');
  await grant(u.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'site_manager', alertAccess: 'own' });
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents?tenant_id=' + ids.tenantB, undefined, token)).status, 403, 'foreign tenant forged');
  assert.equal((await request('GET', '/incidents?tenant_id=' + ids.tenantA + '&site_id=' + ids.siteA2, undefined, token)).status, 403, 'sibling site forged');
  assert.equal((await request('GET', '/incidents?tenant_id=' + ids.tenantA + '&site_id=' + ids.siteA1, undefined, token)).status, 200, 'covered tenant+site filter accepted');
  assert.equal((await request('GET', '/incidents?tenant_id=' + ids.tenantA + '&site_id=' + ids.siteA1 + '&zone_id=' + ids.zoneA1a, undefined, token)).status, 200, 'a zone genuinely under the covered site is accepted');
  assert.equal((await request('GET', '/incidents?tenant_id=' + ids.tenantA + '&zone_id=' + ids.zoneA1a, undefined, token)).status, 403, 'a zone id without its covering site_id is refused, never guessed');
});

test('HTTP: Alert Core visibility follows alert_access, SOC actions follow the soc membership role, independently', async () => {
  // agent/scope: sees every alert under the tenant, but still cannot act (not SOC).
  const scopedAgent = await createUser('agent');
  await grant(scopedAgent.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'scope' });
  const scopedToken = await login(scopedAgent.username);
  // own SOC: role=soc but alert_access='own' — can act on alerts (SOC role), but only sees its own.
  const ownSoc = await createUser('agent');
  await grant(ownSoc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'own' });
  const ownSocToken = await login(ownSoc.username);

  const created = (await request('POST', '/alerts', { site: 'A1', type: 'Test', level: 4 }, ownSocToken)).body;
  assert.equal(created.status, 'NOTIFIEE');

  // scope-access agent sees it (not the creator) but cannot act on it (not SOC).
  assert.ok((await request('GET', '/alerts', undefined, scopedToken)).body.some(a => a.id === created.id));
  assert.equal((await request('GET', '/alerts/' + created.id, undefined, scopedToken)).status, 200);
  assert.equal((await request('POST', '/alerts/' + created.id + '/actions', { action: 'ACQUITTEE' }, scopedToken)).status, 403);

  // own SOC created it, so it is visible to its own creator regardless of alert_access,
  // and role=soc lets it act.
  assert.equal((await request('POST', '/alerts/' + created.id + '/actions', { action: 'ACQUITTEE' }, ownSocToken)).status, 200);
});

test('HTTP: an own-only agent neither sees another user\'s alert nor a 403-masking empty list beyond the 403 gate itself', async () => {
  const soc = await createUser('agent'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const socToken = await login(soc.username);
  const own = await createUser('agent'); await grant(own.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const ownToken = await login(own.username);

  const bySoc = (await request('POST', '/alerts', { site: 'A1', type: 'Test', level: 4 }, socToken)).body;
  assert.equal((await request('GET', '/alerts/' + bySoc.id, undefined, ownToken)).status, 404, 'own-access agent cannot see another user\'s alert');
  // The agent's own list legitimately returns [] (nothing of theirs exists yet) —
  // this is NOT the 403 masking case: the agent has a real, active membership.
  assert.deepEqual((await request('GET', '/alerts', undefined, ownToken)).body, []);
});
