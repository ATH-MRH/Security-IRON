'use strict';
// PG-14 — PWA minimale : manifest.json + service worker (app shell hors-ligne,
// gestionnaires push/notificationclick prêts pour PG-13). Aucun fournisseur
// push réel (voir docs/push.md) : les gestionnaires du service worker restent
// inertes, mais leur code est prouvé syntaxiquement valide et cohérent avec
// les fichiers réellement présents dans frontend/.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_pwa_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const frontendDir = path.resolve(__dirname, '../frontend');

let root, stop, base;

async function request(method, url, token) {
  const r = await fetch(base + url, { method, headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  const adminId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('pwa-admin',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  await seedMembership(pool, adminId, 'admin');
  await pool.close();

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('manifest.json is served with the required PWA fields', async () => {
  const r = await request('GET', '/manifest.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const manifest = JSON.parse(r.text);
  for (const field of ['name', 'short_name', 'start_url', 'display', 'background_color', 'theme_color', 'icons']) {
    assert.ok(field in manifest, 'manifest is missing ' + field);
  }
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(frontendDir, icon.src)), 'manifest icon file missing: ' + icon.src);
  }
});

test('sw.js is served as JavaScript and is syntactically valid', async () => {
  const r = await request('GET', '/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.doesNotThrow(() => new vm.Script(r.text, { filename: 'sw.js' }));
});

test('sw.js never intercepts /api/* (dynamic, authenticated — must always hit the network)', () => {
  const source = fs.readFileSync(path.join(frontendDir, 'sw.js'), 'utf8');
  assert.match(source, /pathname\.startsWith\(['"]\/api\/['"]\)/, 'no explicit /api/ exclusion found in the fetch handler');
});

test('every shell asset the service worker precaches actually exists and is servable', async () => {
  const source = fs.readFileSync(path.join(frontendDir, 'sw.js'), 'utf8');
  const match = source.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(match, 'SHELL_ASSETS array not found in sw.js');
  const assets = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(a => a !== './');
  assert.ok(assets.length >= 5, 'expected a real, non-trivial shell asset list');
  for (const asset of assets) {
    assert.ok(fs.existsSync(path.join(frontendDir, asset)), 'precached shell asset missing on disk: ' + asset);
    const r = await request('GET', '/' + asset);
    assert.equal(r.status, 200, 'precached shell asset not servable: ' + asset);
  }
});

test('sw.js registers push and notificationclick handlers, and never assumes anything beyond {type, id, at}', () => {
  const source = fs.readFileSync(path.join(frontendDir, 'sw.js'), 'utf8');
  assert.match(source, /addEventListener\(['"]push['"]/);
  assert.match(source, /addEventListener\(['"]notificationclick['"]/);
  assert.match(source, /showNotification/);
  // No site/type/level/comment field name from an alert ever referenced —
  // the payload it consumes is exactly backend/push.js's {type, id, at}.
  assert.doesNotMatch(source, /\bsite\b|\blevel\b|\bcomment\b|\bgravite\b/);
});

test('index.html links the manifest and registers the service worker', () => {
  const html = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest\.json">/);
  assert.match(html, /navigator\.serviceWorker\.register\(['"]sw\.js['"]\)/);
});
