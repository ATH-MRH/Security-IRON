'use strict';
// PG-3.3A — integration HTTP layer over the async Alert Core service on PostgreSQL.
// Disposable local database only; migrations 001/002 applied; no production access.
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

const base = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const name = 'securisite_test_pg33a_' + randomBytes(6).toString('hex');
const url = new URL(base.DATABASE_URL); url.pathname = '/' + name;
const env = { ...base, DATABASE_URL: url.href };
const accounts = [
  { id: 1, username: 'admin', password: 'securisite', role: 'admin' },
  { id: 2, username: 'agent', password: 'agent', role: 'agent' },
];
const defaultRules = { escalation: [30, 60, 120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 };
const alertBody = { site: 'Oran', zone: 'Quai B', type: 'SOS', level: 4 };

let root, stop, origin;
const token = {};

async function request(method, route, body, jwt = token.admin) {
  const response = await fetch(origin + '/api' + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, body: type.includes('application/json') ? await response.json() : await response.text() };
}
const create = (jwt = token.admin, body = alertBody) => request('POST', '/alerts', body, jwt);
const act = (id, action, jwt = token.admin, comment) => request('POST', `/alerts/${id}/actions`, { action, comment }, jwt);
const detail = (id, jwt = token.admin) => request('GET', `/alerts/${id}`, undefined, jwt);

before(async () => {
  root = new Client(db.configuration(base));
  await root.connect();
  await root.query('CREATE DATABASE "' + name + '"');
  await migrate({ directory, migrationEnv: env });
  const seed = db.createDatabase(env);
  try {
    for (const account of accounts) {
      await seed.query('INSERT INTO public.users(id,username,password_hash,nom_complet,role) VALUES($1,$2,$3,$4,$5)',
        [account.id, account.username, await bcrypt.hash(account.password, 10), account.username, account.role]);
      // PG-8 : les routes Alert Core exigent désormais un périmètre memberships actif.
      await seedMembership(seed, account.id, account.role);
    }
  } finally { await seed.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  origin = 'http://127.0.0.1:' + started.port;
  for (const account of accounts) {
    token[account.username] = (await request('POST', '/auth/login', { username: account.username, password: account.password })).body.token;
  }
});

after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)'); await root.end(); } }
});

test('async handlers enforce authentication, input validation and per-user visibility', async () => {
  assert.equal((await request('GET', '/alerts', undefined, null)).status, 401);
  assert.equal((await create(token.agent, { site: 'Oran', type: 'SOS', level: 9 })).status, 400);
  assert.equal((await create(token.agent, { ...alertBody, latitude: 99, longitude: 0 })).status, 400);
  const created = await create(token.admin);
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^ALT-/);
  assert.equal(created.body.status, 'NOTIFIEE');
  assert.equal((await detail(created.body.id, token.agent)).status, 404);
  assert.ok(!(await request('GET', '/alerts', undefined, token.agent)).body.some(a => a.id === created.body.id));
});

