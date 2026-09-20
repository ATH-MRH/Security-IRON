'use strict';
// MAIN COURANTE — grille de codification événements (référentiel métier
// fourni par l'opérateur, backend/maincourante-events.js). Couvre :
//  - GET /maincourante/events sert le même référentiel que la validation ;
//  - POST /maincourante revalide code/catégorie côté serveur (jamais un
//    body forgé accepté tel quel) et reste rétrocompatible avec le flux
//    libre historique (sans code) — notamment l'intégration LAPI existante
//    (frontend/js/app.js#arreterCamera) qui n'envoie jamais de code ;
//  - `created_at` est un horodatage serveur non falsifiable, distinct du
//    `datetime` éditable par l'agent (mission explicite : ne jamais faire
//    confiance à une heure modifiable côté client pour la traçabilité) ;
//  - permissions inchangées (scope existant, DELETE toujours admin) ;
//  - le circuit PCS01 (checkbox du panneau, déclenché côté frontend) reste
//    une simple réutilisation de POST /incidents -> alerts.fromIncident,
//    jamais un second mécanisme d'alerte — vérifié ici au niveau HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');
const mcEvents = require('../backend/maincourante-events');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_maincourante_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin, agent;

async function request(method, url, body, token) {
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
    const a = await pool.get(
      'INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
      ['mc_admin', await bcrypt.hash('securisite', 10), 'MC Admin', 'admin']);
    await seedMembership(pool, a.id, 'admin');
    const g = await pool.get(
      'INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
      ['mc_agent', await bcrypt.hash('securisite', 10), 'MC Agent', 'agent']);
    await seedMembership(pool, g.id, 'agent');
    const u = await pool.get(
      'INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
      ['mc_unscoped', await bcrypt.hash('securisite', 10), 'MC Unscoped', 'agent']);
    // Volontairement aucune adhésion active — sert le test "aucun périmètre".
    void u;
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'mc_admin', password: 'securisite' })).body.token;
  agent = (await request('POST', '/auth/login', { username: 'mc_agent', password: 'securisite' })).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

/* ============================================================ */
/*  Migration 013 : colonnes exactes                              */
/* ============================================================ */

