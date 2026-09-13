'use strict';
// PG-25 (hardening) — backend/auth.js's per-IP brute-force protection:
// catches a horizontal attack (many different target accounts from one
// source) that a purely per-account limit would never trip. Isolated in
// its own file/process: it deliberately pushes the shared in-memory IP
// counter past its threshold, which would otherwise block every other
// login in the same process for the rest of the failure window.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_auth_ip_ratelimit_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(6).toString('hex');

let root, stop, base;

async function request(method, url, body) {
  const r = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

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

test('50 failures spread across many different (non-existent) accounts from one IP trip the per-IP limit', async () => {
  // Each attempt targets a DIFFERENT, never-reused username — no single
  // account ever comes close to the per-account threshold (10) — only the
  // shared per-IP counter can plausibly explain a 429 appearing here.
  let sawRateLimited = false;
  for (let i = 0; i < 55 && !sawRateLimited; i++) {
    const r = await request('POST', '/auth/login', { username: 'spray_' + tag(), password: 'x' });
    if (r.status === 429) { sawRateLimited = true; assert.match(r.body.error, /Trop de tentatives/); }
    else assert.equal(r.status, 401);
  }
  assert.ok(sawRateLimited, 'the per-IP limit eventually trips a horizontal, many-account attack');
});