test('critical workflow serialises competing acknowledgements and keeps the audit immutable', async () => {
  const a = (await create(token.agent)).body;
  assert.equal((await act(a.id, 'ACQUITTEE', token.agent)).status, 403);
  assert.equal((await act(a.id, 'CLOTUREE')).status, 409);
  const race = await Promise.all([act(a.id, 'ACQUITTEE'), act(a.id, 'ACQUITTEE')]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  for (const action of ['EN_INTERVENTION', 'SOUS_CONTROLE', 'RESOLUE', 'CLOTUREE']) {
    assert.equal((await act(a.id, action)).status, 200);
  }
  const view = (await detail(a.id)).body;
  assert.ok(view.acknowledged_at && view.resolved_at);
  assert.equal(view.owner, 'admin');
  assert.equal(view.timeline.filter(t => t.action === 'ACQUITTEE').length, 1);
  await assert.rejects(db.query("UPDATE public.alert_audit SET actor='x' WHERE alert_id=$1", [a.id]), /Audit immuable/);
  assert.equal((await request('DELETE', '/alerts/' + a.id)).status, 404);
});

test('cancellation request is retained until the SOC decides, with a mandatory reason', async () => {
  const a = (await create(token.agent)).body;
  assert.equal((await act(a.id, 'DEMANDE_ANNULATION', token.agent)).status, 200);
  assert.equal((await detail(a.id)).body.status, 'NOTIFIEE');
  assert.equal((await act(a.id, 'FAUSSE_ALERTE', token.agent)).status, 403);
  assert.equal((await act(a.id, 'FAUSSE_ALERTE')).status, 400);
  assert.equal((await act(a.id, 'FAUSSE_ALERTE', token.admin, 'Confirmée par téléphone')).status, 200);
});

test('rules stay SOC-only and existing alerts keep the policy captured at creation', async () => {
  const before = (await create()).body;
  const proposal = { escalation: [40, 80, 160], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 };
  try {
    assert.equal((await request('PUT', '/alerts/rules', proposal, token.agent)).status, 403);
    assert.equal((await request('PUT', '/alerts/rules', { ...proposal, escalation: [30, 10, 60] })).status, 400);
    assert.equal((await request('PUT', '/alerts/rules', proposal)).status, 200);
    assert.equal((await request('GET', '/alerts/rules/audit')).body[0].actor, 'admin');
    assert.deepEqual(JSON.parse((await detail(before.id)).body.policy), [30, 60, 120]);
    assert.deepEqual(JSON.parse((await create()).body.policy), [40, 80, 160]);
  } finally {
    assert.equal((await request('PUT', '/alerts/rules', defaultRules)).status, 200);
  }
});

test('notification reads are scoped to the recipient and audited once', async () => {
  const a = (await create()).body;
  const notice = (await request('GET', '/alerts/notifications')).body.find(n => n.alert_id === a.id);
  assert.ok(notice);
  assert.equal((await request('POST', `/alerts/notifications/${notice.id}/read`, {}, token.agent)).status, 404);
  await request('POST', `/alerts/notifications/${notice.id}/read`, {});
  await request('POST', `/alerts/notifications/${notice.id}/read`, {});
  assert.equal((await detail(a.id)).body.timeline.filter(t => t.action === 'LECTURE_NOTIFICATION').length, 1);
});

test('async escalation recovers overdue steps without duplication and stops on acknowledgement', async () => {
  const a = (await create()).body;
  const t0 = Date.parse(a.created_at);
  for (const offset of [31000, 61000, 121000, 130000]) await alerts.escalateDue(t0 + offset);
  const escalated = (await detail(a.id)).body;
  assert.equal(escalated.escalation_step, 3);
  assert.equal(escalated.timeline.filter(t => t.action === 'ESCALADE').length, 3);
  const b = (await create()).body;
  await act(b.id, 'ACQUITTEE');
  await alerts.escalateDue(Date.parse(b.created_at) + 200000);
  assert.equal((await detail(b.id)).body.escalation_step, 0);
});

test('error mapping keeps business errors verbatim and never leaks a technical failure', async () => {
  assert.equal((await detail('ALT-inconnu')).status, 404);
  assert.deepEqual((await detail('ALT-inconnu')).body, { error: 'Alerte introuvable' });

  await db.query("UPDATE public.alert_rules SET config='not json' WHERE id=1");
  try {
    const broken = await request('GET', '/alerts/rules');
    assert.equal(broken.status, 500);
    assert.deepEqual(broken.body, { error: 'Erreur serveur' });
    assert.doesNotMatch(JSON.stringify(broken.body), /json|JSON|token|position|SELECT|config/);
  } finally {
    await db.query('UPDATE public.alert_rules SET config=$1 WHERE id=1', [JSON.stringify(defaultRules)]);
  }

  await db.query('DELETE FROM public.alert_rules');
  try {
    const unavailable = await request('GET', '/alerts/rules');
    assert.equal(unavailable.status, 503);
    assert.deepEqual(unavailable.body, { error: 'Service momentanément indisponible' });
    assert.doesNotMatch(JSON.stringify(unavailable.body), /id=1|ALERT_|absente/);
  } finally {
    await db.query('INSERT INTO public.alert_rules(id,config) VALUES(1,$1)', [JSON.stringify(defaultRules)]);
  }
});

test('the JSON 404 stays scoped to Alert Core while other paths keep the framework response', async () => {
  for (const [method, route] of [['GET', '/alerts/route/inexistante'], ['DELETE', '/alerts']]) {
    const answer = await request(method, route);
    assert.equal(answer.status, 404);
    assert.match(answer.type, /application\/json/);
    assert.equal(answer.body.error, 'Route Alert Core introuvable');
  }
  const legacy = await request('GET', '/route-inexistante');
  assert.equal(legacy.status, 404);
  assert.match(legacy.type, /text\/html/);
  assert.match(legacy.body, /Cannot GET/);
});

test('the user revalidation middleware awaits the store and rejects a revoked session', async () => {
  // PG-8: memberships references users in RESTRICT and is itself append-only,
  // so the seeded (membership-bearing) accounts can no longer be deleted to
  // simulate revocation. A dedicated, deliberately membership-less account
  // isolates the property under test (currentUser lookup) from scope (403) —
  // and doubles as proof the two failure modes stay distinct.
  const ghostId = 999;
  await db.query('INSERT INTO public.users(id,username,password_hash,nom_complet,role) VALUES($1,$2,$3,$4,$5)',
    [ghostId, 'ghost-alert', await bcrypt.hash('x', 10), 'ghost', 'agent']);
  const ghostToken = (await request('POST', '/auth/login', { username: 'ghost-alert', password: 'x' }, null)).body.token;
  assert.equal((await request('GET', '/alerts', undefined, ghostToken)).status, 403); // valid session, no membership
  await db.query('DELETE FROM public.users WHERE id=$1', [ghostId]);
  assert.equal((await request('GET', '/alerts', undefined, ghostToken)).status, 401); // session now revoked
  assert.equal((await request('GET', '/alerts', undefined, token.agent)).status, 200);
});
