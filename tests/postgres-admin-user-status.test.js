'use strict';
// Administration Système — statut de compte utilisateur (LOT 8, migration
// 016) : backend/routes.js PUT /admin/users/:id/status, backend/auth.js
// (login refusé si bloqué), backend/routes.js (session révoquée en cours
// de vie si le compte est bloqué après émission du JWT — même mécanisme
// PG-25 que pour un compte supprimé/rétrogradé).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_userstatus_' + randomUUID().replace(/-/g, '').slice(0, 12);
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin, adminId;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function createUser(username, role = 'agent') {
  const pool = db.createDatabase(env);
  try {
    const u = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      [username, await bcrypt.hash('securisite', 10), username, role]);
    await seedMembership(pool, u.id, role === 'admin' ? 'admin' : 'agent');
    return u.id;
  } finally { await pool.close(); }
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  adminId = await createUser('userstatus_admin', 'admin');
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'userstatus_admin', password: 'securisite' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('a fresh account defaults to active status and can log in', async () => {
  await createUser('freshuser1');
  const login = await request('POST', '/auth/login', { username: 'freshuser1', password: 'securisite' }, null);
  assert.equal(login.status, 200);
});

test('blocking an account refuses future logins with a distinct, non-enumerating 403', async () => {
  const id = await createUser('tobeblocked1');
  const block = await request('PUT', `/admin/users/${id}/status`, { status: 'blocked', reason: 'test' });
  assert.equal(block.status, 200);
  assert.equal(block.body.status, 'blocked');
  const wrongPassword = await request('POST', '/auth/login', { username: 'tobeblocked1', password: 'wrong' }, null);
  assert.equal(wrongPassword.status, 401, 'a wrong password on a blocked account must still read as generic invalid credentials, not reveal the block');
  const correctPassword = await request('POST', '/auth/login', { username: 'tobeblocked1', password: 'securisite' }, null);
  assert.equal(correctPassword.status, 403);
  assert.match(correctPassword.body.error, /bloqu/i);
});

test('a token issued before blocking is revoked mid-session, not honored until natural expiry (PG-25 pattern extended)', async () => {
  const id = await createUser('sessionrevoke1');
  const before = await request('POST', '/auth/login', { username: 'sessionrevoke1', password: 'securisite' }, null);
  const token = before.body.token;
  const worksBeforeBlock = await request('GET', '/incidents', undefined, token);
  assert.notEqual(worksBeforeBlock.status, 401);
  await request('PUT', `/admin/users/${id}/status`, { status: 'blocked' });
  const revoked = await request('GET', '/incidents', undefined, token);
  assert.equal(revoked.status, 401);
});

test('unblocking restores login access', async () => {
  const id = await createUser('unblockme1');
  await request('PUT', `/admin/users/${id}/status`, { status: 'blocked' });
  const reactivate = await request('PUT', `/admin/users/${id}/status`, { status: 'active' });
  assert.equal(reactivate.status, 200);
  assert.equal(reactivate.body.status, 'active');
  const login = await request('POST', '/auth/login', { username: 'unblockme1', password: 'securisite' }, null);
  assert.equal(login.status, 200);
});

test('an admin cannot block their own account (would self-lock-out)', async () => {
  const r = await request('PUT', `/admin/users/${adminId}/status`, { status: 'blocked' });
  assert.equal(r.status, 400);
});

test('redundant status transitions are refused (409), never a silent no-op', async () => {
  const id = await createUser('redundant1');
  assert.equal((await request('PUT', `/admin/users/${id}/status`, { status: 'active' })).status, 409, 'already active');
});

test('an invalid status value is rejected', async () => {
  const id = await createUser('invalidstatus1');
  assert.equal((await request('PUT', `/admin/users/${id}/status`, { status: 'vaporized' })).status, 400);
});

test('a nonexistent user id is a clean 404', async () => {
  assert.equal((await request('PUT', `/admin/users/999999/status`, { status: 'blocked' })).status, 404);
});

test('the /admin/users list now reports real status, never fabricated', async () => {
  const id = await createUser('liststatus1');
  await request('PUT', `/admin/users/${id}/status`, { status: 'blocked' });
  const list = await request('GET', '/admin/users');
  const row = list.body.find(u => u.id === id);
  assert.equal(row.status, 'blocked');
});

test('/admin/system reports real active/blocked user counts, not a constant', async () => {
  await createUser('kpiuser1');
  const blockedId = await createUser('kpiuser2');
  await request('PUT', `/admin/users/${blockedId}/status`, { status: 'blocked' });
  const system = await request('GET', '/admin/system');
  assert.equal(system.status, 200);
  assert.ok(system.body.kpis.users_active >= 1);
  assert.ok(system.body.kpis.users_blocked >= 1);
  assert.equal(system.body.kpis.users_total, system.body.kpis.users_active + system.body.kpis.users_blocked);
});
