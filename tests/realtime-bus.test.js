'use strict';
// Audit SOS bout-en-bout : backend/realtime.js's in-memory event bus is the
// path a successful SOS/alert creation goes through (alert-core/service.js
// calls realtime.emit() right after the database transaction commits). A
// broken subscriber (e.g. an SSE stream whose socket just closed,
// backend/realtime-routes.js) must never crash the emitting request nor
// silence delivery to the OTHER, healthy subscribers — a regression here
// would turn an unrelated dead connection into a false "SOS failed" for a
// request that already succeeded in PostgreSQL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const realtime = require('../backend/realtime');

test('emit() never throws even when a subscriber listener throws', () => {
  const unsubscribe = realtime.subscribe(() => true, () => { throw new Error('boom: dead SSE socket'); });
  try {
    assert.doesNotThrow(() => realtime.emit('alert:created', { id: 'ALT-x', tenantId: 't1', createdBy: 1 }));
  } finally { unsubscribe(); }
});

test('a throwing subscriber never prevents delivery to other, healthy subscribers', () => {
  const seen = [];
  const unsubBroken = realtime.subscribe(() => true, () => { throw new Error('boom'); });
  const unsubHealthyBefore = realtime.subscribe(() => true, e => seen.push(['before', e.type]));
  const unsubHealthyAfter = realtime.subscribe(() => true, e => seen.push(['after', e.type]));
  try {
    realtime.emit('alert:created', { id: 'ALT-y', tenantId: 't1', createdBy: 1 });
    assert.deepEqual(seen, [['before', 'alert:created'], ['after', 'alert:created']],
      'both the subscriber registered before AND after the broken one must still receive the event');
  } finally { unsubBroken(); unsubHealthyBefore(); unsubHealthyAfter(); }
});

test('a scope filter (matches()) still applies correctly around the try/catch — an out-of-scope event never reaches onEvent at all', () => {
  let called = false;
  const unsubscribe = realtime.subscribe(() => false, () => { called = true; });
  try {
    realtime.emit('alert:created', { id: 'ALT-z', tenantId: 't2', createdBy: 2 });
    assert.equal(called, false);
  } finally { unsubscribe(); }
});

test('unsubscribe still works normally after a listener has thrown once', () => {
  let calls = 0;
  const unsubscribe = realtime.subscribe(() => true, () => { calls++; throw new Error('boom'); });
  realtime.emit('alert:created', { id: 'ALT-1' });
  assert.equal(calls, 1);
  unsubscribe();
  realtime.emit('alert:created', { id: 'ALT-2' });
  assert.equal(calls, 1, 'no further calls after unsubscribe, even though the listener always throws');
});
