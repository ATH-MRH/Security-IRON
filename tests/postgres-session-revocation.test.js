'use strict';
// PG-25 (hardening) — backend/routes.js now re-fetches the account
// (id/username/role) on every request, exactly like backend/alerts.js
// already did (PG-10): a JWT is valid for up to 8h (backend/auth.js) and
// previously carried its role/existence unchanged for that whole window
// on every route EXCEPT /api/alerts/*. A deleted account, or one demoted
// from admin, kept full access — including /admin/* — until the token
// naturally expired. This file proves the gap is closed on routes.js.
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
const dbName = 'securisite_test_session_revocation_' + randomBytes(6).toString('hex');
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

test('a deleted account\'s still-valid JWT is refused on routes.js business routes, not just on /api/alerts', async () => {
  // No membership seeded: memberships are themselves immutable (PG-9 —
  // "archiver au lieu de supprimer"), which would block deleting the user
  // via the FK. /admin/* needs no membership at all (PG-8's own
  // documented boundary), so it cleanly isolates the property this test
  // is actually about (account existence), independent of that.
  const row = await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES('to_delete',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)]);
  const token = await login('to_delete');
  assert.equal((await request('GET', '/admin/users', undefined, token)).status, 200, 'the token works while the account still exists');

  await pool.query('DELETE FROM public.users WHERE id=$1', [row.id]);
  const r = await request('GET', '/admin/users', undefined, token);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Session révoquée');
});

test('the revocation event is audited as auth.session.revoked, same event_type as backend/alerts.js', async () => {
  const row = await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES('to_delete_audited',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)]);
  const token = await login('to_delete_audited');
  await pool.query('DELETE FROM public.users WHERE id=$1', [row.id]);
  await request('GET', '/incidents', undefined, token);
  const audited = await pool.get(
    "SELECT * FROM public.security_audit WHERE event_type='auth.session.revoked' AND actor_user_id=$1 ORDER BY id DESC LIMIT 1", [row.id]);
  assert.ok(audited, 'the denial is recorded in security_audit');
  assert.equal(audited.outcome, 'denied');
  assert.equal(audited.origin, 'http');
});

test('a demoted admin (admin -> agent) immediately loses /admin/* access, without waiting for the JWT to expire', async () => {
  const row = await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES('to_demote',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)]);
  const token = await login('to_demote');
  assert.equal((await request('GET', '/admin/users', undefined, token)).status, 200, 'admin access works before the demotion');

  await pool.query("UPDATE public.users SET role='agent' WHERE id=$1", [row.id]);
  const r = await request('GET', '/admin/users', undefined, token);
  assert.equal(r.status, 403, 'the SAME still-valid token no longer grants admin access once the role changed in the database');
});

test('a promoted agent (agent -> admin) gains /admin/* access immediately, with the same still-valid token', async () => {
  const row = await pool.get("INSERT INTO public.users(username,password_hash,role) VALUES('to_promote',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)]);
  const token = await login('to_promote');
  assert.equal((await request('GET', '/admin/users', undefined, token)).status, 403);

  await pool.query("UPDATE public.users SET role='admin' WHERE id=$1", [row.id]);
  assert.equal((await request('GET', '/admin/users', undefined, token)).status, 200, 'the same token reflects the fresh role, not the one captured at login');
});
