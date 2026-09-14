'use strict';
// PG-4 — outils de déploiement : rôles OWNER/MIGRATOR/APP, CLI de migration,
// création du premier administrateur. Bases et rôles jetables locaux uniquement ;
// aucun secret en dur, aucun accès production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, PRIVILEGES } = require('../backend/db/postgresql/readiness');
const { roleStatements, emitSQL, apply } = require('../backend/db/postgresql/provision-roles');
const { createAdmin, MIN_PASSWORD } = require('../backend/db/postgresql/create-admin');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const tag = () => randomBytes(5).toString('hex');
const names = t => ({
  owner: 'sec_test_owner_' + t, migrator: 'sec_test_migrator_' + t, app: 'sec_test_app_' + t,
});

let root;
before(async () => { root = new Client(db.configuration(baseEnv)); await root.connect(); });
after(async () => { if (root) await root.end(); });

// A disposable database whose roles are dropped afterwards.
async function provisioned(t, { migrated = true } = {}) {
  const n = 'securisite_test_prov_' + tag();
  const r = names(tag());
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(async () => {
    await root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)');
    for (const role of [r.app, r.migrator, r.owner]) {
      await root.query('DROP OWNED BY "' + role + '"').catch(() => {});
      await root.query('DROP ROLE IF EXISTS "' + role + '"').catch(() => {});
    }
  });
  const env = {
    ...baseEnv,
    DATABASE_URL: (u => (u.pathname = '/' + n, u.href))(new URL(baseEnv.DATABASE_URL)),
    SECURISITE_OWNER_ROLE: r.owner, SECURISITE_MIGRATOR_ROLE: r.migrator, SECURISITE_APP_ROLE: r.app,
    SECURISITE_MIGRATOR_PASSWORD: 'mig-' + tag() + '-pw', SECURISITE_APP_PASSWORD: 'app-' + tag() + '-pw',
  };
  if (migrated) await migrate({ directory: migrationsDir, migrationEnv: env });
  return { n, r, env };
}
const appUrl = env => { const u = new URL(env.DATABASE_URL); u.username = env.SECURISITE_APP_ROLE; u.password = env.SECURISITE_APP_PASSWORD; return u.href; };

test('emitSQL contains the full grant set, no password, and safe role attributes', () => {
  const sql = emitSQL({ owner: 'o', migrator: 'm', app: 'a', db: 'securisite' });
  assert.match(sql, /CREATE ROLE "o" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;/);
  assert.match(sql, /CREATE ROLE "m" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;/);
  assert.match(sql, /CREATE ROLE "a" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;/);
  assert.match(sql, /GRANT "o" TO "m";/);
  assert.match(sql, /REVOKE "o" FROM "a";/);          // app never a member of owner
  assert.match(sql, /REVOKE ALL ON DATABASE "securisite" FROM PUBLIC;/);
  for (const [table, verbs] of Object.entries(PRIVILEGES)) {
    assert.ok(sql.includes(`GRANT ${verbs} ON public."${table}" TO "a";`), table);
  }
  assert.match(sql, /GRANT SELECT ON securisite_meta\.schema_migrations TO "a";/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE "o" IN SCHEMA public GRANT SELECT ON TABLES TO "a";/);
  // Migrations actually run connected as MIGRATOR, never OWNER (SET ROLE is
  // forbidden session control, see migrate.js#validateSQL) — the default
  // privilege that fires for real tables is this one, not the OWNER-scoped
  // one above. Discovered wiring the automatic post-migration grant pass.
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE "m" IN SCHEMA public GRANT SELECT ON TABLES TO "a";/);
  // Placeholders only — never a literal password.
  assert.match(sql, /ALTER ROLE "m" PASSWORD :'migrator_password';/);
  assert.doesNotMatch(sql, /PASSWORD '[^:]/);
  // Append-only journals: INSERT + SELECT, never UPDATE/DELETE.
  assert.equal(PRIVILEGES.alert_audit, 'SELECT,INSERT');
  assert.equal(PRIVILEGES.alert_config_audit, 'SELECT,INSERT');
});

test('roleStatements marks exactly the three CREATE ROLE as non-idempotent', () => {
  const stmts = roleStatements({ owner: 'o', migrator: 'm', app: 'a', db: 'd' });
  assert.equal(stmts.filter(s => s.create).length, 3);
  assert.ok(stmts.filter(s => s.create).every(s => /^CREATE ROLE /.test(s.sql)));
});

test('apply provisions three roles with least privilege; app is runtime-only', async t => {
  const { r, env } = await provisioned(t);
  const applied = await apply(env);
  assert.equal(applied.owner, r.owner);
  assert.equal(applied.migrator, r.migrator);
  assert.equal(applied.app, r.app);
  assert.equal(applied.db, env.DATABASE_URL.split('/').pop());
  assert.equal(applied.deferred, false, 'a migrated database needs no deferred grants');
  await apply(env); // idempotent second run

  const flags = (await root.query(
    'SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
    [[r.owner, r.migrator, r.app]])).rows.reduce((m, x) => (m[x.rolname] = x, m), {});
  for (const role of [r.owner, r.migrator, r.app]) {
    assert.equal(flags[role].rolsuper, false, role + ' superuser');
    assert.equal(flags[role].rolcreatedb, false, role + ' createdb');
    assert.equal(flags[role].rolcreaterole, false, role + ' createrole');
    assert.equal(flags[role].rolbypassrls, false, role + ' bypassrls');
  }
  assert.equal(flags[r.owner].rolcanlogin, false, 'owner must not log in');
  assert.equal(flags[r.app].rolcanlogin, true);

  const memberships = (await root.query(`
    SELECT r.rolname AS member, g.rolname AS group FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
    WHERE g.rolname = $1`, [r.owner])).rows.map(x => x.member);
  assert.ok(memberships.includes(r.migrator), 'migrator is a member of owner');
  assert.ok(!memberships.includes(r.app), 'app is NOT a member of owner');
});

