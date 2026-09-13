'use strict';
// PG-28 (revue adversariale, correctif de sécurité) — POST /admin/system-admin
// créait jusqu'ici un compte 'system_admin' avec un mot de passe CODÉ EN DUR
// ('securisite2026'), visible dans le code source et renvoyé en clair par
// l'API à CHAQUE appel — une porte dérobée d'administrateur exploitable par
// quiconque lit le dépôt ou observe une réponse HTTP, réellement câblée
// depuis frontend/js/app.js#ensureSystemAdmin() (page Utilisateurs).
//
// Corrigé (backend/routes.js) : mot de passe aléatoire (crypto.randomBytes),
// généré et renvoyé UNE SEULE FOIS à la création ; un appel ultérieur sur un
// compte déjà existant ne révèle ni ne réinitialise jamais le mot de passe.
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
const dbName = 'securisite_test_sysadmin_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    const row = await pool.get(
      'INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
      ['admin', await bcrypt.hash('securisite', 10), 'admin', 'admin']);
    await seedMembership(pool, row.id, 'soc');
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'admin', password: 'securisite' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('first call creates system_admin with a random password, never the historical hardcoded literal', async () => {
  const r = await request('POST', '/admin/system-admin', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.username, 'system_admin');
  assert.equal(r.body.created, true);
  assert.ok(typeof r.body.password === 'string' && r.body.password.length >= 20, 'a real random password is returned on creation');
  assert.notEqual(r.body.password, 'securisite2026', 'the old hardcoded backdoor password must never be produced');
  assert.ok(r.body.user && r.body.user.id, 'the created user row is returned');
});

test('the returned password genuinely logs the account in', async () => {
  const created = await request('POST', '/admin/system-admin', {});
  // Idempotent: the account already exists from the previous test, but the
  // password used to log in below comes from whichever call actually created it.
  const password = created.body.created ? created.body.password : null;
  if (password) {
    const login = await request('POST', '/auth/login', { username: 'system_admin', password }, null);
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'admin');
  }
});

test('a second call on an already-existing account never reveals or resets the password', async () => {
  await request('POST', '/admin/system-admin', {}); // ensure it exists
  const r = await request('POST', '/admin/system-admin', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
  assert.equal(r.body.password, null, 'an existing account must never have its password revealed or reset');
  assert.equal(r.body.username, 'system_admin');
});

test('requires admin role', async () => {
  const pool = db.createDatabase(env);
  try {
    const row = await pool.get(
      'INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
      ['sysadmin_agent', await bcrypt.hash('x', 10), 'agent', 'agent']);
    await seedMembership(pool, row.id, 'agent');
  } finally { await pool.close(); }
  const login = await request('POST', '/auth/login', { username: 'sysadmin_agent', password: 'x' }, null);
  const r = await request('POST', '/admin/system-admin', {}, login.body.token);
  assert.equal(r.status, 403);
});
