'use strict';
// MISSION — BOUTON SOS RÉEL (« panic button ») : des comptes désignés
// (users.sos_recipient, migration 021, réglable via PUT /admin/users/:id/
// sos-recipient) reçoivent réellement l'alarme dès qu'un SOS se déclenche,
// où que ce soit — réutilise intégralement l'infrastructure de diffusion
// PCS01 (migration 011, alert_recipients) : backend/alert-core/
// recipients.js#broadcastToSosDesignated, appelée depuis service.js#create
// UNIQUEMENT pour origin='SOS'. Décision produit validée par l'utilisateur :
// désignation globale par compte (pas par groupe/site/rôle), alarme =
// son + popup plein écran côté client (frontend/js/critical-alert.js,
// déjà opérationnel, non retesté ici — seule la livraison réelle du
// destinataire l'est).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const realtime = require('../backend/realtime');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_sosdesignated_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(4).toString('hex');

let root, pool, stop, base, adminToken;

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function createUser(role = 'agent') {
  const username = 'sosd_' + tag();
  const row = await pool.get('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',
    [username, await bcrypt.hash('x', 10), role]);
  await seedMembership(pool, row.id, role);
  return { id: row.id, username };
}
async function login(username) { return (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token; }
// Désigne un compte pour la durée du test SEULEMENT — la base est partagée
// entre tous les tests de ce fichier (avant()/after() uniques) : sans ce
// nettoyage, un destinataire désigné par un test plus tôt resterait
// désigné pour tous les suivants et fausserait les comptages (§ tests
// "sans aucun destinataire désigné", "diffuse à CHAQUE destinataire", etc.).
async function designate(userId, t) {
  const r = await request('PUT', '/admin/users/' + userId + '/sos-recipient', { sos_recipient: true }, adminToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  t.after(() => pool.query('UPDATE public.users SET sos_recipient=false WHERE id=$1', [userId]));
}
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise(r => setTimeout(r, 20)); }
  return predicate();
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  const admin = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('sosd-admin',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  await seedMembership(pool, admin, 'admin');

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  adminToken = await login('sosd-admin');
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

/* ============================================================ */
/*  PUT /admin/users/:id/sos-recipient — désignation             */
/* ============================================================ */
test('sans token : 401 ; avec un rôle non-admin : 403', async () => {
  const u = await createUser('agent');
  const token = await login(u.username);
  assert.equal((await request('PUT', '/admin/users/' + u.id + '/sos-recipient', { sos_recipient: true }, null)).status, 401);
  assert.equal((await request('PUT', '/admin/users/' + u.id + '/sos-recipient', { sos_recipient: true }, token)).status, 403);
});

test('un administrateur active puis désactive la désignation, chaque transition est auditée', async () => {
  const u = await createUser('agent');
  const on = await request('PUT', '/admin/users/' + u.id + '/sos-recipient', { sos_recipient: true }, adminToken);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.sos_recipient, true);
  const off = await request('PUT', '/admin/users/' + u.id + '/sos-recipient', { sos_recipient: false }, adminToken);
  assert.equal(off.status, 200);
  assert.equal(off.body.sos_recipient, false);
  const events = (await pool.all(
    `SELECT detail FROM public.security_audit WHERE event_type='user.sos_recipient_change' AND resource_id=$1 ORDER BY created_at`,
    [String(u.id)]));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].detail, { before: false, after: true });
  assert.deepEqual(events[1].detail, { before: true, after: false });
});

test('répéter le même état est refusé (409), jamais un silencieux no-op', async () => {
  const u = await createUser('agent');
  assert.equal((await request('PUT', '/admin/users/' + u.id + '/sos-recipient', { sos_recipient: false }, adminToken)).status, 409, 'déjà false par défaut');
});

test('un id introuvable est un 404 propre ; une valeur non-booléenne est un 400', async () => {
  assert.equal((await request('PUT', '/admin/users/999999/sos-recipient', { sos_recipient: true }, adminToken)).status, 404);
  const u = await createUser('agent');
  assert.equal((await request('PUT', '/admin/users/' + u.id + '/sos-recipient', { sos_recipient: 'yes' }, adminToken)).status, 400);
});

test('GET /admin/users renvoie le champ sos_recipient réel pour chaque compte', async (t) => {
  const u = await createUser('agent');
  await designate(u.id, t);
  const list = await request('GET', '/admin/users', undefined, adminToken);
  const row = list.body.find(x => x.id === u.id);
  assert.equal(row.sos_recipient, true);
});

/* ============================================================ */
/*  POST /api/alerts/sos — diffusion réelle aux destinataires     */
/*  désignés, jamais pour une alerte COMMAND                      */
/* ============================================================ */
test('un SOS diffuse réellement à chaque destinataire désigné (alert_recipients réel, jamais fictif)', async (t) => {
  const designated1 = await createUser('agent');
  const designated2 = await createUser('agent');
  const notDesignated = await createUser('agent');
  const trigger = await createUser('agent');
  await designate(designated1.id, t);
  await designate(designated2.id, t);

  const triggerToken = await login(trigger.username);
  const sos = await request('POST', '/alerts/sos', {}, triggerToken);
  assert.equal(sos.status, 201, JSON.stringify(sos.body));

  const rows = await pool.all(
    'SELECT user_id, recipient_type, recipient_ref FROM public.alert_recipients WHERE alert_id=$1 ORDER BY user_id', [sos.body.id]);
  const recipientIds = rows.map(r => r.user_id).sort((a, b) => a - b);
  assert.deepEqual(recipientIds, [designated1.id, designated2.id].sort((a, b) => a - b),
    'seuls les comptes désignés reçoivent une ligne — jamais notDesignated, jamais le déclencheur lui-même');
  for (const r of rows) { assert.equal(r.recipient_type, 'user'); assert.equal(Number(r.recipient_ref), r.user_id); }
});

