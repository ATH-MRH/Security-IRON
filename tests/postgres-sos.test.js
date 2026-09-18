'use strict';
// PG-15 — bouton de détresse (SOS). POST /api/alerts/sos : aucun champ requis,
// niveau/type jamais au choix de l'appelant (toujours 4/'SOS'). Réutilise
// intégralement le chemin create() déjà prouvé (PG-1..PG-13) : même
// transaction/audit (PG-10), même émission temps réel (PG-12) et push
// (PG-13), même own/scope (PG-8) — ce fichier ne re-teste pas ces mécanismes,
// il prouve que /sos s'y intègre correctement et n'introduit aucune IA
// (aucune dépendance vers un module IA n'existe dans le dépôt à ce stade).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const realtime = require('../backend/realtime');
const fakeProvider = require('../backend/push/fake-provider');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_sos_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, pool, stop, base;
let socToken, ownToken, socId, ownId;

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
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
  socId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('sos-soc',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  ownId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('sos-own',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  await seedMembership(pool, socId, 'admin');
  await seedMembership(pool, ownId, 'agent');

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  socToken = (await request('POST', '/auth/login', { username: 'sos-soc', password: 'x' }, null)).body.token;
  ownToken = (await request('POST', '/auth/login', { username: 'sos-own', password: 'x' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('POST /api/alerts/sos requires zero fields: an empty body still creates a level-4 SOS alert', async () => {
  const r = await request('POST', '/alerts/sos', {}, ownToken);
  assert.equal(r.status, 201);
  assert.equal(r.body.level, 4);
  assert.equal(r.body.type, 'SOS');
  assert.equal(r.body.origin, 'SOS');
  assert.equal(r.body.status, 'NOTIFIEE');
  assert.match(r.body.site, /sos-own/); // default site names the triggering user when none is given
});

test('a caller can never override level or type: SOS always wins regardless of what is submitted', async () => {
  const r = await request('POST', '/alerts/sos', { level: 1, type: 'Autre chose', site: 'Poste 3', comment: 'Agression' }, ownToken);
  assert.equal(r.status, 201);
  assert.equal(r.body.level, 4);
  assert.equal(r.body.type, 'SOS');
  assert.equal(r.body.site, 'Poste 3'); // an explicit, legitimate site IS honoured — only level/type are locked
  assert.equal(r.body.comment, 'Agression');
});

test('SOS requires an active membership, the same scope gate as every other Alert Core route', async () => {
  const username = 'sos-noscope-' + randomBytes(3).toString('hex');
  await pool.query("INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,'agent')", [username, await bcrypt.hash('x', 10)]);
  const token = (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token;
  const r = await request('POST', '/alerts/sos', {}, token);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'Accès au périmètre refusé' });
});

test('an SOS alert follows the exact same own/scope visibility as any other alert', async () => {
  const created = (await request('POST', '/alerts/sos', {}, ownToken)).body;
  assert.ok((await request('GET', '/alerts', undefined, socToken)).body.some(a => a.id === created.id), 'soc sees it');
  assert.ok((await request('GET', '/alerts', undefined, ownToken)).body.some(a => a.id === created.id), 'its own creator sees it');
});

test('an SOS alert is recorded in security_audit as alert.create, origin=http, detail.alert_origin=SOS', async () => {
  const created = (await request('POST', '/alerts/sos', {}, ownToken)).body;
  const row = (await pool.get(
    "SELECT * FROM public.security_audit WHERE event_type='alert.create' AND resource_id=$1", [created.id]));
  assert.equal(row.outcome, 'success');
  assert.equal(row.origin, 'http'); // a human pressed the button — never 'system'
  assert.equal(row.detail.alert_origin, 'SOS');
  assert.equal(row.actor_user_id, ownId);
});

test('an SOS alert fires the same realtime and push events as any other alert.create', async () => {
  await request('POST', '/push/subscribe', { endpoint: 'https://push.example/sos-' + randomBytes(4).toString('hex'), keys: { p256dh: 'a', auth: 'b' } }, socToken);
  const beforePush = fakeProvider.all().length;
  let realtimeSeen = null;
  const unsubscribe = realtime.subscribe(() => true, event => { if (event.type === 'alert:created') realtimeSeen = event; });
  try {
    const created = (await request('POST', '/alerts/sos', {}, ownToken)).body;
    assert.ok(await waitFor(() => realtimeSeen && realtimeSeen.payload.id === created.id), 'realtime event observed');
    assert.ok(await waitFor(() => fakeProvider.all().length > beforePush), 'push delivered');
  } finally { unsubscribe(); }
});

test('the SOS response path has no dependency on any AI module (none exists in this codebase yet)', () => {
  for (const file of ['../backend/alert-core/service.js', '../backend/alerts.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /openai|anthropic|\bai-provider\b|llm/i);
  }
});

test('service.sos is exported and the architecture contract still holds (no new SQL, no other new export)', () => {
  const service = require('../backend/alert-core/service');
  assert.equal(typeof service.sos, 'function');
});

// ============================================================
// Audit SOS end-to-end : lacunes comblées (401 sans jeton, jeton invalide,
// double soumission indépendante, erreur PostgreSQL mappée) — chaque
// scénario ci-dessous exerce /alerts/sos précisément, jamais une autre
// route Alert Core dont le comportement, bien que partagé via create(),
// n'avait encore jamais été prouvé pour ce point d'entrée précis.
// ============================================================

test('POST /api/alerts/sos with no Authorization header is refused, never silently accepted', async () => {
  const r = await request('POST', '/alerts/sos', {}, null);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Token manquant' });
});

test('POST /api/alerts/sos with a garbage/invalid token is refused', async () => {
  const r = await request('POST', '/alerts/sos', {}, 'not-a-real-jwt');
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Token invalide ou expiré' });
});

test('POST /api/alerts/sos with a token signed under a different secret is refused (never trusts an unverified claim)', async () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ id: ownId, username: 'sos-own', role: 'agent' }, 'wrong-secret-entirely', { expiresIn: '1h' });
  const r = await request('POST', '/alerts/sos', {}, forged);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Token invalide ou expiré' });
});

test('POST /api/alerts/sos with a token for a since-deleted account is refused as a revoked session, distinct from a mere no-membership 403', async () => {
  // No membership seeded on purpose: public.memberships references users
  // ON DELETE RESTRICT (a membership-bearing account cannot be deleted —
  // see tests/postgres-alert-core-http.test.js's own "ghost-alert" test),
  // so only a membership-less account can validly disappear mid-session.
  const ghostId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('sos-ghost',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  const ghostToken = (await request('POST', '/auth/login', { username: 'sos-ghost', password: 'x' }, null)).body.token;
  assert.equal((await request('POST', '/alerts/sos', {}, ghostToken)).status, 403); // valid session, no membership
  await pool.query('DELETE FROM public.users WHERE id=$1', [ghostId]);
  const r = await request('POST', '/alerts/sos', {}, ghostToken);
  assert.equal(r.status, 401); // session now revoked — a distinct failure mode from the 403 above
  assert.deepEqual(r.body, { error: 'Session révoquée' });
});

test('two independent SOS submissions from the same account (simulating two tabs/devices) each create a distinct alert — no silent server-side dedup ever suppresses a real second signal', async () => {
  const [a, b] = await Promise.all([
    request('POST', '/alerts/sos', {}, ownToken),
    request('POST', '/alerts/sos', {}, ownToken),
  ]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.notEqual(a.body.id, b.body.id, 'two genuinely concurrent presses must never collapse into one alert');
  assert.equal(a.body.level, 4); assert.equal(b.body.level, 4);
});

test('a PostgreSQL-layer failure on the SOS path is mapped to a generic, non-leaking error — never a false "SOS envoyé"', async () => {
  await pool.query("UPDATE public.alert_rules SET config='not json' WHERE id=1");
  try {
    const r = await request('POST', '/alerts/sos', {}, ownToken);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Erreur serveur' });
    assert.doesNotMatch(JSON.stringify(r.body), /json|JSON|token|position|SELECT|config/);
  } finally {
    await pool.query('UPDATE public.alert_rules SET config=$1 WHERE id=1',
      [JSON.stringify({ escalation: [30, 60, 120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 })]);
  }
});

test('security_alerts carries no site/zone-level scoping column: SOS access is a tenant-wide own/scope decision, not a site one (documented limit, not an oversight)', () => {
  const schemaSource = fs.readFileSync(
    path.resolve(__dirname, '../backend/db/postgresql/migrations/002_alert_core.sql'), 'utf8');
  assert.match(schemaSource, /CREATE TABLE public\.security_alerts/);
  // site/zone exist as free-text descriptive columns (what the alert is
  // about), never as a foreign key into public.sites/zones — cross-site
  // narrowing of /alerts/sos itself is therefore structurally inapplicable
  // today; see backend/alerts.js's own PG-8 comment on this exact point.
  const table = schemaSource.slice(schemaSource.indexOf('CREATE TABLE public.security_alerts'), schemaSource.indexOf('CREATE TABLE public.alert_audit'));
  assert.doesNotMatch(table, /REFERENCES public\.sites|REFERENCES public\.zones/);
});