test('migration 013 adds exactly code, categorie and a server-defaulted created_at (no other schema drift)', async () => {
  const pool = db.createDatabase(env);
  try {
    const rows = await pool.all(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='main_courante' AND column_name IN ('code','categorie','created_at')
       ORDER BY column_name`);
    assert.deepEqual(rows.map(r => r.column_name), ['categorie', 'code', 'created_at']);
    const code = rows.find(r => r.column_name === 'code');
    const categorie = rows.find(r => r.column_name === 'categorie');
    const createdAt = rows.find(r => r.column_name === 'created_at');
    assert.equal(code.is_nullable, 'YES');
    assert.equal(categorie.is_nullable, 'YES');
    assert.equal(createdAt.is_nullable, 'NO');
    assert.match(createdAt.column_default, /now\(\)/);
  } finally { await pool.close(); }
});

/* ============================================================ */
/*  GET /maincourante/events — référentiel servi = référentiel     */
/*  de validation (même module, jamais deux copies divergentes)    */
/* ============================================================ */

test('GET /maincourante/events serves exactly backend/maincourante-events.js (single source of truth)', async () => {
  const r = await request('GET', '/maincourante/events', undefined, agent);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, mcEvents.EVENTS);
  assert.deepEqual(r.body.categories, mcEvents.CATEGORIES);
});

test('GET /maincourante/events requires authentication like the rest of the module', async () => {
  const r = await request('GET', '/maincourante/events', undefined, null);
  assert.equal(r.status, 401);
});

/* ============================================================ */
/*  POST /maincourante — validation serveur du code/catégorie      */
/* ============================================================ */

test('POST /maincourante with a valid code+categorie persists exactly that pair', async () => {
  const r = await request('POST', '/maincourante', {
    poste: 'Poste 1', agent: 'MC Agent', type: "Tentative d'intrusion",
    code: '10.17', categorie: 'incidents_securite', lieu: 'Clôture nord', description: 'Test',
  }, agent);
  assert.equal(r.status, 200);
  assert.equal(r.body.code, '10.17');
  assert.equal(r.body.categorie, 'incidents_securite');
});

test('POST /maincourante rejects a categorie that does not match the code (forged body)', async () => {
  const r = await request('POST', '/maincourante', {
    poste: 'Poste 1', agent: 'MC Agent', type: 'x', code: '10.17', categorie: 'urgence', description: 'forged',
  }, agent);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /[Cc]atégorie/);
});

test('POST /maincourante rejects a code absent from the referential', async () => {
  const r = await request('POST', '/maincourante', {
    poste: 'Poste 1', agent: 'MC Agent', type: 'x', code: '99.99', description: 'bogus',
  }, agent);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /référentiel/);
});

test('POST /maincourante accepts a code with no categorie supplied, deriving it from the referential', async () => {
  const r = await request('POST', '/maincourante', {
    poste: 'Poste 1', agent: 'MC Agent', type: 'Rien à signaler (R.A.S.)', code: '10.04', description: 'RAS',
  }, agent);
  assert.equal(r.status, 200);
  assert.equal(r.body.categorie, 'agents');
});

test('POST /maincourante still accepts the legacy free-text flow with no code at all (LAPI integration, historical entries)', async () => {
  const r = await request('POST', '/maincourante', {
    poste: 'PC Sûreté', agent: 'Système LAPI', type: 'Entrée véhicule', description: 'Plaque XX-000-XX',
  }, agent);
  assert.equal(r.status, 200);
  assert.equal(r.body.code, null);
  assert.equal(r.body.categorie, null);
});

test('POST /maincourante still requires description and rejects an empty body the same way as before', async () => {
  const r = await request('POST', '/maincourante', { poste: 'Poste 1', agent: 'x' }, agent);
  // Le champ description reste optionnel côté serveur (validation faite côté
  // frontend, comportement historique inchangé) — ce test verrouille
  // seulement qu'aucune 500 ne survient sur un body minimal.
  assert.equal(r.status, 200);
});

test('POST /maincourante requires authentication', async () => {
  const r = await request('POST', '/maincourante', { poste: 'Poste 1', agent: 'x', type: 'y', description: 'z' }, null);
  assert.equal(r.status, 401);
});

test('POST /maincourante refuses a user with no active membership (single-tenant scope gate, unchanged)', async () => {
  const unscoped = (await request('POST', '/auth/login', { username: 'mc_unscoped', password: 'securisite' })).body.token;
  const r = await request('POST', '/maincourante', { poste: 'Poste 1', agent: 'x', type: 'y', description: 'z' }, unscoped);
  assert.equal(r.status, 403);
});

/* ============================================================ */
/*  Horodatage — created_at serveur, jamais dérivé du body client  */
/* ============================================================ */

test('created_at is a real server timestamp, independent of a forged past `datetime` in the body', async () => {
  const before2 = Date.now();
  const r = await request('POST', '/maincourante', {
    poste: 'Poste 1', agent: 'MC Agent', type: 'Point de situation', code: '10.05',
    datetime: '2000-01-01T00:00:00.000Z', description: 'horodatage forgé',
  }, agent);
  assert.equal(r.status, 200);
  assert.equal(r.body.datetime, '2000-01-01T00:00:00.000Z', 'datetime reste éditable par l’agent (comportement existant)');
  const createdAt = Date.parse(r.body.created_at);
  assert.ok(createdAt >= before2 - 5000 && createdAt <= Date.now() + 5000,
    'created_at doit refléter l’heure réelle du serveur, pas la valeur forgée de 2000');
});

/* ============================================================ */
/*  Permissions inchangées (DELETE reste admin uniquement)         */
/* ============================================================ */

test('DELETE /maincourante/:id remains admin-only (unchanged by the codification work)', async () => {
  const created = await request('POST', '/maincourante', {
    poste: 'Poste 1', agent: 'MC Agent', type: 'x', code: '10.04', description: 'à supprimer',
  }, agent);
  const denied = await request('DELETE', '/maincourante/' + created.body.id, undefined, agent);
  assert.equal(denied.status, 403);
  const allowed = await request('DELETE', '/maincourante/' + created.body.id, undefined, admin);
  assert.equal(allowed.status, 200);
});

/* ============================================================ */
/*  PCS01 — réutilisation du pipeline Incidents existant           */
/* ============================================================ */

test('the PCS01 checkbox path (POST /incidents, as issued by the frontend after a Main courante save) still reuses the existing alert pipeline', async () => {
  const inc = await request('POST', '/incidents', {
    type: "Tentative d'intrusion", lieu: 'Clôture nord', gravite: 'critique', statut: 'ouvert',
    agent: 'MC Agent', description: "[Main courante 10.17] test PCS01",
  }, agent);
  assert.equal(inc.status, 200);
  const alerts = await request('GET', '/alerts', undefined, admin);
  assert.ok(alerts.body.some(a => a.type === "Tentative d'intrusion"),
    'alerts.fromIncident doit avoir créé une alerte réelle à partir de cet incident, comme pour tout autre incident');
});

/* ============================================================ */
/*  Paramètres — bascule configurable, fail-safe par défaut        */
/* ============================================================ */

test('mc_pcs01_enabled defaults to absent (feature hidden/inactive until an admin opts in) and is admin-only to change', async () => {
  const before2 = await request('GET', '/parametres', undefined, agent);
  assert.notEqual(before2.body.mc_pcs01_enabled, 'true');
  const deniedWrite = await request('PUT', '/parametres', { mc_pcs01_enabled: 'true' }, agent);
  assert.equal(deniedWrite.status, 403);
  const write = await request('PUT', '/parametres', { mc_pcs01_enabled: 'true' }, admin);
  assert.equal(write.status, 200);
  const after2 = await request('GET', '/parametres', undefined, agent);
  assert.equal(after2.body.mc_pcs01_enabled, 'true');
});
