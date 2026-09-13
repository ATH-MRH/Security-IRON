'use strict';
// PG-22 — GET /api/alerts/correlations (backend/ai/correlation.js). Pure
// signal logic already covered by tests/ai-correlation.test.js — this file
// proves what only a real HTTP+PostgreSQL round-trip can: tenant isolation
// of the evidence, the SOC-only gate, route ordering, and labelling.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const ai = require('../backend/ai/provider');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_ai_correlation_' + randomBytes(6).toString('hex');
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
  const username = 'corr_' + tag();
  const row = await pool.get('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',
    [username, await bcrypt.hash('x', 10), role]);
  return { id: row.id, username };
}
async function grant(userId, { tenantId, role = 'agent', alertAccess = 'own' }) {
  await pool.query('INSERT INTO public.memberships(user_id,tenant_id,role,alert_access) VALUES($1,$2,$3,$4)',
    [userId, tenantId, role, alertAccess]);
}
async function login(username) { return (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token; }

function spyProvider() {
  const calls = [];
  return { calls, provider: { name: 'spy', async complete(args) { calls.push(args); return { text: 'synthèse-espion', provider: 'spy', generatedAt: new Date().toISOString() }; } } };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('corr-a','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('corr-b','Tenant B') RETURNING id")).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});
afterEach(() => ai.resetProvider());

test('GET /alerts/correlations is reserved to the SOC, 403 for an own agent', async () => {
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(agent.username);
  assert.equal((await request('GET', '/alerts/correlations', undefined, token)).status, 403);
});

test('never captured as a literal alert id: routed before GET /:id', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const r = await request('GET', '/alerts/correlations', undefined, token);
  assert.equal(r.status, 200);
});

test('signals and their evidence never include another tenant\'s alerts', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const socA = await createUser('admin'); await grant(socA.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const tokenA = await login(socA.username);
  const socB = await createUser('admin'); await grant(socB.id, { tenantId: ids.tenantB, role: 'soc', alertAccess: 'scope' });
  const tokenB = await login(socB.username);
  // Same site+type twice under tenant B — would surely correlate for B, must be invisible to A.
  await request('POST', '/alerts', { site: 'Shared-name Site', type: 'Sabotage', level: 3 }, tokenB);
  await request('POST', '/alerts', { site: 'Shared-name Site', type: 'Sabotage', level: 3 }, tokenB);

  const r = await request('GET', '/alerts/correlations', undefined, tokenA);
  assert.equal(r.status, 200);
  const allIds = r.body.signals.flatMap(s => s.evidence.map(e => e.id));
  const bTenantAlerts = (await request('GET', '/alerts?tenant_id=' + ids.tenantB, undefined, tokenB)).body.map(a => a.id);
  assert.ok(!allIds.some(id => bTenantAlerts.includes(id)), 'tenant A never sees tenant B\'s evidence');
  // The provider context (what would transit to a future real fournisseur,
  // after checkpoint) is built from the same tenant-scoped rows — must
  // never mention tenant B's site name either.
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls[0].context), /Shared-name Site/);
});

test('a repeated site+type pattern within tenant A is detected with exact, verifiable evidence', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const a = (await request('POST', '/alerts', { site: 'Depot Nord', type: 'Intrusion', level: 3 }, token)).body;
  const b = (await request('POST', '/alerts', { site: 'Depot Nord', type: 'Intrusion', level: 3 }, token)).body;

  const r = await request('GET', '/alerts/correlations', undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.generated_by_ai, true);
  const s = r.body.signals.find(x => x.kind === 'repeated_alerts_same_site_type' && x.site === 'Depot Nord');
  assert.ok(s, 'the repeated pattern is detected');
  assert.deepEqual(s.evidence.map(e => e.id).sort(), [a.id, b.id].sort());
  assert.ok(calls.length >= 1);
});

test('no signal, no evidence item ever carries created_by/username, even serialised', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  await request('POST', '/alerts', { site: 'Depot Sud', type: 'Effraction', level: 3 }, token);
  await request('POST', '/alerts', { site: 'Depot Sud', type: 'Effraction', level: 3 }, token);

  const r = await request('GET', '/alerts/correlations', undefined, token);
  assert.doesNotMatch(JSON.stringify(r.body.signals), /created_by|username/);
});

test('an invalid window_minutes is refused (400), never silently clamped', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  assert.equal((await request('GET', '/alerts/correlations?window_minutes=0', undefined, token)).status, 400);
  assert.equal((await request('GET', '/alerts/correlations?window_minutes=abc', undefined, token)).status, 400);
});