test('the app role can perform its DML but cannot alter structure or touch append-only journals', async t => {
  const { env } = await provisioned(t);
  await apply(env);
  const client = new Client({ connectionString: appUrl(env), application_name: 'securisite-test-app' });
  await client.connect();
  try {
    await client.query("INSERT INTO public.users(username,password_hash,role) VALUES('prov_app','x','agent')");
    assert.equal((await client.query("SELECT count(*)::int n FROM public.users WHERE username='prov_app'")).rows[0].n, 1);
    await client.query("UPDATE public.users SET role='admin' WHERE username='prov_app'");
    await client.query("DELETE FROM public.users WHERE username='prov_app'");
    // PG-16: security_alerts.tenant_id (migration 009) is NOT NULL — the frozen
    // 'local' tenant id from migration 003's backfill.
    await client.query("INSERT INTO public.security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,policy,tenant_id) VALUES('ALT-p',now()::text,now()::text,'s','z','t',1,'o',1,'u','NOTIFIEE','[]','507486ba-d55e-5142-9ac2-196da97866df')");
    await client.query("INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES('ALT-p',now()::text,'a','A','d')");
    await assert.rejects(client.query('CREATE TABLE public.hack(x int)'), /permission denied|must be owner/i);
    await assert.rejects(client.query('DROP TABLE public.users'), /permission denied|must be owner/i);
    await assert.rejects(client.query("UPDATE public.alert_audit SET actor='x'"), /permission denied|Audit immuable/i);
    await assert.rejects(client.query('DELETE FROM public.alert_audit'), /permission denied|Audit immuable/i);
    await assert.rejects(client.query("INSERT INTO securisite_meta.schema_migrations(version,name,checksum,applied_at,execution_ms) VALUES(999,'x',repeat('a',64),now(),0)"), /permission denied/i);
  } finally { await client.end(); }
});

test('readiness passes for a connection using only the provisioned app role', async t => {
  const { env } = await provisioned(t);
  await apply(env);
  const pool = db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: appUrl(env), PGSSL: 'disable' });
  try { assert.equal(await assertReady(pool, { directory: migrationsDir }), undefined); }
  finally { await pool.close(); }
});

test('create-admin: env password creates one admin, is idempotent, and enforces a minimum length', async t => {
  const { env } = await provisioned(t);
  const first = await createAdmin(env, { username: 'boss', password: 'x'.repeat(MIN_PASSWORD) });
  assert.deepEqual(first, { username: 'boss', created: true });
  const again = await createAdmin(env, { username: 'boss', password: 'y'.repeat(MIN_PASSWORD) });
  assert.deepEqual(again, { username: 'boss', created: false }); // never overwrites
  const check = new Client({ connectionString: env.DATABASE_URL });
  await check.connect();
  try {
    const rows = (await check.query("SELECT role FROM public.users WHERE username='boss'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'admin');
  } finally { await check.end(); }
  await assert.rejects(createAdmin(env, { username: 'usr2', password: 'short' }), /trop court/);
  await assert.rejects(createAdmin(env, { username: 'usr3', password: '' }), /manquant/);
  await assert.rejects(createAdmin(env, { username: 'bad name', password: 'x'.repeat(MIN_PASSWORD) }), /Identifiant invalide/);
});

test('the CLI tools never print the passwords they use', async t => {
  const { env } = await provisioned(t, { migrated: false });
  const secret = 'SUPER-SECRET-' + tag();
  const childEnv = {
    ...process.env, PGHOST: '', PGPORT: '', PGDATABASE: '', PGUSER: '', PGPASSWORD: '',
    DATABASE_URL: env.DATABASE_URL, PGSSL: 'disable', NODE_ENV: 'test',
    SECURISITE_OWNER_ROLE: env.SECURISITE_OWNER_ROLE, SECURISITE_MIGRATOR_ROLE: env.SECURISITE_MIGRATOR_ROLE,
    SECURISITE_APP_ROLE: env.SECURISITE_APP_ROLE,
    SECURISITE_MIGRATOR_PASSWORD: secret + '-m', SECURISITE_APP_PASSWORD: secret + '-a',
    SECURISITE_ADMIN_PASSWORD: secret + '-admin-000',
  };
  const run = script => spawnSync(process.execPath, [path.join(repoRoot, 'backend/db/postgresql', script)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 20000, env: childEnv });

  // Real deployment order on a fresh database:
  const roles1 = run('provision-roles.js');       // roles + CONNECT ; schema not yet present
  assert.equal(roles1.status, 0, roles1.stderr);
  assert.match(roles1.stdout, /relancer après les migrations/);
  const migr = run('migrate-cli.js');             // migrations as MIGRATOR
  assert.equal(migr.status, 0, migr.stderr);
  const roles2 = run('provision-roles.js');       // completes the GRANTs, no hint this time
  assert.equal(roles2.status, 0, roles2.stderr);
  assert.doesNotMatch(roles2.stdout, /relancer après les migrations/);
  const admin = run('create-admin.js');           // first admin
  assert.equal(admin.status, 0, admin.stderr);

  const output = [roles1, migr, roles2, admin].map(r => r.stdout + r.stderr).join('');
  assert.doesNotMatch(output, new RegExp(secret), 'a password appeared in CLI output');
  assert.match(migr.stdout, /appliquées : 1, 2/);
  assert.match(admin.stdout, /créé/);
});
