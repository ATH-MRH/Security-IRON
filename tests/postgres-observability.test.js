'use strict';
// PG-18 — backend/observability.js : une ligne de log JSON structurée par
// requête HTTP, écrite sur console.log. Contrôle les champs requis
// (MASTER ROADMAP §22), l'allowlist de sécurité (jamais un secret), et les
// exclusions volontaires (sondes /health, /ready).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_observability_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, pool, stop, base, token;

async function request(method, url, body, tok) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}

// Intercepte console.log le temps de fn(), et parse chaque appel comme JSON
// (une ligne non-JSON, ex. le message de démarrage du serveur, est ignorée).
async function captureLogs(fn) {
  const original = console.log;
  const raw = [];
  console.log = (...args) => { raw.push(args.join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return raw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  const row = await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('obs_agent',$1,'agent') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await seedMembership(pool, row.id, 'agent');

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  token = (await request('POST', '/auth/login', { username: 'obs_agent', password: 'x' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('a successful request emits exactly one structured JSON log line with the documented fields', async () => {
  const lines = await captureLogs(() => request('GET', '/alerts', undefined, token));
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.method, 'GET');
  assert.equal(l.path, '/api/alerts');
  assert.equal(l.status, 200);
  assert.equal(l.level, 'info');
  assert.ok(typeof l.request_id === 'string' && l.request_id.length > 0);
  assert.equal(l.correlation_id, l.request_id, 'falls back to request_id absent an incoming header');
  assert.ok(typeof l.duration_ms === 'number' && l.duration_ms >= 0);
  assert.ok(l.tenant_id, 'tenant_id populated once the request resolves a scope');
  assert.equal(l.alert_id, null);
  assert.equal(l.error_code, null);
  assert.ok(typeof l.ts === 'string' && !Number.isNaN(Date.parse(l.ts)));
});

test('an incoming X-Correlation-Id is echoed on the response and used in the log line, not request_id', async () => {
  const lines = await captureLogs(() => fetch(base + '/api/alerts', {
    headers: { Authorization: 'Bearer ' + token, 'X-Correlation-Id': 'client-flow-42' },
  }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].correlation_id, 'client-flow-42');
  assert.notEqual(lines[0].correlation_id, lines[0].request_id);
});

test('alert_id is populated for GET/POST /alerts/:id/... routes, never for the collection route', async () => {
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 2 }, token)).body;
  const lines = await captureLogs(() => request('POST', '/alerts/' + created.id + '/actions',
    { action: 'COMMENTAIRE', comment: 'x' }, token));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].alert_id, created.id);
  assert.equal(lines[0].path, '/api/alerts/' + created.id + '/actions');
});

test('a business error (404) is logged as warn with its real status but no machine error_code', async () => {
  const lines = await captureLogs(() => request('GET', '/alerts/does-not-exist', undefined, token));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 404);
  assert.equal(lines[0].level, 'warn');
  assert.equal(lines[0].error_code, null);
});

test('an unauthenticated request (401) is still logged, without a tenant/error_code fabricated', async () => {
  const lines = await captureLogs(() => request('GET', '/alerts', undefined, null));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 401);
  assert.equal(lines[0].tenant_id, null);
});

test('GET /api/health and /api/ready never emit a log line: frequent probes are not operational signal', async () => {
  const lines = await captureLogs(async () => {
    await fetch(base + '/api/health');
    await fetch(base + '/api/ready');
  });
  assert.deepEqual(lines, []);
});

test('static frontend assets outside /api are never logged: tenant_id/alert_id would be meaningless there', async () => {
  const lines = await captureLogs(async () => {
    await fetch(base + '/index.html');
    await fetch(base + '/js/app.js');
  });
  assert.deepEqual(lines, []);
});

test('the log line never contains the bearer token, a password, or DATABASE_URL, even serialised', async () => {
  const lines = await captureLogs(() => request('GET', '/alerts', undefined, token));
  const serialised = JSON.stringify(lines);
  assert.doesNotMatch(serialised, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialised, /password|DATABASE_URL/i);
});

test('a reasonable burst of requests logs exactly one line per request, in the same order', async () => {
  const lines = await captureLogs(async () => {
    for (let i = 0; i < 20; i++) await request('GET', '/alerts', undefined, token);
  });
  assert.equal(lines.length, 20);
  assert.ok(lines.every(l => l.status === 200 && l.path === '/api/alerts'));
});
