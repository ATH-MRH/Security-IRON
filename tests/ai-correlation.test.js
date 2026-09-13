'use strict';
// PG-22 — unit test of backend/ai/correlation.js's pure signal computation
// (computeSignals). No database: rows are shaped exactly like a real
// service.list() response. Proves each signal carries its own exact
// evidence, and that no signal ever references a person (created_by/
// username) — only sites/types/equipment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSignals } = require('../backend/ai/correlation');

let seq = 0;
function alert(overrides = {}) {
  seq++;
  return {
    id: 'ALT-' + seq, site: 'Site A', zone: null, type: 'Intrusion', level: 2, status: 'NOTIFIEE',
    origin: 'COMMAND', equipment: null, escalation_step: 0, created_at: '2026-06-15T10:00:00.000Z',
    created_by: 999, username: 'someone', // deliberately present on the input, must never leak into a signal
    ...overrides,
  };
}
const at = (base, minutesLater) => new Date(Date.parse(base) + minutesLater * 60000).toISOString();

test('no alerts: no signals, never an error', () => {
  assert.deepEqual(computeSignals([]), []);
  assert.deepEqual(computeSignals(undefined), []);
});

test('a single alert never produces a "repeated" signal', () => {
  assert.deepEqual(computeSignals([alert()]), []);
});

test('repeated_alerts_same_site_type: two alerts, same site+type, within the window', () => {
  const a = alert({ id: 'a1', site: 'Site A', type: 'Intrusion', created_at: '2026-06-15T10:00:00.000Z' });
  const b = alert({ id: 'a2', site: 'Site A', type: 'Intrusion', created_at: at(a.created_at, 10) });
  const signals = computeSignals([a, b], { windowMinutes: 60 });
  const s = signals.find(x => x.kind === 'repeated_alerts_same_site_type');
  assert.ok(s);
  assert.equal(s.count, 2);
  assert.deepEqual(s.evidence.map(e => e.id).sort(), ['a1', 'a2']);
  assert.equal(s.score, 2 / 5);
});

test('repeated_alerts_same_site_type does not fire when the gap exceeds the window', () => {
  const a = alert({ site: 'Site A', type: 'Intrusion', created_at: '2026-06-15T10:00:00.000Z' });
  const b = alert({ site: 'Site A', type: 'Intrusion', created_at: at(a.created_at, 120) });
  assert.deepEqual(computeSignals([a, b], { windowMinutes: 60 }), []);
});

test('multi_site_pattern: same type, two different sites, close in time', () => {
  const a = alert({ id: 'a1', site: 'Site A', type: 'Sabotage', created_at: '2026-06-15T10:00:00.000Z' });
  const b = alert({ id: 'a2', site: 'Site B', type: 'Sabotage', created_at: at(a.created_at, 5) });
  const signals = computeSignals([a, b], { windowMinutes: 60 });
  const s = signals.find(x => x.kind === 'multi_site_pattern');
  assert.ok(s);
  assert.deepEqual(s.sites.sort(), ['Site A', 'Site B']);
  assert.deepEqual(s.evidence.map(e => e.id).sort(), ['a1', 'a2']);
});

test('multi_site_pattern never fires for the same site repeated (that is a different signal)', () => {
  const a = alert({ site: 'Site A', type: 'Sabotage', created_at: '2026-06-15T10:00:00.000Z' });
  const b = alert({ site: 'Site A', type: 'Sabotage', created_at: at(a.created_at, 5) });
  const signals = computeSignals([a, b]);
  assert.ok(!signals.some(s => s.kind === 'multi_site_pattern'));
});

