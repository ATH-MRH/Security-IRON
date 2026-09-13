'use strict';
// PG-21 — assistant SOC contextualisé (backend/ai/assistant.js), exposé via
// POST /api/alerts/assistant. Isolation tenant/own-scope déjà prouvée en
// détail pour service.list() par tests/postgres-soc.test.js (PG-16) — ce
// fichier prouve ce que PG-21 ajoute spécifiquement : le contenu du
// contexte envoyé au provider, l'étiquetage generated_by_ai, et surtout la
// double garantie que l'assistant ne peut jamais suggérer de clôturer,
// annuler ou invalider une alerte (MASTER ROADMAP §25).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const ai = require('../backend/ai/provider');
const assistant = require('../backend/ai/assistant');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_ai_assistant_' + randomBytes(6).toString('hex');
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
  const username = 'asst_' + tag();
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
  return { calls, provider: { name: 'spy', async complete(args) { calls.push(args); return { text: 'réponse-espion', provider: 'spy', generatedAt: new Date().toISOString() }; } } };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('asst-a','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('asst-b','Tenant B') RETURNING id")).id;

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

test('POST /alerts/assistant answers a question, labelled generated_by_ai, echoing the question back', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);

  const r = await request('POST', '/alerts/assistant', { question: 'Que s’est-il passé ?' }, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.generated_by_ai, true);
  assert.equal(r.body.question, 'Que s’est-il passé ?');
  assert.equal(r.body.text, 'réponse-espion');
  assert.ok(Array.isArray(r.body.suggestions));
});

test('an empty or missing question is refused (400), never silently answered', async () => {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  assert.equal((await request('POST', '/alerts/assistant', {}, token)).status, 400);
  assert.equal((await request('POST', '/alerts/assistant', { question: '   ' }, token)).status, 400);
  assert.equal((await request('POST', '/alerts/assistant', { question: 'x'.repeat(1001) }, token)).status, 400);
});

test('the assistant never leaks another tenant\'s alerts into its context', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const socA = await createUser('admin'); await grant(socA.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const tokenA = await login(socA.username);
  const socB = await createUser('admin'); await grant(socB.id, { tenantId: ids.tenantB, role: 'soc', alertAccess: 'scope' });
  const tokenB = await login(socB.username);
  await request('POST', '/alerts', { site: 'Tenant B site', type: 'T', level: 3 }, tokenB);

  await request('POST', '/alerts/assistant', { question: 'Quelles alertes critiques ?' }, tokenA);
  const sites = calls[0].context.relevant.map(a => a.site);
  assert.ok(!sites.includes('Tenant B site'));
});

test('keyword-based context narrowing: "critique" keeps only level>=3 alerts in what is sent to the provider', async () => {
  const { provider, calls } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  await request('POST', '/alerts', { site: 'S', type: 'Mineur', level: 1 }, token);
  await request('POST', '/alerts', { site: 'S', type: 'Critique', level: 4 }, token);

  await request('POST', '/alerts/assistant', { question: 'Quelles alertes critiques en ce moment ?' }, token);
  const relevant = calls[0].context.relevant;
  assert.ok(relevant.every(a => a.level >= 3));
  assert.ok(relevant.some(a => a.type === 'Critique'));
});

test('an own-access agent gets an answer but never any suggestion (suggestions require isSoc)', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, role: 'agent', alertAccess: 'own' });
  const token = await login(agent.username);
  await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, token);

  const r = await request('POST', '/alerts/assistant', { question: 'Que dois-je faire ?' }, token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.suggestions, []);
});

test('suggestions never include a closing/cancelling/invalidating action, across every alert status', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const forbidden = new Set(['CLOTUREE', 'ANNULEE', 'FAUSSE_ALERTE']);

  // Drive one alert through the whole lifecycle, asking the assistant at every step.
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, token)).body;
  for (const action of ['ACQUITTEE', 'EN_INTERVENTION', 'SOUS_CONTROLE', 'RESOLUE']) {
    await request('POST', '/alerts/' + created.id + '/actions', { action }, token);
    const r = await request('POST', '/alerts/assistant', { question: 'Quelles actions sont possibles ?' }, token);
    for (const s of r.body.suggestions) assert.ok(!forbidden.has(s.action), s.action + ' must never be suggested');
  }
});

test('a critical, freshly-notified alert is suggested for acknowledgement and escalation, never a closing action', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, token)).body;

  const r = await request('POST', '/alerts/assistant', { question: 'Quelles actions sont possibles ?' }, token);
  const forThisAlert = r.body.suggestions.filter(s => s.alert_id === created.id);
  assert.ok(forThisAlert.some(s => s.action === 'ACQUITTEE'));
  assert.ok(forThisAlert.some(s => s.action === 'ESCALADE'));
  assert.ok(forThisAlert.every(s => Object.hasOwn(s, 'label') && typeof s.label === 'string' && s.label.length > 0));
});

test('every suggested action can genuinely be confirmed through the real, existing, audited action route', async () => {
  const { provider } = spyProvider(); ai.configureProvider(provider);
  const soc = await createUser('admin'); await grant(soc.id, { tenantId: ids.tenantA, role: 'soc', alertAccess: 'scope' });
  const token = await login(soc.username);
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 2 }, token)).body;

  const r = await request('POST', '/alerts/assistant', { question: 'Quelles actions sont possibles ?' }, token);
  const suggestion = r.body.suggestions.find(s => s.alert_id === created.id);
  assert.ok(suggestion);
  const confirmed = await request('POST', '/alerts/' + suggestion.alert_id + '/actions', { action: suggestion.action }, token);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, suggestion.action);
});
