'use strict';
// PG-3.3C — la référence incidents.ref est dérivée d'un COUNT(*). Sans sérialisation,
// deux créations simultanées collisionnent sur incidents.ref UNIQUE (23505 -> 500).
// On reproduit d'abord la collision, puis on prouve que le verrou advisory
// transactionnel de POST /api/incidents la supprime, format « INC-<n> » conservé.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_inc_conc_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, agent;

async function request(method, url, body, token = agent) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    await pool.query('INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)',
      ['agent', await bcrypt.hash('agent', 10), 'agent', 'agent']);
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  agent = (await request('POST', '/auth/login', { username: 'agent', password: 'agent' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

// Reproduces the historical bug: COUNT then INSERT ref, with no serialisation.
async function unserialisedCreate(pool, barrier) {
  return pool.transaction(async client => {
    const c = Number((await client.get('SELECT COUNT(*)::int AS c FROM incidents')).c) || 0;
    await barrier;                                         // both transactions have their count now
    await client.query(
      "INSERT INTO incidents (id, ref, datetime, type, gravite, statut) VALUES ($1,$2,now()::text,'x','mineur','ouvert')",
      ['INC-' + randomBytes(4).toString('hex'), 'INC-' + (2026100 + c)]);
    return 'INC-' + (2026100 + c);
  });
}

test('REPRODUCTION: two unserialised COUNT-based inserts collide on incidents.ref UNIQUE (23505)', async () => {
  const pool = db.createDatabase(env);
  try {
    let release;
    const barrier = new Promise(r => { release = r; });
    const a = unserialisedCreate(pool, barrier);
    const b = unserialisedCreate(pool, barrier);
    await new Promise(r => setTimeout(r, 50));            // let both reach the barrier
    release();
    const results = await Promise.allSettled([a, b]);
    const rejected = results.filter(x => x.status === 'rejected');
    assert.equal(rejected.length, 1, 'exactly one insert must fail');
    assert.match(String(rejected[0].reason && rejected[0].reason.message), /duplicate key|unique/i);
    assert.equal(rejected[0].reason && rejected[0].reason.code, '23505');
  } finally { await pool.close(); }
});

test('FIX: many concurrent POST /api/incidents all succeed with distinct INC- references', async () => {
  const N = 12;
  const before = (await request('GET', '/incidents')).body.length;
  const results = await Promise.all(
    Array.from({ length: N }, (_, k) =>
      request('POST', '/incidents', { type: 'Concurrent ' + k, lieu: 'Zone', gravite: 'mineur' })));
  assert.deepEqual([...new Set(results.map(r => r.status))], [200], 'every request returns 200');
  const refs = results.map(r => r.body.ref);
  assert.ok(refs.every(ref => /^INC-\d+$/.test(ref)), 'historical INC-<n> format preserved: ' + JSON.stringify(refs));
  assert.equal(new Set(refs).size, N, 'all references are distinct: ' + JSON.stringify(refs));
  assert.equal((await request('GET', '/incidents')).body.length, before + N);
});

test('FIX: an explicit caller-provided ref still bypasses the counter', async () => {
  const r = await request('POST', '/incidents', { ref: 'CUSTOM-REF-1', type: 'x', lieu: 'z', gravite: 'mineur' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ref, 'CUSTOM-REF-1');
});

test('FIX: the advisory lock is transactional and released after each create', async () => {
  await request('POST', '/incidents', { type: 'lock check', lieu: 'z', gravite: 'mineur' });
  await new Promise(r => setTimeout(r, 20)); // let the pool connection settle back to idle
  // Scope to this test's database: pg_locks is cluster-wide and other suites run in parallel.
  const held = (await db.get(`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype='advisory'
      AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
  `)).n;
  assert.equal(held, 0, 'no advisory lock lingers between requests');
});
