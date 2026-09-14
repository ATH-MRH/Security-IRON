'use strict';
// PG-3.3A (correctif) — attestation de readiness PostgreSQL strictement read-only et
// fail-closed du démarrage sur toute dérive. Bases PostgreSQL jetables locales uniquement.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, HISTORICAL, ALERT_CORE, PRIVILEGES, RLS_FUNCTIONS } = require('../backend/db/postgresql/readiness');
const { testEnvironment } = require('./helpers/postgres-test-config');

const base = testEnvironment();
const repoRoot = path.resolve(__dirname, '..');
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const name = () => 'securisite_test_pg33a_ready_' + randomBytes(6).toString('hex');
const urlFor = n => { const u = new URL(base.DATABASE_URL); u.pathname = '/' + n; return u.href; };

let root;
before(async () => { root = new Client(db.configuration(base)); await root.connect(); });
after(async () => { if (root) await root.end(); });

// Disposable database, migrations 001/002 applied, dropped after the test.
async function database(t) {
  const n = name();
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(() => root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'));
  const env = { ...base, DATABASE_URL: urlFor(n) };
  await migrate({ directory, migrationEnv: env });
  return { n, env };
}
async function run(env, sql) {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  try { for (const s of [].concat(sql)) await c.query(s); } finally { await c.end(); }
}
async function ready(env, options) {
  const pool = db.createDatabase(env);
  try { return await assertReady(pool, { directory, ...options }); }
  finally { await pool.close(); }
}
const codeIs = expected => e => { assert.equal(e.code, expected, e.message); return true; };

test('assertReady resolves on a freshly migrated database and is read-only', async t => {
  const { env } = await database(t);
  assert.equal(await ready(env), undefined);
  // Read-only: a second pass still resolves and no securisite_meta row was added.
  await ready(env);
  const pool = db.createDatabase(env);
  try {
    const rows = await pool.all('SELECT version FROM securisite_meta.schema_migrations ORDER BY version');
    assert.deepEqual(rows.map(r => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { await pool.close(); }
});

test('assertReady rejects when the migration registry is absent', async t => {
  const { env } = await database(t);
  await run(env, 'DROP SCHEMA securisite_meta CASCADE');
  await assert.rejects(ready(env), codeIs('READINESS_REGISTRY_MISSING'));
});

test('assertReady rejects when the registry table alone is dropped', async t => {
  const { env } = await database(t);
  await run(env, 'DROP TABLE securisite_meta.schema_migrations');
  await assert.rejects(ready(env), codeIs('READINESS_REGISTRY_MISSING'));
});

for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  test(`assertReady rejects when migration version ${version} is missing`, async t => {
    const { env } = await database(t);
    await run(env, `DELETE FROM securisite_meta.schema_migrations WHERE version=${version}`);
    await assert.rejects(ready(env), codeIs('READINESS_MIGRATIONS_MISMATCH'));
  });
}

test('assertReady rejects when a recorded checksum no longer matches the file', async t => {
  const { env } = await database(t);
  await run(env, "UPDATE securisite_meta.schema_migrations SET checksum=repeat('a',64) WHERE version=1");
  await assert.rejects(ready(env), codeIs('READINESS_MIGRATIONS_MISMATCH'));
});

test('assertReady rejects when a recorded migration name no longer matches the file', async t => {
  const { env } = await database(t);
  await run(env, "UPDATE securisite_meta.schema_migrations SET name='000_renamed.sql' WHERE version=2");
  await assert.rejects(ready(env), codeIs('READINESS_MIGRATIONS_MISMATCH'));
});

for (const table of ['users', 'parametres', 'incidents', 'parking_places']) {
  test(`assertReady rejects when historical table ${table} is absent`, async t => {
    const { env } = await database(t);
    await run(env, `DROP TABLE public.${table} CASCADE`);
    await assert.rejects(ready(env), codeIs('READINESS_TABLE_MISSING'));
  });
}

for (const table of ALERT_CORE) {
  test(`assertReady rejects when Alert Core table ${table} is absent`, async t => {
    const { env } = await database(t);
    await run(env, `DROP TABLE public.${table} CASCADE`);
    await assert.rejects(ready(env), e => ['READINESS_TABLE_MISSING', 'ALERT_CONFIG_MISSING'].includes(e.code));
  });
}

test('assertReady rejects when the alert_rules id=1 row is absent', async t => {
  const { env } = await database(t);
  await run(env, 'DELETE FROM public.alert_rules WHERE id=1');
  await assert.rejects(ready(env), codeIs('ALERT_CONFIG_MISSING'));
});

for (const trigger of ['alert_audit_no_mutation', 'alert_audit_no_truncate', 'alert_config_audit_no_mutation', 'alert_config_audit_no_truncate']) {
  const relation = trigger.startsWith('alert_config') ? 'alert_config_audit' : 'alert_audit';
  test(`assertReady rejects when append-only trigger ${trigger} is dropped`, async t => {
    const { env } = await database(t);
    await run(env, `DROP TRIGGER ${trigger} ON public.${relation}`);
    await assert.rejects(ready(env), codeIs('READINESS_AUDIT_GUARD_MISSING'));
  });
  test(`assertReady rejects when append-only trigger ${trigger} is disabled`, async t => {
    const { env } = await database(t);
    await run(env, `ALTER TABLE public.${relation} DISABLE TRIGGER ${trigger}`);
    await assert.rejects(ready(env), codeIs('READINESS_AUDIT_GUARD_MISSING'));
  });
}

test('assertReady rejects when the append-only guard function is absent', async t => {
  const { env } = await database(t);
  await run(env, 'DROP FUNCTION securisite_meta.reject_alert_audit_mutation() CASCADE');
  await assert.rejects(ready(env), codeIs('READINESS_AUDIT_GUARD_MISSING'));
});

test('assertReady rejects a role that lacks a required write privilege, and lists it', async t => {
  const { n, env } = await database(t);
  const role = 'app_' + randomBytes(4).toString('hex');
  await run(env, [
    `CREATE ROLE ${role} LOGIN PASSWORD 'x'`,
    `GRANT CONNECT ON DATABASE "${n}" TO ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT USAGE ON SCHEMA securisite_meta TO ${role}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA securisite_meta TO ${role}`,
    // Satisfy the earlier RLS-helper EXECUTE check too, so this test still
    // exercises the business-table privilege shortfall it targets, not the
    // (equally real, separately tested — see postgres-provisioning-grants.test.js)
    // securisite_meta EXECUTE gap that production actually hit.
    ...RLS_FUNCTIONS.map(fn => `GRANT EXECUTE ON FUNCTION securisite_meta.${fn}() TO ${role}`),
  ]);
  const limited = new URL(env.DATABASE_URL); limited.username = role; limited.password = 'x';
  try {
    await assert.rejects(ready({ ...env, DATABASE_URL: limited.href }), e => {
      assert.equal(e.code, 'READINESS_PRIVILEGE_MISSING');
      assert.match(e.message, /security_alerts:INSERT/);
      return true;
    });
  } finally {
    await run(env, [
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA securisite_meta FROM ${role}`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA securisite_meta FROM ${role}`,
      `REVOKE ALL ON SCHEMA public, securisite_meta FROM ${role}`,
      `REVOKE CONNECT ON DATABASE "${n}" FROM ${role}`,
      `DROP ROLE ${role}`,
    ]);
  }
});

test('assertReady resolves for a role holding exactly the required runtime privileges', async t => {
  const { n, env } = await database(t);
  const role = 'app_' + randomBytes(4).toString('hex');
  // Grant, per table, exactly the verbs the readiness contract declares.
  const grants = Object.entries(PRIVILEGES).map(([table, verbs]) => `GRANT ${verbs} ON public.${table} TO ${role}`);
  await run(env, [
    `CREATE ROLE ${role} LOGIN PASSWORD 'x'`,
    `GRANT CONNECT ON DATABASE "${n}" TO ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT USAGE ON SCHEMA securisite_meta TO ${role}`,
    `GRANT SELECT ON securisite_meta.schema_migrations TO ${role}`,
    ...RLS_FUNCTIONS.map(fn => `GRANT EXECUTE ON FUNCTION securisite_meta.${fn}() TO ${role}`),
    ...grants,
  ]);
  const scoped = new URL(env.DATABASE_URL); scoped.username = role; scoped.password = 'x';
  try {
    assert.equal(await ready({ ...env, DATABASE_URL: scoped.href }), undefined);
  } finally {
    await run(env, [
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
      `REVOKE ALL ON securisite_meta.schema_migrations FROM ${role}`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA securisite_meta FROM ${role}`,
      `REVOKE ALL ON SCHEMA public, securisite_meta FROM ${role}`,
      `REVOKE CONNECT ON DATABASE "${n}" FROM ${role}`,
      `DROP ROLE ${role}`,
    ]);
  }
});

// End-to-end: start() must fail-closed (no listen, no timer) on the same drifts.
function startChild(env, expectCode) {
  const script = `
    const assert = require('node:assert/strict');
    const { app, start } = require(${JSON.stringify(repoRoot + '/server')});
    const db = require(${JSON.stringify(repoRoot + '/backend/database')});
    let listens = 0, timers = 0;
    app.listen = () => { listens++; throw new Error('must not listen'); };
    global.setInterval = () => { timers++; throw new Error('must not schedule'); };
    start({ host: '127.0.0.1', port: 0 }).then(
      () => { console.error('resolved unexpectedly'); process.exitCode = 1; },
      err => { try {
        assert.equal(listens, 0, 'app.listen called');
        assert.equal(timers, 0, 'timer scheduled');
        assert.equal(err && err.code, ${JSON.stringify(expectCode)}, 'code=' + (err && err.code));
      } catch (f) { console.error(f.message); process.exitCode = 1; } })
    .finally(() => db.close().catch(() => {}).finally(() => process.exit(process.exitCode || 0)));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL, PGSSL: 'disable', NODE_ENV: 'test',
           PGHOST: '', PGPORT: '', PGDATABASE: '', PGUSER: '', PGPASSWORD: '' },
  });
  assert.equal(r.signal, null, 'child timed out: ' + (r.stdout + r.stderr));
  return r;
}

for (const [label, sql, code] of [
  ['registry absent', 'DROP SCHEMA securisite_meta CASCADE', 'READINESS_REGISTRY_MISSING'],
  ['version 2 absent', 'DELETE FROM securisite_meta.schema_migrations WHERE version=2', 'READINESS_MIGRATIONS_MISMATCH'],
  ['historical table absent', 'DROP TABLE public.parametres CASCADE', 'READINESS_TABLE_MISSING'],
  ['append-only trigger absent', 'DROP TRIGGER alert_audit_no_mutation ON public.alert_audit', 'READINESS_AUDIT_GUARD_MISSING'],
]) {
  test(`start() fails closed before listen: ${label}`, async t => {
    const { env } = await database(t);
    await run(env, sql);
    const r = startChild(env, code);
    assert.equal(r.status, 0, r.stderr);
  });
}
