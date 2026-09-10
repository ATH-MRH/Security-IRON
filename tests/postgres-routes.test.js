'use strict';
// PG-3.3B — POST /pietons, POST /incidents, PUT /parametres : une seule transaction
// PostgreSQL async par requête, verrou advisory conservé jusqu'au COMMIT parent,
// rollback complet si Alert Core échoue. Bases PostgreSQL jetables locales uniquement.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const service = require('../backend/alert-core/service');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_routes_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const now = () => new Date().toISOString();
const uid = p => p + '-' + randomBytes(4).toString('hex').toUpperCase();
const user = { id: 2, username: 'agent', role: 'agent' };

let root, stop, base, admin, agent;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
// Wraps a live transaction client so the first statement matching the predicate rejects.
const faultClient = (client, shouldFail) => ({
  ...client,
  query: (sql, params = []) => shouldFail(sql, params)
    ? Promise.reject(Object.assign(new Error('fault injected'), { code: 'FAULT' }))
    : client.query(sql, params),
});
const alertsFor = async equipmentOrRefFilter => (await request('GET', '/alerts')).body.filter(equipmentOrRefFilter);

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    for (const [u, p, r] of [['admin', 'securisite', 'admin'], ['agent', 'agent', 'agent']]) {
      await pool.query('INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)',
        [u, await bcrypt.hash(p, 10), u, r]);
    }
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'admin', password: 'securisite' }, null)).body.token;
  agent = (await request('POST', '/auth/login', { username: 'agent', password: 'agent' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('POST /pietons under the badge threshold creates the passage but no alert', async () => {
  for (let i = 0; i < 2; i++) {
    assert.equal((await request('POST', '/pietons', { badge: 'B-UNDER', nom: 'x', point: 'P', sens: 'entree', resultat: 'refus' }, agent)).status, 200);
  }
  assert.equal((await alertsFor(a => a.equipment === 'badge:B-UNDER')).length, 0);
});

test('POST /pietons at the threshold creates exactly one deduplicated REGLE_BADGE alert (text badge)', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('POST', '/pietons', { badge: 'B-TEXT', nom: 'x', point: 'P', sens: 'entree', resultat: 'refus' }, agent)).status, 200);
  }
  assert.equal((await alertsFor(a => a.origin === 'REGLE_BADGE' && a.equipment === 'badge:B-TEXT')).length, 1);
});

test('POST /pietons normalises a numeric badge and still raises exactly one alert', async () => {
  for (let i = 0; i < 4; i++) {
    const r = await request('POST', '/pietons', { badge: 991234, nom: 'x', point: 'P', sens: 'entree', resultat: 'refus' }, agent);
    assert.equal(r.status, 200);
    assert.equal(r.body.badge, '991234'); // TEXT column
  }
  assert.equal((await alertsFor(a => a.origin === 'REGLE_BADGE' && a.equipment === 'badge:991234')).length, 1);
});

