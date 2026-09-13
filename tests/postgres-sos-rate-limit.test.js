'use strict';
// PG-25 (hardening) — backend/alerts.js's SOS abuse protection: a very
// generous, per-account threshold (never a plausible obstacle for a real
// distress call, even several rapid presses) that still catches an
// automated flood capable of drowning the SOC dashboard in fake signals.
// Isolated in its own file/process: the in-memory counter is shared for
// the whole process, and this test deliberately exhausts it.
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
const dbName = 'securisite_test_sos_ratelimit_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, pool, stop, base;

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function login(username) { return (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token; }

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

test('20 SOS in one minute for one account are tolerated (a genuinely panicked user is never blocked); the 21st is explicitly refused, never silently dropped', async () => {
  const row = await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES('sos_spam_agent',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)]);
  await seedMembership(pool, row.id, 'agent');
  const token = await login('sos_spam_agent');

  for (let i = 0; i < 20; i++) {
    const r = await request('POST', '/alerts/sos', {}, token);
    assert.equal(r.status, 201, 'SOS ' + (i + 1) + '/20 must always succeed — never rate-limited within the tolerated burst');
  }
  const r21 = await request('POST', '/alerts/sos', {}, token);
  assert.equal(r21.status, 429, 'the 21st within the same minute is explicitly refused');
  assert.match(r21.body.error, /Trop de signaux SOS/);

  // A different account is never affected by another account's burst.
  const other = await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES('sos_other_agent',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)]);
  await seedMembership(pool, other.id, 'agent');
  const otherToken = await login('sos_other_agent');
  const rOther = await request('POST', '/alerts/sos', {}, otherToken);
  assert.equal(rOther.status, 201, 'a different account\'s SOS is never swept up by someone else\'s burst');
});
