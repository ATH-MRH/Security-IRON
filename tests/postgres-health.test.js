'use strict';
// PG-18 — GET /api/health (liveness) et GET /api/ready (readiness),
// backend/health.js : deux sondes distinctes, non authentifiées, jamais un
// détail technique renvoyé.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_health_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base;

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('GET /api/health never requires authentication and always answers ok while the process is up', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
});

test('GET /api/ready never requires authentication and confirms a real PostgreSQL round-trip', async () => {
  const r = await fetch(base + '/api/ready');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ready' });
});

test('GET /api/health and /api/ready reveal no PostgreSQL/technical detail in their body', async () => {
  const health = await (await fetch(base + '/api/health')).text();
  const ready = await (await fetch(base + '/api/ready')).text();
  for (const body of [health, ready]) {
    assert.doesNotMatch(body, /postgres|password|DATABASE_URL|relation|SELECT/i);
  }
});

test('an Authorization header is accepted but never required on either probe', async () => {
  const r = await fetch(base + '/api/health', { headers: { Authorization: 'Bearer not-a-real-token' } });
  assert.equal(r.status, 200);
});

// Doit rester le DERNIER test du fichier : ferme réellement le pool
// PostgreSQL du processus (même singleton que backend/database.js, partagé
// par tout ce fichier de test) pour simuler une panne survenue APRÈS un
// démarrage réussi — server.js#start() refuse déjà de démarrer sans base
// (readiness bloquante), donc le seul moyen honnête de prouver le 503 est
// une vraie coupure après coup, pas une configuration invalide au boot.
test('GET /api/ready returns 503 with no technical detail once PostgreSQL becomes unreachable', async () => {
  await db.close();
  const r = await fetch(base + '/api/ready');
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: 'unavailable' });
});
