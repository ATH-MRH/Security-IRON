'use strict';
// PG-13 — infrastructure push : abstraction de fournisseur (backend/push.js +
// backend/push/fake-provider.js), câblée sur le même bus que le temps réel
// (backend/realtime.js, PG-12). Le fake reste le fournisseur actif par
// défaut ici (aucune clé VAPID dans cette suite) ; le fournisseur réel
// (PCS01, Lot D) a sa propre suite, tests/push-web-push-provider.test.js —
// voir docs/push.md pour le HUMAN CHECKPOINT sur son activation.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, PUSH, PRIVILEGES } = require('../backend/db/postgresql/readiness');
const push = require('../backend/push');
const fakeProvider = require('../backend/push/fake-provider');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_push_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(5).toString('hex');

let root, pool, stop, base;
let socToken, ownToken, otherOwnToken, socId, ownId, otherOwnId;

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
const subscription = suffix => ({
  endpoint: 'https://push.example/ep-' + suffix,
  keys: { p256dh: 'p256dh-' + suffix, auth: 'auth-' + suffix },
});
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
    "INSERT INTO public.users(username,password_hash,role) VALUES('push-soc',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  ownId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('push-own',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  otherOwnId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('push-own2',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  await seedMembership(pool, socId, 'admin');
  await seedMembership(pool, ownId, 'agent');
  await seedMembership(pool, otherOwnId, 'agent');

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  socToken = (await request('POST', '/auth/login', { username: 'push-soc', password: 'x' }, null)).body.token;
  ownToken = (await request('POST', '/auth/login', { username: 'push-own', password: 'x' }, null)).body.token;
  otherOwnToken = (await request('POST', '/auth/login', { username: 'push-own2', password: 'x' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});
beforeEach(() => fakeProvider.clear());

test('the fake provider is the active default: no real provider wired', () => {
  assert.equal(push.getProvider(), fakeProvider);
});

test('POST /api/push/subscribe validates the subscription shape', async () => {
  assert.equal((await request('POST', '/push/subscribe', {}, ownToken)).status, 400);
  assert.equal((await request('POST', '/push/subscribe', { endpoint: 'https://x' }, ownToken)).status, 400);
  assert.equal((await request('POST', '/push/subscribe', { endpoint: 'https://x', keys: { p256dh: 'a' } }, ownToken)).status, 400);
  const r = await request('POST', '/push/subscribe', subscription(tag()), ownToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('POST /api/push/subscribe requires an active membership, same scope gate as other routes', async () => {
  const username = 'push-noscope-' + tag();
  await pool.query("INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,'agent')", [username, await bcrypt.hash('x', 10)]);
  const token = (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token;
  const r = await request('POST', '/push/subscribe', subscription(tag()), token);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'Accès au périmètre refusé' });
});

test('re-subscribing the same endpoint updates it in place (idempotent, ON CONFLICT)', async () => {
  const s = subscription(tag());
  await request('POST', '/push/subscribe', s, ownToken);
  const before = (await pool.get('SELECT count(*)::int n FROM public.push_subscriptions')).n;
  await request('POST', '/push/subscribe', { ...s, keys: { p256dh: 'changed', auth: s.keys.auth } }, ownToken);
  assert.equal((await pool.get('SELECT count(*)::int n FROM public.push_subscriptions')).n, before, 'no duplicate row');
  assert.equal((await pool.get('SELECT p256dh FROM public.push_subscriptions WHERE endpoint=$1', [s.endpoint])).p256dh, 'changed');
});

test('DELETE /api/push/subscribe removes only the caller\'s own subscription for that endpoint', async () => {
  const s = subscription(tag());
  await request('POST', '/push/subscribe', s, ownToken);
  // A different user's DELETE for the same endpoint must not remove someone else's row.
  await request('DELETE', '/push/subscribe', { endpoint: s.endpoint }, otherOwnToken);
  assert.equal((await pool.get('SELECT count(*)::int n FROM public.push_subscriptions WHERE endpoint=$1', [s.endpoint])).n, 1);
  const r = await request('DELETE', '/push/subscribe', { endpoint: s.endpoint }, ownToken);
  assert.equal(r.status, 200);
  assert.equal((await pool.get('SELECT count(*)::int n FROM public.push_subscriptions WHERE endpoint=$1', [s.endpoint])).n, 0);
});

test('alert.create delivers a push to a subscribed soc user, payload is {type, id, at} only', async () => {
  await request('POST', '/push/subscribe', subscription(tag()), socToken);
  const before = fakeProvider.all().length;
  const created = (await request('POST', '/alerts', { site: 'Push-Site', type: 'Push-Type', level: 4, comment: 'sensitive' }, socToken)).body;
  assert.ok(await waitFor(() => fakeProvider.all().length > before));
  const delivered = fakeProvider.all().slice(before);
  assert.ok(delivered.length >= 1);
  const payload = JSON.parse(delivered[delivered.length - 1].payload);
  assert.deepEqual(Object.keys(payload).sort(), ['at', 'id', 'type']);
  assert.equal(payload.type, 'alert:created');
  assert.equal(payload.id, created.id);
  assert.doesNotMatch(delivered[delivered.length - 1].payload, /Push-Site|Push-Type|sensitive/);
});

test('own subscriber receives push only for their own alert, never another own user\'s', async () => {
  // push_subscriptions persists across tests in this file (no cleanup
  // between them, matching real usage): earlier tests' soc subscriptions are
  // legitimately tenant-scoped and WILL receive this alert's push too. Filter
  // deliveries down to this test's own endpoint rather than a raw global count.
  const s = subscription(tag());
  await request('POST', '/push/subscribe', s, otherOwnToken); // "own" access, different creator
  await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, ownToken); // created by a DIFFERENT own user
  await new Promise(r => setTimeout(r, 200)); // let any (unwanted) delivery settle
  const toThisEndpoint = fakeProvider.all().filter(x => x.subscription.endpoint === s.endpoint);
  assert.equal(toThisEndpoint.length, 0, 'no push delivered to an unrelated own subscriber');
});

test('scope subscriber (soc) receives push for an alert created by any user under the tenant', async () => {
  await request('POST', '/push/subscribe', subscription(tag()), socToken);
  const before = fakeProvider.all().length;
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, ownToken)).body;
  assert.ok(await waitFor(() => fakeProvider.all().length > before));
  const payload = JSON.parse(fakeProvider.all().at(-1).payload);
  assert.equal(payload.id, created.id);
});