test('escalation_cluster: two or more escalated alerts on the same site', () => {
  const rows = [
    alert({ id: 'a1', site: 'Site A', escalation_step: 1 }),
    alert({ id: 'a2', site: 'Site A', escalation_step: 2 }),
    alert({ id: 'a3', site: 'Site B', escalation_step: 1 }), // different site: no cluster there alone
  ];
  const signals = computeSignals(rows);
  const s = signals.find(x => x.kind === 'escalation_cluster');
  assert.ok(s);
  assert.equal(s.site, 'Site A');
  assert.equal(s.count, 2);
  assert.ok(!signals.some(x => x.kind === 'escalation_cluster' && x.site === 'Site B'));
});

test('repeated_badge_refusals: two REGLE_BADGE alerts on the same equipment', () => {
  const rows = [
    alert({ id: 'a1', origin: 'REGLE_BADGE', equipment: 'badge:123' }),
    alert({ id: 'a2', origin: 'REGLE_BADGE', equipment: 'badge:123' }),
    alert({ id: 'a3', origin: 'REGLE_BADGE', equipment: 'badge:999' }),
  ];
  const signals = computeSignals(rows);
  const s = signals.find(x => x.kind === 'repeated_badge_refusals');
  assert.ok(s);
  assert.equal(s.equipment, 'badge:123');
  assert.equal(s.count, 2);
});

test('nearby_incidents: two INCIDENT-origin alerts on the same site, close in time', () => {
  const a = alert({ id: 'a1', origin: 'INCIDENT', site: 'Site A', created_at: '2026-06-15T10:00:00.000Z' });
  const b = alert({ id: 'a2', origin: 'INCIDENT', site: 'Site A', created_at: at(a.created_at, 20) });
  const signals = computeSignals([a, b], { windowMinutes: 60 });
  const s = signals.find(x => x.kind === 'nearby_incidents');
  assert.ok(s);
  assert.equal(s.site, 'Site A');
});

test('no signal ever references a person: created_by/username never appear in evidence or the signal itself', () => {
  const a = alert({ id: 'a1', site: 'Site A', type: 'Intrusion', created_by: 42, username: 'agent-x' });
  const b = alert({ id: 'a2', site: 'Site A', type: 'Intrusion', created_by: 42, username: 'agent-x', created_at: at(a.created_at, 5) });
  const signals = computeSignals([a, b]);
  const serialised = JSON.stringify(signals);
  assert.doesNotMatch(serialised, /created_by|agent-x|username/);
});

test('every signal has a bounded score in [0,1] and a non-empty explanation and evidence', () => {
  const rows = [
    alert({ id: 'a1', site: 'Site A', type: 'T', created_at: '2026-06-15T10:00:00.000Z' }),
    alert({ id: 'a2', site: 'Site A', type: 'T', created_at: at('2026-06-15T10:00:00.000Z', 5) }),
    alert({ id: 'a3', site: 'Site A', type: 'T', created_at: at('2026-06-15T10:00:00.000Z', 10) }),
  ];
  const signals = computeSignals(rows);
  for (const s of signals) {
    assert.ok(s.score >= 0 && s.score <= 1, s.kind + ' score out of bounds');
    assert.ok(typeof s.explanation === 'string' && s.explanation.length > 0, s.kind + ' missing explanation');
    assert.ok(Array.isArray(s.evidence) && s.evidence.length >= 2, s.kind + ' missing evidence');
  }
});

test('a reasonable volume (500 alerts) computes without pathological slowness', () => {
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push(alert({
      site: 'Site ' + (i % 5), type: 'Type ' + (i % 3),
      origin: i % 7 === 0 ? 'REGLE_BADGE' : (i % 11 === 0 ? 'INCIDENT' : 'COMMAND'),
      equipment: i % 7 === 0 ? 'badge:' + (i % 4) : null,
      escalation_step: i % 6 === 0 ? 1 : 0,
      created_at: at('2026-06-15T00:00:00.000Z', i),
    }));
  }
  const start = Date.now();
  const signals = computeSignals(rows, { windowMinutes: 60 });
  assert.ok(Date.now() - start < 1000, 'correlation over 500 rows must stay reasonably fast');
  assert.ok(signals.length > 0);
});
