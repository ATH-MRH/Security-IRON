'use strict';
// Historically SQLite; ported to real PostgreSQL for PG-3.3B. Disposable local
// database only, migrations 001/002 applied, test users provisioned explicitly.
// Business assertions are unchanged from the original suite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const alerts = require('../backend/alerts');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_legacy_alerts_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const accounts = [
  { username: 'admin', password: 'securisite', role: 'admin' },
  { username: 'agent', password: 'agent', role: 'agent' },
];

let root, server, stop, base, admin, agent;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = r.headers.get('content-type');
  return { status: r.status, contentType, body: contentType?.includes('application/json') ? await r.json() : await r.text() };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    for (const a of accounts) {
      const row = await pool.get('INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [a.username, await bcrypt.hash(a.password, 10), a.username, a.role]);
      await seedMembership(pool, row.id, a.role); // PG-8: business/alert routes require an active membership.
    }
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  server = started.server; stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'admin', password: 'securisite' }, null)).body.token;
  agent = (await request('POST', '/auth/login', { username: 'agent', password: 'agent' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

const newAlert = async (token = admin, level = 4) => (await request('POST', '/alerts', { site: 'Oran', zone: 'Quai B', type: 'SOS', level }, token)).body;
test('authentication, validation and user visibility', async () => {
  assert.equal((await request('GET', '/alerts', null, null)).status, 401);
  assert.equal((await request('POST', '/alerts', { site: 'Oran', type: 'SOS', level: 9 })).status, 400);
  assert.equal((await request('POST', '/alerts', { site: 'Oran', type: 'SOS', level: 4, latitude: 99, longitude: 0 })).status, 400);
  const a = await newAlert();
  assert.equal(a.status, 'NOTIFIEE'); assert.ok(a.created_at);
  assert.equal((await request('GET', '/alerts/' + a.id, null, agent)).status, 404);
  assert.ok(!(await request('GET', '/alerts', null, agent)).body.some(x => x.id === a.id));
});
test('critical workflow, competing acknowledgement and immutable history', async () => {
  const a = await newAlert(agent);
  assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action: 'ACQUITTEE' }, agent)).status, 403);
  assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action: 'CLOTUREE' })).status, 409);
  const attempts = await Promise.all([1, 2].map(() => request('POST', `/alerts/${a.id}/actions`, { action: 'ACQUITTEE' })));
  assert.deepEqual(attempts.map(x => x.status).sort(), [200, 409]);
  for (const action of ['EN_INTERVENTION', 'SOUS_CONTROLE', 'RESOLUE', 'CLOTUREE']) assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action })).status, 200);
  const detail = (await request('GET', '/alerts/' + a.id)).body;
  assert.ok(detail.acknowledged_at); assert.ok(detail.resolved_at); assert.equal(detail.owner, 'admin');
  assert.equal(detail.timeline.filter(t => t.action === 'ACQUITTEE').length, 1);
  await assert.rejects(db.query('DELETE FROM public.alert_audit WHERE alert_id=$1', [a.id]), /Audit immuable/);
  await assert.rejects(db.query("UPDATE public.alert_audit SET actor='x' WHERE alert_id=$1", [a.id]), /Audit immuable/);
  assert.equal((await request('DELETE', '/alerts/' + a.id)).status, 404);
});
test('cancellation request is retained until SOC decision', async () => {
  const a = await newAlert(agent);
  assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action: 'DEMANDE_ANNULATION' }, agent)).status, 200);
  assert.equal((await request('GET', '/alerts/' + a.id)).body.status, 'NOTIFIEE');
  assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action: 'FAUSSE_ALERTE' }, agent)).status, 403);
  assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action: 'FAUSSE_ALERTE' })).status, 400);
  assert.equal((await request('POST', `/alerts/${a.id}/actions`, { action: 'FAUSSE_ALERTE', comment: 'Erreur confirmée par téléphone' })).status, 200);
});
test('escalations recover overdue steps, do not duplicate, stop on acknowledgement', async () => {
  const a = await newAlert();
  const t = Date.parse(a.created_at);
  await alerts.escalateDue(t + 31000); await alerts.escalateDue(t + 61000); await alerts.escalateDue(t + 121000); await alerts.escalateDue(t + 130000);
  const detail = (await request('GET', '/alerts/' + a.id)).body;
  assert.equal(detail.escalation_step, 3); assert.equal(detail.timeline.filter(x => x.action === 'ESCALADE').length, 3);
  const b = await newAlert(); await request('POST', `/alerts/${b.id}/actions`, { action: 'ACQUITTEE' });
  await alerts.escalateDue(Date.parse(b.created_at) + 200000);
  assert.equal((await request('GET', '/alerts/' + b.id)).body.escalation_step, 0);
});
test('notification reads are scoped and audited once', async () => {
  const a = await newAlert();
  const n = (await request('GET', '/alerts/notifications')).body.find(x => x.alert_id === a.id);
  assert.equal((await request('POST', `/alerts/notifications/${n.id}/read`, {}, agent)).status, 404);
  await request('POST', `/alerts/notifications/${n.id}/read`, {}); await request('POST', `/alerts/notifications/${n.id}/read`, {});
  assert.equal((await request('GET', '/alerts/' + a.id)).body.timeline.filter(t => t.action === 'LECTURE_NOTIFICATION').length, 1);
});
test('config validates values and existing alerts retain their escalation policy', async () => {
  const a = await newAlert();
  const c = { escalation: [40, 80, 160], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 };
  assert.equal((await request('PUT', '/alerts/rules', c, agent)).status, 403);
  assert.equal((await request('PUT', '/alerts/rules', { ...c, escalation: [30, 10, 60] })).status, 400);
  assert.equal((await request('PUT', '/alerts/rules', c)).status, 200);
  assert.equal((await request('GET', '/alerts/rules/audit')).body[0].actor, 'admin');
  assert.deepEqual(JSON.parse((await request('GET', '/alerts/' + a.id)).body.policy), [30, 60, 120]);
  assert.deepEqual(JSON.parse((await newAlert()).policy), [40, 80, 160]);
});
test('incident and repeated badge refusals feed the alert center', async () => {
  const incident = await request('POST', '/incidents', { type: 'Intrusion', lieu: 'Oran', gravite: 'critique', description: 'Porte forcée' }, agent);
  assert.equal(incident.status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await request('POST', '/pietons', { badge: 'TEST-42', nom: 'Test', point: 'Porte B', sens: 'entree', resultat: 'refus' }, agent)).status, 200);
  const rows = (await request('GET', '/alerts')).body;
  assert.ok(rows.some(a => a.origin === 'INCIDENT' && a.comment.includes(incident.body.ref)));
  assert.equal(rows.filter(a => a.origin === 'REGLE_BADGE' && a.equipment === 'badge:TEST-42').length, 1);
});