test('a real provider can be swapped in via setProvider and restored', async () => {
  const calls = [];
  const custom = { send: async (subscription, payload) => { calls.push({ subscription, payload }); return { ok: true }; } };
  push.setProvider(custom);
  try {
    await request('POST', '/push/subscribe', subscription(tag()), socToken);
    await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, socToken);
    assert.ok(await waitFor(() => calls.length > 0));
  } finally { push.setProvider(fakeProvider); }
  assert.equal(push.getProvider(), fakeProvider, 'restored to the default fake provider');
});

test('an expired subscription (provider reports expired) is removed automatically', async () => {
  const s = subscription(tag());
  await request('POST', '/push/subscribe', s, socToken);
  const expiring = { send: async () => ({ ok: false, expired: true }) };
  push.setProvider(expiring);
  try {
    await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, socToken);
    assert.ok(await waitFor(async () => (await pool.get('SELECT count(*)::int n FROM public.push_subscriptions WHERE endpoint=$1', [s.endpoint])).n === 0));
  } finally { push.setProvider(fakeProvider); }
});

test('PCS01 (Lot B): GET /push/public-key returns null when no real VAPID key is configured (the honest, current production state)', async () => {
  delete process.env.SECURISITE_VAPID_PUBLIC_KEY;
  const r = await request('GET', '/push/public-key', undefined, ownToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { publicKey: null });
});

test('PCS01 (Lot B): GET /push/public-key reflects a configured key verbatim, never invented', async t => {
  process.env.SECURISITE_VAPID_PUBLIC_KEY = 'a-test-public-key-value';
  t.after(() => { delete process.env.SECURISITE_VAPID_PUBLIC_KEY; });
  const r = await request('GET', '/push/public-key', undefined, ownToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { publicKey: 'a-test-public-key-value' });
});

test('PCS01 (Lot B): GET /push/public-key requires the same authentication/scope as the rest of /push (never a special-cased public route)', async () => {
  assert.equal((await request('GET', '/push/public-key', undefined, null)).status, 401);
});

test('readiness requires push_subscriptions to exist (no append-only guard, no RLS: a device state table)', async () => {
  assert.deepEqual(PUSH, ['push_subscriptions']);
  assert.equal(PRIVILEGES.push_subscriptions, 'SELECT,INSERT,UPDATE,DELETE');
  assert.equal(await assertReady(pool, { directory }), undefined);
});

test('readiness fails if push_subscriptions is absent', async t => {
  await pool.query('ALTER TABLE public.push_subscriptions RENAME TO push_subscriptions_renamed');
  t.after(() => pool.query('ALTER TABLE public.push_subscriptions_renamed RENAME TO push_subscriptions'));
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_TABLE_MISSING' && /push_subscriptions/.test(e.message));
});
