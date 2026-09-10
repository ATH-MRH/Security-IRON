'use strict';
// PG-3.3A — ordered startup, read-only PostgreSQL readiness and minimal graceful shutdown.
// Disposable local database only; no production access.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment } = require('./helpers/postgres-test-config');

const base = testEnvironment();
const repoRoot = path.resolve(__dirname, '..');
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const suffix = () => 'securisite_test_pg33a_start_' + randomBytes(6).toString('hex');
const urlFor = n => { const u = new URL(base.DATABASE_URL); u.pathname = '/' + n; return u.href; };

let root;
before(async () => { root = new Client(db.configuration(base)); await root.connect(); });
after(async () => { if (root) await root.end(); });

// A fresh database dropped after the test. `migrated` also applies 001/002 and seeds an admin.
async function database(t, { migrated = true } = {}) {
  const n = suffix();
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(() => root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'));
  const env = { ...base, DATABASE_URL: urlFor(n) };
  if (migrated) {
    await migrate({ directory, migrationEnv: env });
    const pool = db.createDatabase(env);
    try {
      await pool.query('INSERT INTO public.users(id,username,password_hash,nom_complet,role) VALUES($1,$2,$3,$4,$5)',
        [1, 'admin', await bcrypt.hash('securisite', 10), 'admin', 'admin']);
    } finally { await pool.close(); }
  }
  return env;
}

// Child process: prove start() rejects before app.listen and before the escalation timer.
function refusedStartup(env, check) {
  const script = `
    const assert = require('node:assert/strict');
    const { app, start } = require('./server');
    let listens = 0, timers = 0;
    app.listen = () => { listens++; throw new Error('must not listen'); };
    const realSetInterval = global.setInterval;
    global.setInterval = (...a) => { timers++; throw new Error('must not schedule'); };
    start({ host: '127.0.0.1', port: 0 }).then(
      () => { console.error('start() resolved unexpectedly'); process.exitCode = 1; },
      err => {
        try {
          assert.equal(listens, 0, 'app.listen was called');
          assert.equal(timers, 0, 'a timer was scheduled');
          assert.ok(${check}, 'unexpected error: ' + (err && (err.code || err.message)));
        } catch (failure) { console.error(failure.message); process.exitCode = 1; }
      },
    );
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL, PGSSL: 'disable', NODE_ENV: 'test' },
    encoding: 'utf8',
  });
}

test('readiness: a missing Alert Core schema is refused before any listen or timer', async t => {
  const env = await database(t, { migrated: false });
  const result = refusedStartup(env, "err.code === 'ALERT_SCHEMA_UNAVAILABLE'");
  assert.equal(result.status, 0, result.stderr);
});

test('readiness: a missing configuration row is refused before any listen or timer', async t => {
  const env = await database(t);
  const pool = db.createDatabase(env);
  try { await pool.query('DELETE FROM public.alert_rules'); } finally { await pool.close(); }
  const result = refusedStartup(env, "err.code === 'ALERT_CONFIG_MISSING'");
  assert.equal(result.status, 0, result.stderr);
});

test('readiness: an unreachable database is refused before any listen or timer', async t => {
  const env = await database(t);
  const unreachable = { DATABASE_URL: (u => (u.port = '1', u.href))(new URL(env.DATABASE_URL)) };
  const result = refusedStartup(unreachable, "/Connexion PostgreSQL impossible/.test(err.message)");
  assert.equal(result.status, 0, result.stderr);
});

test('healthy startup listens, then stop() closes the listener and the pool and is idempotent', async t => {
  const env = await database(t);
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  const origin = 'http://127.0.0.1:' + started.port;
  assert.equal((await fetch(origin + '/api/alerts')).status, 401);      // listening, JWT still enforced
  await started.stop();
  await assert.rejects(fetch(origin + '/api/alerts'));                  // listener closed
  await started.stop();                                                 // idempotent, no throw
  await assert.rejects(db.query('SELECT 1'), /Pool PostgreSQL fermé/);  // pool closed by stop()
});
