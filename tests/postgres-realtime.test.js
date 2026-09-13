'use strict';
// PG-12 — temps réel minimal (backend/realtime.js + backend/realtime-routes.js) :
// bus en mémoire diffusé via Server-Sent Events. Couvre : émission/consommation
// de ticket à usage unique, authentification Bearer directe, refus sans
// authentification, refus de périmètre, livraison réelle d'un événement
// alert:created/alert:updated, filtrage own/scope, et absence de contenu
// (l'événement ne porte jamais que id/at, jamais l'alerte elle-même).
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
const dbName = 'securisite_test_realtime_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

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

// AbortController, not just reader.cancel(): a streaming SSE response never
// sends its own Content-Length/end (the server keeps it open until the
// client disconnects) — only an explicit abort reliably tears down the
// underlying socket in undici's connection pool. Without it, "cancelled"
// streams can linger and starve later fetches in the same test file.
async function openStream(auth) {
  const controller = new AbortController();
  const url = base + '/api/realtime/stream' + (auth.ticket ? '?ticket=' + auth.ticket : '');
  const r = await fetch(url, { headers: auth.token ? { Authorization: 'Bearer ' + auth.token } : {}, signal: controller.signal });
  r.close = () => controller.abort();
  return r;
}
async function readEvents(response, count, timeoutMs = 4000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (events.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const outcome = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), remaining)),
      ]);
      if (outcome.timedOut || outcome.done) break;
      buffer += decoder.decode(outcome.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        if (raw.startsWith(':') || !raw.trim()) continue;
        const lines = raw.split('\n');
        const typeLine = lines.find(l => l.startsWith('event: '));
        const dataLine = lines.find(l => l.startsWith('data: '));
        if (typeLine && dataLine) events.push({ type: typeLine.slice(7), data: JSON.parse(dataLine.slice(6)), raw });
      }
    }
  } finally {
    // Abort first: a reader.read() left in flight by the Promise.race timeout
    // above still holds the stream's lock, and reader.cancel() racing against
    // that outstanding read can leave the underlying connection only
    // half-torn-down. Aborting the fetch itself is unconditional and
    // authoritative regardless of the reader's lock state.
    response.close?.();
    await reader.cancel().catch(() => {});
  }
  return events;
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  socId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rt-soc',$1,'admin') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  ownId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rt-own',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  otherOwnId = (await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rt-own2',$1,'agent') RETURNING id", [await bcrypt.hash('x', 10)])).id;
  await seedMembership(pool, socId, 'admin');
  await seedMembership(pool, ownId, 'agent');
  await seedMembership(pool, otherOwnId, 'agent');

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  socToken = (await request('POST', '/auth/login', { username: 'rt-soc', password: 'x' }, null)).body.token;
  ownToken = (await request('POST', '/auth/login', { username: 'rt-own', password: 'x' }, null)).body.token;
  otherOwnToken = (await request('POST', '/auth/login', { username: 'rt-own2', password: 'x' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('POST /api/realtime/ticket requires authentication and returns a short-lived single-use ticket', async () => {
  assert.equal((await request('POST', '/realtime/ticket', undefined, null)).status, 401);
  const r = await request('POST', '/realtime/ticket', undefined, socToken);
  assert.equal(r.status, 200);
  assert.ok(r.body.ticket && typeof r.body.ticket === 'string');
  assert.equal(r.body.expiresIn, 30);
});

test('GET /stream refuses a request with neither a Bearer token nor a ticket', async () => {
  const r = await openStream({});
  assert.equal(r.status, 401);
});

test('GET /stream refuses an invalid ticket, and a ticket is consumed exactly once', async () => {
  assert.equal((await openStream({ ticket: 'not-a-real-ticket' })).status, 401);
  const ticket = (await request('POST', '/realtime/ticket', undefined, socToken)).body.ticket;
  const first = await openStream({ ticket });
  assert.equal(first.status, 200);
  first.close();
  const second = await openStream({ ticket });
  assert.equal(second.status, 401, 'a consumed ticket must never work twice');
});

test('GET /stream refuses a user with no active membership (same 403 as other scoped routes)', async () => {
  const username = 'rt-noscope-' + randomBytes(3).toString('hex');
  await pool.query("INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,'agent')", [username, await bcrypt.hash('x', 10)]);
  const token = (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token;
  const r = await openStream({ token });
  assert.equal(r.status, 403);
  assert.deepEqual(JSON.parse(await r.text()), { error: 'Accès au périmètre refusé' });
});

test('a direct Bearer token opens the stream (no ticket required for a client that can send headers)', async () => {
  const r = await openStream({ token: socToken });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  r.close();
});

test('alert.create delivers alert:created on the stream with only {id, at} — never the alert content', async () => {
  const stream = await openStream({ token: socToken });
  assert.equal(stream.status, 200);
  const pending = readEvents(stream, 1);
  await new Promise(r => setTimeout(r, 50)); // let the subscription attach before the mutation fires
  const created = (await request('POST', '/alerts', { site: 'RT-Site', type: 'RT-Type', level: 4, comment: 'sensitive detail' }, socToken)).body;
  const events = await pending;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'alert:created');
  assert.deepEqual(Object.keys(events[0].data).sort(), ['at', 'id']);
  assert.equal(events[0].data.id, created.id);
  assert.doesNotMatch(events[0].raw, /RT-Site|RT-Type|sensitive detail/);
});

test('alert.action delivers alert:updated', async () => {
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, socToken)).body;
  const stream = await openStream({ token: socToken });
  const pending = readEvents(stream, 1);
  await new Promise(r => setTimeout(r, 50));
  await request('POST', `/alerts/${created.id}/actions`, { action: 'ACQUITTEE' }, socToken);
  const events = await pending;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'alert:updated');
  assert.equal(events[0].data.id, created.id);
});

test('scope: a soc/scope subscriber receives another user\'s alert; an own subscriber never does', async () => {
  const socStream = await openStream({ token: socToken });
  const ownStream = await openStream({ token: otherOwnToken }); // "own" access, different user than the creator
  const socPending = readEvents(socStream, 1);
  const ownPending = readEvents(ownStream, 1, 800); // short timeout: expected to receive nothing
  await new Promise(r => setTimeout(r, 50));
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, ownToken)).body; // created by a DIFFERENT own user
  const [socEvents, ownEvents] = await Promise.all([socPending, ownPending]);
  assert.equal(socEvents.length, 1, 'scope subscriber sees every alert under the tenant');
  assert.equal(socEvents[0].data.id, created.id);
  assert.equal(ownEvents.length, 0, 'an own subscriber never receives another user\'s alert event');
});

