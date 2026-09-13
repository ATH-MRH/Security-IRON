'use strict';
// PG-16 — SOC nouvelle génération : ce fichier couvre spécifiquement ce que
// PG-16 ajoute côté serveur — tenant/site/zone désormais acceptés (et un
// forgé refusé) sur les routes Alert Core elles-mêmes (backend/alerts.js
// utilise maintenant scope.requireScope(), comme backend/routes.js depuis
// PG-8) — et une preuve de correction à un volume raisonnable. Le reste
// (SSE, push, SOS, own/scope de base) est déjà prouvé par
// tests/postgres-realtime.test.js (PG-12), tests/postgres-push.test.js
// (PG-13), tests/postgres-sos.test.js (PG-15) et tests/postgres-scope.test.js
// (PG-8) — non dupliqué ici.
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
const dbName = 'securisite_test_soc_' + randomBytes(6).toString('hex');
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
  const username = 'soc_' + tag();
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

  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('soc-a','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('soc-b','Tenant B') RETURNING id")).id;
  ids.siteA1 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'a1','Site A1') RETURNING id", [ids.tenantA])).id;
  ids.siteA2 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'a2','Site A2') RETURNING id", [ids.tenantA])).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('SOC tenant A never sees tenant B\'s alerts, even via GET /alerts?tenant_id= explicitly scoped to A', async () => {
  const socA = await createUser('admin'); await grant(socA.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const socB = await createUser('admin'); await grant(socB.id, { tenantId: ids.tenantB, role: 'soc', alertAccess: 'scope' });
  const tokenA = await login(socA.username), tokenB = await login(socB.username);

  const alertB = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, tokenB)).body;
  const listA = (await request('GET', '/alerts?tenant_id=' + ids.tenantA, undefined, tokenA)).body;
  assert.ok(!listA.some(a => a.id === alertB.id), 'tenant A never sees a tenant B alert');
  assert.equal((await request('GET', '/alerts?tenant_id=' + ids.tenantB, undefined, tokenA)).status, 403, 'A cannot even request B\'s tenant filter');
});

test('an own-access agent stays limited to their own alerts regardless of any tenant/site filter supplied', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const socToken = await login(soc.username);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const agentToken = await login(agent.username);

  const bySoc = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, socToken)).body;
  const list = (await request('GET', '/alerts?tenant_id=' + ids.tenantA, undefined, agentToken)).body;
  assert.ok(!list.some(a => a.id === bySoc.id), 'own agent never sees another user\'s alert, filter or not');
});

test('a site-level membership can filter GET /alerts by its own covered site_id, and is refused a sibling one', async () => {
  const user = await createUser('agent');
  await grant(user.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'site_manager', alertAccess: 'own' });
  const token = await login(user.username);
  assert.equal((await request('GET', '/alerts?tenant_id=' + ids.tenantA + '&site_id=' + ids.siteA1, undefined, token)).status, 200);
  assert.equal((await request('GET', '/alerts?tenant_id=' + ids.tenantA + '&site_id=' + ids.siteA2, undefined, token)).status, 403, 'sibling site A2 is not covered');
});

test('a forged tenant_id on POST /alerts/:id/actions and POST /alerts/sos is refused the same way', async () => {
  const user = await createUser('agent'); await grant(user.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(user.username);
  assert.equal((await request('POST', '/alerts/sos?tenant_id=' + ids.tenantB, {}, token)).status, 403);
  const created = (await request('POST', '/alerts/sos', {}, token)).body;
  assert.equal((await request('POST', '/alerts/' + created.id + '/actions?tenant_id=' + ids.tenantB, { action: 'COMMENTAIRE', comment: 'x' }, token)).status, 403);
});

test('a real, active SOS shows up in GET /alerts with origin=SOS, feeding the SOC dashboard KPIs correctly', async () => {
  const user = await createUser('agent'); await grant(user.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(user.username);
  const sos = (await request('POST', '/alerts/sos', {}, token)).body;
  const list = (await request('GET', '/alerts', undefined, token)).body;
  const found = list.find(a => a.id === sos.id);
  assert.ok(found);
  assert.equal(found.level, 4);
  assert.equal(found.origin, 'SOS');
  assert.equal(found.status, 'NOTIFIEE'); // unacknowledged, exactly what the SOC "non acquittées" KPI counts
});

test('a reasonable large volume (400 alerts) still lists correctly and quickly enough for a live dashboard', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const N = 400;
  for (let i = 0; i < N; i++) {
    await pool.query(`
      INSERT INTO public.security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,equipment,policy,tenant_id)
      VALUES($1,now()::text,now()::text,$2,'Z','T',$3,'COMMAND',$4,'bulk','NOTIFIEE','',$5,'[30,60,120]',$6)`,
      ['ALT-BULK-' + i, 'Site ' + (i % 6), (i % 4) + 1, soc.id, i % 5 === 0 ? ('badge:B' + i) : '', ids.tenantA]);
  }
  const start = Date.now();
  const r = await request('GET', '/alerts?tenant_id=' + ids.tenantA, undefined, token);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= N);
  assert.ok(elapsed < 3000, 'GET /alerts over ' + N + ' rows took ' + elapsed + 'ms — unreasonably slow for a live dashboard');
});
