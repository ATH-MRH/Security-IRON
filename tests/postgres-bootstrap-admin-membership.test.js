'use strict';
// Préparation production — backend/db/postgresql/bootstrap-admin-membership.js
// complète create-admin.js : sans lui, le premier administrateur créé n'a
// accès qu'aux routes /api/admin/* (rôle JWT), jamais au tableau de bord
// SOC/alertes/incidents (scope.requireScope(), PG-8) faute de membership.
// Constaté en préparant le déploiement production (la même étape avait dû
// être faite à la main pendant la validation staging).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { createAdmin } = require('../backend/db/postgresql/create-admin');
const { bootstrapAdminMembership } = require('../backend/db/postgresql/bootstrap-admin-membership');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_bootstrapadmin_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const LOCAL_TENANT = '507486ba-d55e-5142-9ac2-196da97866df';

let root;

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  Object.assign(process.env, env);
});
after(async () => {
  await db.close();
  if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); }
});

test('create-admin then bootstrap-admin-membership: the admin gets a real soc/scope membership under the local tenant', async () => {
  const created = await createAdmin(env, { username: 'prodadmin', password: 'a-real-password-123' });
  assert.equal(created.created, true);

  const r = await bootstrapAdminMembership(env, 'prodadmin');
  assert.equal(r.provisioned, true);
  assert.equal(r.role, 'soc');
  assert.equal(r.alert_access, 'scope');

  const row = await db.get(
    `SELECT m.role, m.alert_access, m.tenant_id, m.site_id, m.zone_id, t.code
     FROM public.memberships m JOIN public.users u ON u.id = m.user_id
     JOIN public.tenants t ON t.id = m.tenant_id
     WHERE u.username = 'prodadmin'`);
  assert.equal(row.role, 'soc');
  assert.equal(row.alert_access, 'scope');
  assert.equal(row.tenant_id, LOCAL_TENANT);
  assert.equal(row.code, 'local');
  assert.equal(row.site_id, null);
  assert.equal(row.zone_id, null);
});

test('idempotent: a second call never widens or duplicates the membership', async () => {
  const first = await bootstrapAdminMembership(env, 'prodadmin');
  assert.equal(first.provisioned, false, 'already provisioned by the previous test');

  const count = await db.get(
    `SELECT count(*)::int AS n FROM public.memberships m JOIN public.users u ON u.id = m.user_id WHERE u.username = 'prodadmin'`);
  assert.equal(count.n, 1, 'never a duplicate row for the same user/tenant/role');
});

test('unknown username throws a typed, non-leaking error', async () => {
  await assert.rejects(
    bootstrapAdminMembership(env, 'does-not-exist'),
    e => { assert.equal(e.code, 'BOOTSTRAP_ADMIN_UNKNOWN'); assert.doesNotMatch(e.message, /password|hash/i); return true; });
});

test('works for a non-admin account too (agent role -> agent/own, not soc/scope)', async () => {
  const hash = await bcrypt.hash('x', 10);
  await db.query(
    "INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES('prodagent',$1,'Agent','agent')",
    [hash]);
  const r = await bootstrapAdminMembership(env, 'prodagent');
  assert.equal(r.provisioned, true);
  assert.equal(r.role, 'agent');
  assert.equal(r.alert_access, 'own');
});

test('a role outside admin/agent is left alone, never forced into a membership', async () => {
  const hash = await bcrypt.hash('x', 10);
  await db.query(
    "INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES('prodother',$1,'Other','viewer')",
    [hash]);
  const r = await bootstrapAdminMembership(env, 'prodother');
  assert.equal(r.provisioned, false);
  assert.equal(r.reason, 'role_hors_perimetre_local');
});

test('invalid username is rejected before touching the database', async () => {
  await assert.rejects(bootstrapAdminMembership(env, "bad'; DROP TABLE users;--"), /Identifiant invalide/);
});
