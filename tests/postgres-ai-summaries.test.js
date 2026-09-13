'use strict';
// PG-20 — résumés IA (backend/ai/summaries.js) exposés via HTTP
// (GET /api/alerts/:id/summary, /timeline-summary, /closing-report,
// /shift-summary, GET /api/incidents/:id/summary). Périmètre own/scope déjà
// prouvé en détail pour service.detail/list par tests/postgres-soc.test.js
// (PG-16) et tests/postgres-scope.test.js (PG-8) — non redupliqué ici :
// ce fichier prouve ce que PG-20 ajoute spécifiquement (le contenu/étiquetage
// des résumés, la rédaction défensive, la garde SOC de shift-summary, le
// routage /shift-summary avant /:id) via un provider IA espion déterministe.
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
const dbName = 'securisite_test_ai_summaries_' + randomBytes(6).toString('hex');
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
  const username = 'ai_' + tag();
  const row = await pool.get('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',
    [username, await bcrypt.hash('x', 10), role]);
  return { id: row.id, username };
}
async function grant(userId, { tenantId, role = 'agent', alertAccess = 'own' }) {
  await pool.query('INSERT INTO public.memberships(user_id,tenant_id,role,alert_access) VALUES($1,$2,$3,$4)',
    [userId, tenantId, role, alertAccess]);
}
async function login(username) { return (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token; }

// Spy provider : ne fait aucun appel réseau, capture ce qu'il a réellement
// reçu (pour prouver la rédaction), et ne renvoie PAS lui-même
// generated_by_ai — la garantie doit venir de backend/ai/summaries.js#label,
// jamais d'une confiance dans le provider.
function spyProvider() {
  const calls = [];
  return {
    calls,
    provider: { name: 'spy', async complete(args) { calls.push(args); return { text: 'résumé-espion', provider: 'spy', generatedAt: new Date().toISOString() }; } },
  };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);

  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('ai-a','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('ai-b','Tenant B') RETURNING id")).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});
afterEach(() => ai.resetProvider()); // jamais de provider de test qui fuite d'un test à l'autre

test('GET /alerts/:id/summary is labelled generated_by_ai even when the provider itself never says so', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const created = (await request('POST', '/alerts', { site: 'Site A', type: 'Intrusion', level: 3 }, token)).body;

  const r = await request('GET', '/alerts/' + created.id + '/summary', undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'alert_summary');
  assert.equal(r.body.resource_id, created.id);
  assert.equal(r.body.generated_by_ai, true, 'label() must stamp this itself, never trust the provider');
  assert.equal(r.body.text, 'résumé-espion');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.site, 'Site A');
  assert.equal(calls[0].context.level, 3);
});

test('GET /alerts/:id/timeline-summary only sends the timeline, not the whole alert, to the provider', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const created = (await request('POST', '/alerts', { site: 'Site A', type: 'Intrusion', level: 2 }, token)).body;
  await request('POST', '/alerts/' + created.id + '/actions', { action: 'COMMENTAIRE', comment: 'observation' }, token);

  const r = await request('GET', '/alerts/' + created.id + '/timeline-summary', undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'timeline_summary');
  assert.equal(r.body.generated_by_ai, true);
  assert.deepEqual(Object.keys(calls[0].context).sort(), ['id', 'timeline']);
  assert.ok(calls[0].context.timeline.some(t => t.action === 'COMMENTAIRE'));
});

test('GET /alerts/:id/closing-report is labelled and reflects the current (non-final) status honestly', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const created = (await request('POST', '/alerts', { site: 'Site A', type: 'Intrusion', level: 2 }, token)).body;

  const r = await request('GET', '/alerts/' + created.id + '/closing-report', undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'closing_report');
  assert.equal(r.body.generated_by_ai, true);
  assert.equal(calls[0].context.status, 'NOTIFIEE'); // pas encore clôturée : le contexte le montre tel quel
});

test('an own-access agent cannot summarize another tenant\'s alert: same 404 as service.detail elsewhere', async () => {
  const socA = await createUser('admin'); await grant(socA.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const tokenA = await login(socA.username);
  const socB = await createUser('admin'); await grant(socB.id, { tenantId: ids.tenantB, role: 'soc', alertAccess: 'scope' });
  const tokenB = await login(socB.username);
  const createdB = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 2 }, tokenB)).body;

  const r = await request('GET', '/alerts/' + createdB.id + '/summary', undefined, tokenA);
  assert.equal(r.status, 404);
});

test('GET /alerts/shift-summary is reserved to the SOC (scope alert_access + soc role), 403 for an own agent', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(agent.username);
  assert.equal((await request('GET', '/alerts/shift-summary', undefined, token)).status, 403);
});

test('GET /alerts/shift-summary aggregates only recent, real alerts and is routed before /:id', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  await request('POST', '/alerts', { site: 'Site X', type: 'T', level: 4 }, token); // SOS
  await request('POST', '/alerts', { site: 'Site X', type: 'T', level: 1 }, token);

  const r = await request('GET', '/alerts/shift-summary', undefined, token);
  assert.equal(r.status, 200, 'never captured by GET /:id as a literal alert id');
  assert.equal(r.body.kind, 'shift_summary');
  assert.equal(r.body.generated_by_ai, true);
  assert.ok(calls[0].context.total >= 2);
  assert.ok(calls[0].context.sos >= 1);
});

test('GET /incidents/:id/summary works for an existing incident and 404s honestly for a missing one', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(agent.username);
  const created = (await request('POST', '/incidents', { type: 'Intrusion', lieu: 'Zone A', gravite: 'mineur' }, token)).body;

  const ok = await request('GET', '/incidents/' + created.id + '/summary', undefined, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.kind, 'incident_summary');
  assert.equal(ok.body.generated_by_ai, true);

  const missing = await request('GET', '/incidents/does-not-exist/summary', undefined, token);
  assert.equal(missing.status, 404);
});

test('a secret-looking value in a free-text field is redacted before it ever reaches the provider', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const created = (await request('POST', '/alerts', {
    site: 'S', type: 'T', level: 2, comment: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  }, token)).body;

  await request('GET', '/alerts/' + created.id + '/summary', undefined, token);
  assert.equal(calls[0].context.comment, '[retiré]');
});