test('un destinataire désigné voit réellement le SOS apparaître dans son GET /alerts (own access, sans lien préalable avec le déclencheur)', async (t) => {
  const designated = await createUser('agent');
  const trigger = await createUser('agent');
  await designate(designated.id, t);
  const designatedToken = await login(designated.username);
  const triggerToken = await login(trigger.username);

  const before = await request('GET', '/alerts', undefined, designatedToken);
  assert.equal(before.status, 200);

  const sos = await request('POST', '/alerts/sos', {}, triggerToken);
  assert.equal(sos.status, 201);

  const after_ = await request('GET', '/alerts', undefined, designatedToken);
  assert.ok(after_.body.some(a => a.id === sos.body.id),
    'le compte désigné doit voir apparaître le SOS déclenché par un autre utilisateur, sans jamais avoir été son destinataire au préalable');
});

test('un compte non désigné (own access) ne voit jamais apparaître un SOS déclenché par un autre utilisateur — aucun sur-diffusion', async () => {
  const notDesignated = await createUser('agent');
  const trigger = await createUser('agent');
  const notDesignatedToken = await login(notDesignated.username);
  const triggerToken = await login(trigger.username);
  const sos = await request('POST', '/alerts/sos', {}, triggerToken);
  assert.equal(sos.status, 201);
  const list = await request('GET', '/alerts', undefined, notDesignatedToken);
  assert.ok(!list.body.some(a => a.id === sos.body.id));
});

test('un compte désigné mais BLOQUÉ est exclu de la diffusion — jamais alarmé après blocage', async (t) => {
  const designated = await createUser('agent');
  const trigger = await createUser('agent');
  await designate(designated.id, t);
  await request('PUT', '/admin/users/' + designated.id + '/status', { status: 'blocked' }, adminToken);
  const triggerToken = await login(trigger.username);
  const sos = await request('POST', '/alerts/sos', {}, triggerToken);
  assert.equal(sos.status, 201);
  const rows = await pool.all('SELECT user_id FROM public.alert_recipients WHERE alert_id=$1', [sos.body.id]);
  assert.deepEqual(rows.map(r => r.user_id), []);
});

test('une alerte COMMAND (pas SOS) ne diffuse JAMAIS automatiquement aux comptes désignés — réservé au bouton SOS', async (t) => {
  const designated = await createUser('agent');
  const trigger = await createUser('agent');
  await designate(designated.id, t);
  // Un rôle 'soc' est nécessaire pour créer une alerte COMMAND via
  // l'endpoint standard (POST /alerts) — reproduit ici directement en base
  // (memberships.role='soc') plutôt que de re-router par l'admin Groupes,
  // hors sujet pour ce test.
  await pool.query(`UPDATE public.memberships SET role='soc', alert_access='scope' WHERE user_id=$1`, [trigger.id]);
  const triggerToken = await login(trigger.username);
  const created = await request('POST', '/alerts', { site: 'Site test', type: 'Intrusion', level: 3 }, triggerToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rows = await pool.all('SELECT user_id FROM public.alert_recipients WHERE alert_id=$1', [created.body.id]);
  assert.deepEqual(rows.map(r => r.user_id), [], 'aucune diffusion automatique pour une alerte non-SOS');
});

test('l\'audit alert_audit contient une entrée DIFFUSION dédiée quand au moins un destinataire désigné existe', async (t) => {
  const designated = await createUser('agent');
  const trigger = await createUser('agent');
  await designate(designated.id, t);
  const triggerToken = await login(trigger.username);
  const sos = await request('POST', '/alerts/sos', {}, triggerToken);
  assert.equal(sos.status, 201);
  const audit = await pool.all(
    `SELECT action, detail FROM public.alert_audit WHERE alert_id=$1 AND action='DIFFUSION'`, [sos.body.id]);
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /sos_designated — 1 destinataire/);
});

test('sans aucun destinataire désigné, le SOS réussit normalement et n\'écrit aucune entrée DIFFUSION fictive', async () => {
  const trigger = await createUser('agent');
  const triggerToken = await login(trigger.username);
  const sos = await request('POST', '/alerts/sos', {}, triggerToken);
  assert.equal(sos.status, 201);
  const rows = await pool.all('SELECT user_id FROM public.alert_recipients WHERE alert_id=$1', [sos.body.id]);
  assert.deepEqual(rows, []);
  const audit = await pool.all(`SELECT 1 FROM public.alert_audit WHERE alert_id=$1 AND action='DIFFUSION'`, [sos.body.id]);
  assert.deepEqual(audit, []);
});

test('l\'événement temps réel alert:created porte recipientUserIds pour un SOS avec destinataires désignés — la vraie voie de livraison en direct', async (t) => {
  const designated = await createUser('agent');
  const trigger = await createUser('agent');
  await designate(designated.id, t);
  const triggerToken = await login(trigger.username);
  let captured = null;
  const unsubscribe = realtime.subscribe(
    event => event.type === 'alert:created',
    event => { captured = event.payload; });
  try {
    const sos = await request('POST', '/alerts/sos', {}, triggerToken);
    assert.equal(sos.status, 201);
    await waitFor(() => captured && captured.id === sos.body.id);
    assert.ok(captured, 'événement alert:created jamais reçu');
    assert.deepEqual(captured.recipientUserIds, [designated.id]);
  } finally { unsubscribe(); }
});
