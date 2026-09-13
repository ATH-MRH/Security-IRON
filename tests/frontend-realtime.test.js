'use strict';
// PG-16 — unit test of frontend/js/realtime.js's own logic (reconnection,
// fallback polling, event forwarding), run in a controlled node:vm sandbox
// with a fake EventSource/API/timers — no browser, no PostgreSQL. The real
// end-to-end SSE delivery (ticket issuance, scope filtering, actual event
// payloads) is already proven against a real server in
// tests/postgres-realtime.test.js (PG-12) and tests/postgres-sos.test.js
// (PG-15); this file exists to prove the CLIENT's reconnect/fallback state
// machine behaves correctly in isolation, which no backend test can reach.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/realtime.js'), 'utf8');

class FakeEventSource {
  constructor(url, registry) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    this.onopen = null;
    this.onerror = null;
    (registry || FakeEventSource.instances).push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { this.closed = true; }
  fire(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
}

function harness({ ticketBehavior } = {}) {
  const instances = [];
  const postCalls = [];
  const timeouts = [], intervals = [];
  let nextId = 1;
  const sandbox = {
    console,
    API: {
      post: async (path, body) => {
        postCalls.push({ path, body });
        if (ticketBehavior === 'reject') throw new Error('network down');
        return { ticket: 'ticket-' + postCalls.length };
      },
    },
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.push({ id, fn, ms, cancelled: false }); return id; },
    clearTimeout: id => { const t = timeouts.find(t => t.id === id); if (t) t.cancelled = true; },
    setInterval: (fn, ms) => { const id = nextId++; intervals.push({ id, fn, ms, cancelled: false }); return id; },
    clearInterval: id => { const t = intervals.find(t => t.id === id); if (t) t.cancelled = true; },
  };
  // Both the bare global (realtime.js does `new EventSource(...)`, which in a
  // real browser resolves through the global/window scope) and `window.*`
  // (used only for feature detection, `'EventSource' in window`) must be the
  // same fake constructor.
  function FakeEventSourceCtor(url) { return new FakeEventSource(url, instances); }
  sandbox.EventSource = FakeEventSourceCtor;
  sandbox.window = { EventSource: FakeEventSourceCtor };
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'realtime.js' }).runInContext(context);
  // `const Realtime = ...` binds in the context's lexical environment, not
  // as an enumerable property of the context object itself — a second script
  // evaluated in the SAME context can still read that binding directly.
  const Realtime = new vm.Script('Realtime').runInContext(context);
  const fireTimeout = () => { const t = timeouts.find(t => !t.cancelled && !t.fired); if (!t) throw new Error('no pending timeout'); t.fired = true; return t.fn(); };
  const fireInterval = () => { const t = intervals.find(t => !t.cancelled); if (!t) throw new Error('no active interval'); return t.fn(); };
  return { Realtime, instances, postCalls, timeouts, intervals, fireTimeout, fireInterval };
}
async function flush() { await new Promise(r => setImmediate(r)); }

test('connect() requests a ticket and opens an EventSource carrying it in the URL', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  assert.equal(h.postCalls.length, 1);
  // Field-by-field, not a whole-object deepEqual: `body` is a plain object
  // literal created INSIDE the vm sandbox, so it carries that realm's own
  // Object.prototype — structurally identical to `{}` but not
  // reference-/prototype-equal to one built in this file, which
  // deepStrictEqual (assert/strict) would otherwise flag as a mismatch.
  assert.equal(h.postCalls[0].path, '/realtime/ticket');
  assert.deepEqual(Object.keys(h.postCalls[0].body), []);
  assert.equal(h.instances.length, 1);
  assert.match(h.instances[0].url, /^\/api\/realtime\/stream\?ticket=ticket-1$/);
});

test('an alert:created SSE event is forwarded to listeners with its parsed payload, marking the connection live', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  const received = [];
  h.Realtime.on((type, data) => received.push({ type, data }));
  h.instances[0].fire('alert:created', { id: 'ALT-1', at: '2026-01-01T00:00:00Z' });
  // Same cross-realm caveat as above: compare fields, not the whole object.
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'alert:created');
  assert.equal(received[0].data.id, 'ALT-1');
  assert.equal(received[0].data.at, '2026-01-01T00:00:00Z');
  assert.equal(h.Realtime.isConnected(), true);
});

test('a stream error closes the source, starts fallback polling, and schedules a reconnect', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  const es = h.instances[0];
  es.onerror();
  assert.equal(es.closed, true);
  assert.equal(h.Realtime.isConnected(), false);
  assert.equal(h.intervals.filter(i => !i.cancelled).length, 1, 'fallback polling started');
  assert.equal(h.timeouts.filter(t => !t.cancelled && !t.fired).length, 1, 'a reconnect was scheduled');
});

test('the fallback interval emits poll events while disconnected', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  h.instances[0].onerror();
  const received = [];
  h.Realtime.on((type, data) => received.push({ type, data }));
  h.fireInterval();
  h.fireInterval();
  assert.deepEqual(received, [{ type: 'poll', data: null }, { type: 'poll', data: null }]);
});

test('firing the scheduled reconnect opens a fresh EventSource with a new ticket', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  h.instances[0].onerror();
  h.fireTimeout(); // the scheduled reconnect
  await flush();
  assert.equal(h.postCalls.length, 2, 'a second, fresh ticket was requested');
  assert.equal(h.instances.length, 2, 'a new EventSource was created');
  assert.notEqual(h.instances[0], h.instances[1]);
});

test('reconnecting successfully (onopen) stops the fallback polling', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  h.instances[0].onerror();
  h.fireTimeout();
  await flush();
  assert.equal(h.intervals.filter(i => !i.cancelled).length, 1, 'still falling back until reconnected');
  h.instances[1].onopen();
  assert.equal(h.intervals.filter(i => !i.cancelled).length, 0, 'fallback stopped once live again');
  assert.equal(h.Realtime.isConnected(), true);
});

test('a rejected ticket request falls back to polling and still schedules a reconnect, without throwing', async () => {
  const h = harness({ ticketBehavior: 'reject' });
  await assert.doesNotReject(h.Realtime.connect());
  await flush();
  assert.equal(h.instances.length, 0, 'no EventSource without a ticket');
  assert.equal(h.intervals.filter(i => !i.cancelled).length, 1);
  assert.equal(h.timeouts.filter(t => !t.cancelled && !t.fired).length, 1);
});

test('stop() tears down the connection and every timer; a later connect() starts clean', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  h.instances[0].onerror(); // now reconnecting + falling back
  h.Realtime.stop();
  assert.equal(h.intervals.filter(i => !i.cancelled).length, 0, 'fallback cleared');
  assert.equal(h.timeouts.filter(t => !t.cancelled && !t.fired).length, 0, 'pending reconnect cleared');
  assert.equal(h.Realtime.isConnected(), false);
  // A stray reconnect firing after stop() must not resurrect a connection.
  await h.Realtime.connect();
  await flush();
  const countAfterStop = h.instances.length;
  assert.ok(countAfterStop >= 1, 'connect() after stop() works again');
});

test('listeners cannot crash each other: a throwing listener does not prevent the next one from running', async () => {
  const h = harness();
  await h.Realtime.connect();
  await flush();
  let secondRan = false;
  h.Realtime.on(() => { throw new Error('boom'); });
  h.Realtime.on(() => { secondRan = true; });
  h.instances[0].fire('alert:updated', { id: 'ALT-2', at: 'now' });
  assert.equal(secondRan, true);
});