test('an own subscriber does receive its own alert:created', async () => {
  const stream = await openStream({ token: ownToken });
  const pending = readEvents(stream, 1);
  await new Promise(r => setTimeout(r, 50));
  const created = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, ownToken)).body;
  const events = await pending;
  assert.equal(events.length, 1);
  assert.equal(events[0].data.id, created.id);
});

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return predicate();
}

// Raw node:http instead of fetch for this one test: fetch/undici keep-alive
// pooling made the property genuinely hard to observe deterministically (a
// still-settling abort from an earlier test could make a later fetch look
// stuck). A plain http.request gives direct control over the socket
// (req.destroy()), independent of any client-side connection pool.
async function rawStream(token) {
  const http = require('node:http');
  const u = new URL(base + '/api/realtime/stream');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Authorization: 'Bearer ' + token } });
    req.on('response', res => resolve({ res, destroy: () => req.destroy() }));
    req.on('error', reject);
    req.end();
  });
}

test('disconnecting a stream detaches its subscription: listenerCount returns to baseline', async () => {
  // Earlier tests' connections (closed via an aborted fetch) can take a
  // moment for the server's own `req.close` to fire — TCP teardown isn't
  // instantaneous. Wait for the count to actually settle before capturing a
  // baseline, or a still-closing earlier connection can transiently inflate
  // it and mask this test's own attach/detach transitions.
  assert.ok(await waitFor(() => realtime.listenerCount() === 0), 'earlier connections settle to zero before this test starts');
  const baseline = 0;
  for (let i = 0; i < 5; i++) {
    const { res, destroy } = await rawStream(socToken);
    assert.equal(res.statusCode, 200);
    res.resume(); // drain — a paused response can stall the socket's close handshake
    assert.ok(await waitFor(() => realtime.listenerCount() === baseline + 1), 'attached while connected, pass ' + i);
    destroy();
    assert.ok(await waitFor(() => realtime.listenerCount() === baseline), 'detached after the socket is destroyed, pass ' + i);
  }
});
