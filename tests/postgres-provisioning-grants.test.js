'use strict';
// Reproduit puis corrige le vrai incident production (premier déploiement
// Coolify) : APP sans USAGE sur securisite_meta, sans SELECT sur
// securisite_meta.schema_migrations, sans EXECUTE sur les fonctions RLS —
// alors que /api/ready répondait "sain" (readiness.js ne vérifiait aucun de
// ces trois privilèges). Cause racine : les migrations s'exécutent
// connectées comme MIGRATOR (jamais `SET ROLE owner`, interdit par
// migrate.js#validateSQL), donc seul un second passage MANUEL de
// provision-roles.js (avec le superutilisateur, après les migrations)
// restaurait ces GRANT à APP — facile à oublier.
//
// Cette suite : (1) reproduit exactement le 42501 avec seulement `migrate()`
// (sans le second passage) ; (2) vérifie que `finalizeGrants` — appelé
// automatiquement par migrate-cli.js, avec la seule connexion MIGRATOR,
// jamais de superuser — ferme ce trou ; (3) vérifie que readiness.js détecte
// désormais lui-même un déploiement cassé (fail-closed) ; (4) vérifie le CLI
// de création du premier administrateur consolidé (sans bash).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, RLS_FUNCTIONS } = require('../backend/db/postgresql/readiness');
const { apply, finalizeGrants } = require('../backend/db/postgresql/provision-roles');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const tag = () => randomBytes(5).toString('hex');
const rejects42501 = (p, pattern) => assert.rejects(p, e => {
  assert.equal(e.code, '42501', e.message);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

let root;
before(async () => { root = new Client(db.configuration(baseEnv)); await root.connect(); });
after(async () => { if (root) await root.end(); });

/**
 * A disposable database with real OWNER/MIGRATOR/APP roles, provisioned the
 * way production actually does it on a fresh install: `apply()` once, with
 * an admin connection, BEFORE the schema exists (roles + CONNECT only —
 * mirrors scripts/provision-production-db.sh step 2, run by the superuser).
 * Migrations are then applied through a connection authenticated AS
 * MIGRATOR itself (never the admin/root connection) — the detail every
 * other helper in this test suite skips, and exactly the detail that
 * matters here.
 */
async function freshlyRolledOut(t) {
  const n = 'securisite_test_grants_' + tag();
  const names = { owner: 'sec_test_owner_' + tag(), migrator: 'sec_test_migrator_' + tag(), app: 'sec_test_app_' + tag() };
  // The OWNER role must exist before `CREATE DATABASE ... OWNER` can name it —
  // and the database must be owned by it (never by the superuser) for the
  // same reason documented in scripts/provision-production-db.sh: MIGRATOR
  // only inherits CREATE-on-database (needed for `CREATE SCHEMA` during
  // migrations) through membership in the actual database owner.
  await root.query(`CREATE ROLE "${names.owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await root.query('CREATE DATABASE "' + n + '" OWNER "' + names.owner + '"');
  t.after(async () => {
    await root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)');
    for (const roleName of [names.app, names.migrator, names.owner]) {
      await root.query('DROP OWNED BY "' + roleName + '"').catch(() => {});
      await root.query('DROP ROLE IF EXISTS "' + roleName + '"').catch(() => {});
    }
  });
  const adminEnv = {
    ...baseEnv,
    DATABASE_URL: (u => (u.pathname = '/' + n, u.href))(new URL(baseEnv.DATABASE_URL)),
    SECURISITE_OWNER_ROLE: names.owner, SECURISITE_MIGRATOR_ROLE: names.migrator, SECURISITE_APP_ROLE: names.app,
    SECURISITE_MIGRATOR_PASSWORD: 'mig-' + tag() + '-pw', SECURISITE_APP_PASSWORD: 'app-' + tag() + '-pw',
  };
  const provisioned = await apply(adminEnv);
  assert.equal(provisioned.deferred, true, 'a fresh database has no schema yet: grants must be deferred');

  const urlAs = (username, password) => { const u = new URL(adminEnv.DATABASE_URL); u.username = username; u.password = password; return u.href; };
  const migratorEnv = {
    ...adminEnv, DATABASE_URL: urlAs(names.migrator, adminEnv.SECURISITE_MIGRATOR_PASSWORD),
    SECURISITE_OWNER_ROLE: names.owner, SECURISITE_APP_ROLE: names.app,
  };
  const appConnUrl = urlAs(names.app, adminEnv.SECURISITE_APP_PASSWORD);
  return { dbName: n, names, adminEnv, migratorEnv, appConnUrl };
}

test('migrate() alone (as MIGRATOR, no second GRANT pass) reproduces the exact production 42501s', async t => {
  const { migratorEnv, appConnUrl } = await freshlyRolledOut(t);
  // Real deployment order, minus the (previously manual, easy to skip) second
  // provision-roles.js pass: migrations run fully as MIGRATOR, nothing else.
  const result = await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });
  assert.ok(result.applied.length > 0, 'migrations actually ran');

  const appClient = new Client({ connectionString: appConnUrl, application_name: 'securisite-test-app-broken' });
  await appClient.connect();
  try {
    // Exactly the production symptoms: no USAGE on securisite_meta at all (so
    // even resolving the schema-qualified RLS helper fails), and no SELECT on
    // the migration registry — the gap that blocks alerts/incidents/
    // visiteurs/notifications/realtime the moment an RLS policy evaluates it.
    await rejects42501(appClient.query('SELECT securisite_meta.current_actor_tenant_ids()'), /securisite_meta/);
    await rejects42501(appClient.query('SELECT * FROM securisite_meta.schema_migrations'), /securisite_meta/);
  } finally { await appClient.end(); }
});

test('finalizeGrants (MIGRATOR connection only, no superuser) closes the gap', async t => {
  const { migratorEnv, appConnUrl } = await freshlyRolledOut(t);
  await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });

  // The fix: exactly what migrate-cli.js now runs automatically right after
  // migrate() succeeds. Same MIGRATOR credentials, no admin/superuser
  // connection, no APP or OWNER password anywhere.
  const grants = await finalizeGrants(migratorEnv);
  assert.equal(grants.deferred, false, 'schema is present: nothing left to defer');

  const appClient = new Client({ connectionString: appConnUrl, application_name: 'securisite-test-app-fixed' });
  await appClient.connect();
  try {
    assert.deepEqual((await appClient.query('SELECT securisite_meta.current_actor_tenant_ids()')).rows, []);
    assert.deepEqual((await appClient.query('SELECT * FROM securisite_meta.schema_migrations LIMIT 0')).rows, []);
    for (const fn of RLS_FUNCTIONS) {
      await appClient.query(`SELECT securisite_meta.${fn}()`); // must not throw
    }
    // Least privilege is untouched: still no DDL, still no membership writes.
    await assert.rejects(appClient.query('CREATE TABLE public.hack_grants(x int)'), /permission denied|must be owner/i);
  } finally { await appClient.end(); }
});

test('migrate-cli.js, run exactly as in production (MIGRATOR, one process), leaves APP fully privileged with no second command', async t => {
  const { migratorEnv, appConnUrl } = await freshlyRolledOut(t);
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'backend/db/postgresql/migrate-cli.js')], {
    cwd: repoRoot, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PGHOST: '', PGPORT: '', PGDATABASE: '', PGUSER: '', PGPASSWORD: '', ...migratorEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /droits runtime APP à jour/);

  const appClient = new Client({ connectionString: appConnUrl, application_name: 'securisite-test-app-cli' });
  await appClient.connect();
  try {
    await appClient.query('SELECT securisite_meta.current_actor_tenant_ids()');
    await appClient.query('SELECT * FROM securisite_meta.schema_migrations LIMIT 0');
  } finally { await appClient.end(); }
});

test('readiness now fails closed on exactly the three grants the production incident was missing', async t => {
  const { migratorEnv, appConnUrl } = await freshlyRolledOut(t);
  await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });
  await finalizeGrants(migratorEnv);

  const migratorClient = new Client({ connectionString: migratorEnv.DATABASE_URL });
  await migratorClient.connect();
  const asApp = () => db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: appConnUrl, PGSSL: 'disable' });

  try {
    {
      const pool = asApp();
      try { assert.equal(await assertReady(pool, { directory: migrationsDir }), undefined, 'sanity: fully provisioned passes'); }
      finally { await pool.close(); }
    }
    // No restoring GRANT afterwards: freshlyRolledOut() drops this whole
    // disposable database in its own t.after regardless.
    await migratorClient.query(`REVOKE EXECUTE ON FUNCTION securisite_meta.${RLS_FUNCTIONS[0]}() FROM ${migratorEnv.SECURISITE_APP_ROLE}`);
    {
      const pool = asApp();
      try {
        await assert.rejects(assertReady(pool, { directory: migrationsDir }),
          e => e.code === 'READINESS_PRIVILEGE_MISSING' && new RegExp(RLS_FUNCTIONS[0]).test(e.message));
      } finally { await pool.close(); }
    }
  } finally { await migratorClient.end(); }
});

test('readiness fails closed when USAGE on securisite_meta is missing', async t => {
  const { migratorEnv, appConnUrl } = await freshlyRolledOut(t);
  await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });
  await finalizeGrants(migratorEnv);
  const migratorClient = new Client({ connectionString: migratorEnv.DATABASE_URL });
  await migratorClient.connect();
  try {
    await migratorClient.query(`REVOKE USAGE ON SCHEMA securisite_meta FROM ${migratorEnv.SECURISITE_APP_ROLE}`);
    const pool = db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: appConnUrl, PGSSL: 'disable' });
    try {
      await assert.rejects(assertReady(pool, { directory: migrationsDir }),
        e => e.code === 'READINESS_PRIVILEGE_MISSING' && /USAGE.*securisite_meta/.test(e.message));
    } finally { await pool.close(); }
  } finally { await migratorClient.end(); }
});

test('readiness fails closed when SELECT on securisite_meta.schema_migrations is missing', async t => {
  const { migratorEnv, appConnUrl } = await freshlyRolledOut(t);
  await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });
  await finalizeGrants(migratorEnv);
  const migratorClient = new Client({ connectionString: migratorEnv.DATABASE_URL });
  await migratorClient.connect();
  try {
    await migratorClient.query(`REVOKE SELECT ON securisite_meta.schema_migrations FROM ${migratorEnv.SECURISITE_APP_ROLE}`);
    const pool = db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: appConnUrl, PGSSL: 'disable' });
    try {
      await assert.rejects(assertReady(pool, { directory: migrationsDir }),
        e => e.code === 'READINESS_PRIVILEGE_MISSING' && /schema_migrations/.test(e.message));
    } finally { await pool.close(); }
  } finally { await migratorClient.end(); }
});

test('create-first-admin-cli.js creates the account and its SOC membership in one process, idempotently, without leaking the password', async t => {
  const { migratorEnv } = await freshlyRolledOut(t);
  await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });
  await finalizeGrants(migratorEnv);

  const secret = 'SUPER-SECRET-' + tag();
  const childEnv = {
    ...process.env, PGHOST: '', PGPORT: '', PGDATABASE: '', PGUSER: '', PGPASSWORD: '',
    DATABASE_URL: migratorEnv.DATABASE_URL, PGSSL: 'disable', NODE_ENV: 'test',
    SECURISITE_ADMIN_PASSWORD: secret,
  };
  const run = () => spawnSync(process.execPath,
    [path.join(repoRoot, 'backend/db/postgresql/create-first-admin-cli.js'), 'firstadmin'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 20000, env: childEnv });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /compte administrateur.*créé/);
  assert.match(first.stdout, /membership .* provisionné/);
  assert.doesNotMatch(first.stdout + first.stderr, new RegExp(secret), 'password must never appear in CLI output');

  const second = run(); // idempotent: account exists, membership already provisioned
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /existe déjà/);
  assert.match(second.stdout, /déjà un membership/);

  const check = new Client({ connectionString: migratorEnv.DATABASE_URL });
  await check.connect();
  try {
    const u = (await check.query("SELECT id, role FROM public.users WHERE username='firstadmin'")).rows;
    assert.equal(u.length, 1);
    assert.equal(u[0].role, 'admin');
    const m = (await check.query('SELECT role, alert_access FROM public.memberships WHERE user_id=$1', [u[0].id])).rows;
    assert.equal(m.length, 1);
    assert.equal(m[0].role, 'soc');
    assert.equal(m[0].alert_access, 'scope');
  } finally { await check.end(); }
});