test('404 JSON is scoped to alerts; other APIs retain the historical HTML response', async () => {
  for (const [method, url] of [['GET', '/alerts/route-inexistante'], ['GET', '/alerts/route/inexistante'], ['DELETE', '/alerts']]) {
    const r = await request(method, url); assert.equal(r.status, 404); assert.match(r.contentType, /application\/json/); assert.equal(typeof r.body.error, 'string');
  }
  const legacy = await request('GET', '/route-inexistante'); assert.equal(legacy.status, 404); assert.match(legacy.contentType, /text\/html/); assert.match(legacy.body, /Cannot GET/);
});
test('visitors retain expected, check-in and check-out lifecycle and existing permissions', async () => {
  const created = await request('POST', '/visiteurs', { prenom: 'Test', nom: 'Visiteur' }, agent); assert.equal(created.status, 200); assert.equal(created.body.statut, 'attendu');
  const id = created.body.id;
  assert.ok((await request('GET', '/visiteurs', null, agent)).body.some(v => v.id === id && v.statut === 'attendu'));
  assert.equal((await request('DELETE', '/visiteurs/' + id, null, agent)).status, 403);
  assert.equal((await request('PUT', '/visiteurs/' + id + '/checkin', {}, agent)).body.statut, 'present');
  assert.equal((await request('PUT', '/visiteurs/' + id + '/checkout', {}, agent)).body.statut, 'parti');
  assert.equal((await request('GET', '/visiteurs', null, null)).status, 401);
});
test('alert acknowledgement and incident resolution do not remove other bell families', async () => {
  const vis = (await request('POST', '/visiteurs', { prenom: 'Persistent', nom: 'Visitor' }, agent)).body;
  const inc = (await request('POST', '/incidents', { type: 'Non-regression', lieu: 'Site', gravite: 'critique' }, agent)).body;
  const a = (await request('GET', '/alerts', null, agent)).body.find(a => a.origin === 'INCIDENT' && a.comment.includes(inc.ref)); assert.ok(a);
  await request('POST', `/alerts/${a.id}/actions`, { action: 'ACQUITTEE' });
  assert.ok((await request('GET', '/incidents', null, agent)).body.some(i => i.id === inc.id && i.statut !== 'resolu'));
  assert.ok((await request('GET', '/visiteurs', null, agent)).body.some(v => v.id === vis.id && v.statut === 'attendu'));
  assert.equal((await request('PUT', '/incidents/' + inc.id, { statut: 'resolu' }, agent)).body.statut, 'resolu');
  assert.equal((await request('GET', '/alerts/' + a.id, null, agent)).body.status, 'ACQUITTEE');
  assert.ok((await request('GET', '/visiteurs', null, agent)).body.some(v => v.id === vis.id && v.statut === 'attendu'));
  assert.equal((await request('DELETE', '/incidents/' + inc.id, null, agent)).status, 403);
  assert.equal((await request('GET', '/incidents', null, null)).status, 401);
});
