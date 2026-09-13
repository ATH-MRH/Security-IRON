'use strict';
// PG-25 (hardening) — backend/auth.js's per-account brute-force protection.
// Per-IP protection is tested in its own file
// (tests/postgres-auth-ip-rate-limit.test.js): both share one in-memory,
// per-process failure count, so mixing them in one file risks one test's
// failures silently pushing another test over its threshold.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_auth_ratelimit_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(5).toString('hex');

let root, pool, stop, base;

async function request(method, url, body) {
  const r = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function createUser(username, password = 'correct-horse') {
  await pool.query('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3)', [username, await bcrypt.hash(password, 10), 'agent']);
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('10 tolerated failures against one account, the 11th trips 429; a different account on the same IP is unaffected', async () => {
  const target = 'ratelimit_target_' + tag();
  await createUser(target);
  for (let i = 0; i < 10; i++) {
    const r = await request('POST', '/auth/login', { username: target, password: 'wrong' });
    assert.equal(r.status, 401, 'attempt ' + (i + 1) + ' should still be a plain auth failure');
  }
  const r11 = await request('POST', '/auth/login', { username: target, password: 'wrong' });
  assert.equal(r11.status, 429, 'the 11th failure trips the per-account limit (10 tolerated)');
  assert.match(r11.body.error, /Trop de tentatives/);

  // Correct password no longer helps once the account is rate-limited.
  const rCorrect = await request('POST', '/auth/login', { username: target, password: 'correct-horse' });
  assert.equal(rCorrect.status, 429);

  // A different account, same IP, same process: not blocked (per-account, not just per-IP).
  const other = 'ratelimit_other_' + tag();
  await createUser(other);
  const rOther = await request('POST', '/auth/login', { username: other, password: 'wrong' });
  assert.equal(rOther.status, 401, 'a different account is not swept up by another account\'s block');
});

test('a successful login resets the account\'s failure counter', async () => {
  const user = 'ratelimit_reset_' + tag();
  await createUser(user, 'right-password');
  for (let i = 0; i < 5; i++) assert.equal((await request('POST', '/auth/login', { username: user, password: 'wrong' })).status, 401);
  const ok = await request('POST', '/auth/login', { username: user, password: 'right-password' });
  assert.equal(ok.status, 200, 'succeeds before the threshold is reached');
  // Five more failures after a reset should again be plain 401s, not 429 —
  // proves the counter was cleared by the success, not just "not yet at 10".
  for (let i = 0; i < 5; i++) assert.equal((await request('POST', '/auth/login', { username: user, password: 'wrong' })).status, 401);
});

test('a rate-limited attempt is recorded in security_audit as auth.login.rate_limited', async () => {
  const target = 'ratelimit_audit_' + tag();
  await createUser(target);
  for (let i = 0; i < 11; i++) await request('POST', '/auth/login', { username: target, password: 'wrong' });
  const row = await pool.get(
    "SELECT * FROM public.security_audit WHERE event_type='auth.login.rate_limited' AND actor_username=$1 ORDER BY id DESC LIMIT 1",
    [target]);
  assert.ok(row, 'a rate_limited event was recorded');
  assert.equal(row.outcome, 'denied');
  assert.equal(row.origin, 'http');
});
