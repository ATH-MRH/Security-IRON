'use strict';
// PG-17 — cartographie : GET /api/map/sites et GET /api/map/zones (lecture
// seule, backend/map.js). Isolation tenant/site/zone déjà prouvée en détail
// pour la même architecture de périmètre par tests/postgres-soc.test.js
// (PG-16) et tests/postgres-scope.test.js (PG-8) — ce fichier couvre
// spécifiquement ce que backend/map.js ajoute : filtrage des coordonnées de
// site par périmètre couvert, absence de zone géolocalisée (aucune donnée
// inventée), et l'intersection RLS/applicative n'entraîne aucune fuite.
// RLS elle-même (sites/zones comptent parmi les 5 tables protégées) reste
// prouvée génériquement par tests/postgres-rls.test.js — non dupliqué ici.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_map_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(5).toString('hex');

let root, pool, stop, base;
const ids = {};

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function createUser(role = 'agent') {
  const username = 'map_' + tag();
  const row = await pool.get('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',
    [username, await bcrypt.hash('x', 10), role]);
  return { id: row.id, username };
}
async function grant(userId, { tenantId, siteId = null, zoneId = null, role = 'agent', alertAccess = 'own' }) {
  await pool.query('INSERT INTO public.memberships(user_id,tenant_id,site_id,zone_id,role,alert_access) VALUES($1,$2,$3,$4,$5,$6)',
    [userId, tenantId, siteId, zoneId, role, alertAccess]);
}
async function login(username) { return (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token; }

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);

  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('map-a','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('map-b','Tenant B') RETURNING id")).id;
  ids.siteA1 = (await pool.get(
    "INSERT INTO public.sites(tenant_id,code,name,latitude,longitude) VALUES($1,'a1','Site A1',36.75,3.04) RETURNING id", [ids.tenantA])).id;
  ids.siteA2 = (await pool.get(
    "INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'a2','Site A2') RETURNING id", [ids.tenantA])).id; // pas de GPS
  ids.siteB1 = (await pool.get(
    "INSERT INTO public.sites(tenant_id,code,name,latitude,longitude) VALUES($1,'b1','Site B1',48.85,2.35) RETURNING id", [ids.tenantB])).id;
  ids.zoneA1a = (await pool.get(
    "INSERT INTO public.zones(site_id,tenant_id,code,name,kind) VALUES($1,$2,'entree','Entrée principale','access_point') RETURNING id",
    [ids.siteA1, ids.tenantA])).id;
  ids.zoneA2a = (await pool.get(
    "INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'parc','Parking') RETURNING id",
    [ids.siteA2, ids.tenantA])).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('a tenant-scope user sees every active site/zone of its own tenant, never another tenant\'s', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);

  const sites = (await request('GET', '/map/sites?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.deepEqual(sites.map(s => s.code).sort(), ['a1', 'a2']);
  assert.ok(!sites.some(s => s.code === 'b1'), 'tenant A never sees tenant B\'s site');
  const a1 = sites.find(s => s.code === 'a1');
  assert.equal(a1.latitude, 36.75); assert.equal(a1.longitude, 3.04);
  const a2 = sites.find(s => s.code === 'a2');
  assert.equal(a2.latitude, null); assert.equal(a2.longitude, null); // aucune position inventée

  const zones = (await request('GET', '/map/zones?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.deepEqual(zones.map(z => z.code).sort(), ['entree', 'parc']);
});

test('tenant B cannot even request tenant A\'s map filter', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantB, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  assert.equal((await request('GET', '/map/sites?tenant_id=' + ids.tenantA, undefined, token)).status, 403);
  assert.equal((await request('GET', '/map/zones?tenant_id=' + ids.tenantA, undefined, token)).status, 403);
});

test('a site-level membership only sees its own covered site and zone on the map, never the sibling one', async () => {
  const user = await createUser('agent');
  await grant(user.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'site_manager', alertAccess: 'own' });
  const token = await login(user.username);

  const sites = (await request('GET', '/map/sites?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.deepEqual(sites.map(s => s.code), ['a1']);
  const zones = (await request('GET', '/map/zones?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.deepEqual(zones.map(z => z.code), ['entree']);
});

test('a zone-level membership only sees its own covered zone, not a sibling zone of the same site', async () => {
  const otherZone = (await pool.get(
    "INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'quai','Quai livraison') RETURNING id",
    [ids.siteA1, ids.tenantA])).id;
  const user = await createUser('agent');
  await grant(user.id, { tenantId: ids.tenantA, siteId: ids.siteA1, zoneId: ids.zoneA1a, role: 'agent', alertAccess: 'own' });
  const token = await login(user.username);
  const zones = (await request('GET', '/map/zones?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.deepEqual(zones.map(z => z.id), [ids.zoneA1a]);
  assert.ok(!zones.some(z => z.id === otherZone));
});

test('a zone-level membership still sees the site that contains its zone (never floats with no site), but no sibling site', async () => {
  // memberships.scope is GENERATED from zone_id/site_id (migration 004) : a
  // zone-scoped membership never satisfies the 'site' or 'tenant' coverage
  // req.scope.allows(tenantId, siteId, null) checks for — without the
  // dedicated fallback in backend/map.js, this user would see zero sites.
  const user = await createUser('agent');
  await grant(user.id, { tenantId: ids.tenantA, siteId: ids.siteA1, zoneId: ids.zoneA1a, role: 'agent', alertAccess: 'own' });
  const token = await login(user.username);
  const sites = (await request('GET', '/map/sites?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.deepEqual(sites.map(s => s.code), ['a1'], 'sees a1 (its zone\'s parent site), never a2');
});

test('no membership at all: 403, same as every other scoped route', async () => {
  const user = await createUser('agent');
  const token = await login(user.username);
  assert.equal((await request('GET', '/map/sites', undefined, token)).status, 403);
  assert.equal((await request('GET', '/map/zones', undefined, token)).status, 403);
});

test('an archived site/zone is never listed on the map', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  // archived_at requis avec status='archived' depuis la migration 015
  // (Administration Système) — sites_archived_at_chk.
  const archivedSite = (await pool.get(
    "INSERT INTO public.sites(tenant_id,code,name,status,archived_at) VALUES($1,'old','Ancien site','archived',now()) RETURNING id", [ids.tenantA])).id;
  const sites = (await request('GET', '/map/sites?tenant_id=' + ids.tenantA, undefined, token)).body;
  assert.ok(!sites.some(s => s.id === archivedSite));
});