test('POST /pietons rolls the passage back when the Alert Core write fails', async () => {
  const pool = db.createDatabase(env);
  try {
    const count = async () => (await pool.get("SELECT count(*)::int n FROM public.pietons WHERE badge='ROLLBACK-1'")).n;
    const before = await count();
    await assert.rejects(pool.transaction(async client => {
      const fault = faultClient(client, sql => /INSERT INTO public\.alert_audit/.test(sql));
      let last;
      for (let i = 0; i < 3; i++) {
        last = (await client.query(
          `INSERT INTO pietons (id, datetime, nom, badge, type, point, sens, resultat, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [uid('PED'), now(), 'x', 'ROLLBACK-1', 'E', 'P', 'entree', 'refus', '', 'agent'])).rows[0];
      }
      await service.fromBadge(last, user, fault); // 3 refus >= threshold(3) -> create -> audit -> fault
    }), /fault injected/);
    assert.equal(await count(), before, 'passage rows rolled back');
    assert.equal((await pool.get("SELECT count(*)::int n FROM public.security_alerts WHERE equipment='badge:ROLLBACK-1'")).n, 0);
    assert.equal((await pool.get("SELECT count(*)::int n FROM public.alert_audit WHERE detail LIKE '%ROLLBACK-1%'")).n, 0);
  } finally { await pool.close(); }
});

test('POST /pietons keeps the badge advisory lock until the parent transaction commits', async () => {
  const pool = db.createDatabase(env);
  const observer = new Client(db.configuration(env));
  await observer.connect();
  try {
    let pid, duringOpen;
    await pool.transaction(async client => {
      pid = (await client.get('SELECT pg_backend_pid() AS pid')).pid;
      await service.fromBadge({ badge: 'LOCK-BADGE', resultat: 'refus', point: 'P' }, user, client);
      duringOpen = (await observer.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1", [pid])).rows[0].n;
    });
    const afterCommit = (await observer.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1", [pid])).rows[0].n;
    assert.ok(duringOpen >= 1, 'advisory lock held while the transaction is open');
    assert.equal(afterCommit, 0, 'advisory lock released at commit');
  } finally { await observer.end(); await pool.close(); }
});

test('POST /incidents commits incident + INCIDENT alert together for a critical gravity', async () => {
  const r = await request('POST', '/incidents', { type: 'Intrusion', lieu: 'Zone A', gravite: 'critique', description: 'forcée' }, agent);
  assert.equal(r.status, 200);
  assert.match(r.body.ref, /^INC-/);
  const found = await alertsFor(a => a.origin === 'INCIDENT' && a.comment.includes(r.body.ref));
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 3);
});

test('POST /incidents raises no alert for a minor gravity', async () => {
  const r = await request('POST', '/incidents', { type: 'Broutille', lieu: 'Zone A', gravite: 'mineur' }, agent);
  assert.equal(r.status, 200);
  assert.equal((await alertsFor(a => a.origin === 'INCIDENT' && a.comment.includes(r.body.ref))).length, 0);
});

test('POST /incidents rolls back incident, alert, audit and notifications when Alert Core fails', async () => {
  const pool = db.createDatabase(env);
  try {
    const ref = 'INC-RB-' + randomBytes(3).toString('hex');
    await assert.rejects(pool.transaction(async client => {
      const fault = faultClient(client, sql => /INSERT INTO public\.alert_notifications/.test(sql));
      const rec = (await client.query(
        `INSERT INTO incidents (id, ref, datetime, type, lieu, gravite, statut, agent, description, actions, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [uid('INC'), ref, now(), 'Intrusion', 'Zone A', 'critique', 'ouvert', 'agent', 'boom', '', 'agent'])).rows[0];
      await service.fromIncident(rec, user, fault);
    }), /fault injected/);
    assert.equal((await pool.get('SELECT count(*)::int n FROM public.incidents WHERE ref=$1', [ref])).n, 0);
    assert.equal((await pool.get('SELECT count(*)::int n FROM public.security_alerts WHERE comment LIKE $1', ['%' + ref + '%'])).n, 0);
    assert.equal((await pool.get(
      'SELECT count(*)::int n FROM public.alert_audit a JOIN public.security_alerts s ON s.id=a.alert_id WHERE s.comment LIKE $1',
      ['%' + ref + '%'])).n, 0);
  } finally { await pool.close(); }
});

test('PUT /parametres applies a valid batch atomically', async () => {
  assert.equal((await request('PUT', '/parametres', { site: 'Site PG-3.3B', adresse: 'ZI', tel: '+213' })).status, 200);
  const p = (await request('GET', '/parametres')).body;
  assert.equal(p.site, 'Site PG-3.3B'); assert.equal(p.adresse, 'ZI'); assert.equal(p.tel, '+213');
});

test('PUT /parametres rolls the whole batch back when one write fails', async () => {
  const pool = db.createDatabase(env);
  try {
    await pool.query("INSERT INTO public.parametres (cle,valeur) VALUES ('atomic_key','before') ON CONFLICT (cle) DO UPDATE SET valeur='before'");
    let seen = 0;
    await assert.rejects(pool.transaction(async client => {
      const fault = faultClient(client, sql => /INSERT INTO parametres/.test(sql) && ++seen === 2);
      for (const [k, v] of [['atomic_key', 'after'], ['second_key', 'x']]) {
        await fault.query('INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=excluded.valeur', [k, String(v)]);
      }
    }), /fault injected/);
    assert.equal((await pool.get("SELECT valeur v FROM public.parametres WHERE cle='atomic_key'")).v, 'before', 'first write rolled back');
    assert.equal((await pool.get("SELECT count(*)::int n FROM public.parametres WHERE cle='second_key'")).n, 0);
  } finally { await pool.close(); }
});

test('routes.js uses no synchronous db.run and no un-awaited transaction, and exposes no SQLite metadata', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../backend/routes.js'), 'utf8');
  assert.doesNotMatch(src, /\bdb\.run\s*\(/, 'db.run must not be used');
  assert.doesNotMatch(src, /db\.transaction\(\s*(?:async\s*)?\(\s*\)\s*=>/, 'transactions must take a client');
  assert.doesNotMatch(src, /(?<!await )(?<!return )db\.transaction\(/, 'every db.transaction must be awaited or returned');
  assert.doesNotMatch(src, /sqlite|db\.dbPath|db_url|DATABASE_URL/i, 'no SQLite metadata or connection string');
});
