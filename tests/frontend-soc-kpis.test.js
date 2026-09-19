'use strict';
// PG-16 — unit test of frontend/js/soc-kpis.js's pure aggregation logic.
// No simulated data: every case builds rows shaped exactly like a real
// GET /api/alerts response (backend/alert-core/repository.js's SELECT *),
// and asserts only on what those rows actually contain.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/soc-kpis.js'), 'utf8');
function load() {
  const context = vm.createContext({});
  new vm.Script(source, { filename: 'soc-kpis.js' }).runInContext(context);
  const sandboxed = new vm.Script('SocKpis').runInContext(context);
  // compute() returns plain objects built in the vm's own realm (its own
  // Object.prototype) — deepEqual/deepStrictEqual would flag them as
  // mismatched against an outer-realm literal even when structurally
  // identical. Re-serialize once here so every call site gets a normal,
  // this-realm object without repeating that workaround per assertion.
  return { compute: (...args) => JSON.parse(JSON.stringify(sandboxed.compute(...args))) };
}

const NOW = new Date('2026-06-15T12:00:00.000Z');
let seq = 0;
function alert(overrides = {}) {
  seq++;
  return {
    id: 'ALT-' + seq, level: 1, status: 'NOTIFIEE', site: 'Site A', zone: null,
    created_at: NOW.toISOString(), acknowledged_at: null, escalation_step: 0,
    ...overrides,
  };
}

test('empty dashboard: every KPI is zero/null, never an error', () => {
  const { compute } = load();
  const r = compute([], NOW);
  assert.deepEqual(r, {
    active: 0, critical: 0, sos: 0, unacknowledged: 0, escalated: 0, today: 0, yesterday: 0,
    dailySeries: [
      { date: new Date('2026-06-09T12:00:00.000Z').toDateString(), count: 0 },
      { date: new Date('2026-06-10T12:00:00.000Z').toDateString(), count: 0 },
      { date: new Date('2026-06-11T12:00:00.000Z').toDateString(), count: 0 },
      { date: new Date('2026-06-12T12:00:00.000Z').toDateString(), count: 0 },
      { date: new Date('2026-06-13T12:00:00.000Z').toDateString(), count: 0 },
      { date: new Date('2026-06-14T12:00:00.000Z').toDateString(), count: 0 },
      { date: new Date('2026-06-15T12:00:00.000Z').toDateString(), count: 0 },
    ],
    avgAckSeconds: null, bySite: [],
  });
});

// MISSION KPI (Centre d'alertes) : "Alertes aujourd'hui" est la SEULE des 6
// cartes pour laquelle une évolution/un mini-graphique réels existent — les
// cinq autres sont des états instantanés, sans relevé historique (voir le
// commentaire dans soc-kpis.js). yesterday/dailySeries sont ce que le
// nouveau rendu (frontend/js/alerts.js) utilise pour cette carte précise.
test('yesterday counts alerts created exactly one calendar day before `now`, never a 24h rolling window', () => {
  const { compute } = load();
  const rows = [
    alert({ created_at: '2026-06-14T23:59:00.000Z' }), // yesterday, late
    alert({ created_at: '2026-06-14T00:01:00.000Z' }), // yesterday, early
    alert({ created_at: '2026-06-13T23:00:00.000Z' }), // two days ago: excluded
    alert({ created_at: '2026-06-15T09:00:00.000Z' }), // today: excluded from yesterday
  ];
  assert.equal(compute(rows, NOW).yesterday, 2);
});

test('dailySeries has exactly 7 points (6 days ago through today), each a real per-day count', () => {
  const { compute } = load();
  const rows = [
    alert({ created_at: '2026-06-15T08:00:00.000Z' }), // today
    alert({ created_at: '2026-06-15T09:00:00.000Z' }), // today
    alert({ created_at: '2026-06-13T08:00:00.000Z' }), // 2 days ago
    alert({ created_at: '2026-05-01T08:00:00.000Z' }), // outside the 7-day window: excluded
  ];
  const series = compute(rows, NOW).dailySeries;
  assert.equal(series.length, 7);
  assert.equal(series[6].count, 2, 'last point is today');
  assert.equal(series[4].count, 1, '2 days ago has exactly one point (index 6-2=4)');
  assert.equal(series.reduce((s, p) => s + p.count, 0), 3, 'the alert from a month ago never leaks into this 7-day window');
});

test('compute() tolerates a non-array input (e.g. a transient error payload) without throwing', () => {
  const { compute } = load();
  assert.equal(compute(undefined, NOW).active, 0);
  assert.equal(compute(null, NOW).active, 0);
});

test('active excludes every terminal status, never a false positive', () => {
  const { compute } = load();
  const rows = [
    alert({ status: 'NOTIFIEE' }), alert({ status: 'ACQUITTEE' }), alert({ status: 'EN_INTERVENTION' }),
    alert({ status: 'CLOTUREE' }), alert({ status: 'FAUSSE_ALERTE' }), alert({ status: 'ANNULEE' }),
  ];
  assert.equal(compute(rows, NOW).active, 3);
});

test('RESOLUE is not terminal (a Clôturer action is still offered on it) but is not "active" either: same semantics alerts.js already had', () => {
  const { compute } = load();
  const rows = [alert({ status: 'NOTIFIEE' }), alert({ status: 'RESOLUE' })];
  assert.equal(compute(rows, NOW).active, 1);
});

test('critical (level>=3) and sos (level=4) only count active alerts', () => {
  const { compute } = load();
  const rows = [
    alert({ level: 3 }), alert({ level: 4 }), alert({ level: 4, status: 'CLOTUREE' }), // closed SOS must not count
    alert({ level: 2 }),
  ];
  const r = compute(rows, NOW);
  assert.equal(r.critical, 2); // the two active level>=3 (3 and 4)
  assert.equal(r.sos, 1); // only the active level-4
});

test('unacknowledged counts active NOTIFIEE alerts only', () => {
  const { compute } = load();
  const rows = [alert({ status: 'NOTIFIEE' }), alert({ status: 'NOTIFIEE', acknowledged_at: NOW.toISOString() }), alert({ status: 'ACQUITTEE' })];
  // Note: the real system never leaves acknowledged_at set while status stays
  // NOTIFIEE, but the KPI must be robust to any row shape it is actually given.
  assert.equal(compute(rows, NOW).unacknowledged, 2);
});

test('escalated counts only active alerts with a real escalation step', () => {
  const { compute } = load();
  const rows = [alert({ escalation_step: 1 }), alert({ escalation_step: 2 }), alert({ escalation_step: 0 }), alert({ escalation_step: 1, status: 'CLOTUREE' })];
  assert.equal(compute(rows, NOW).escalated, 2);
});

test('avgAckSeconds is null with no acknowledged alert today, and a real average otherwise', () => {
  const { compute } = load();
  assert.equal(compute([alert()], NOW).avgAckSeconds, null);
  const rows = [
    alert({ created_at: '2026-06-15T10:00:00.000Z', acknowledged_at: '2026-06-15T10:00:30.000Z' }), // 30s
    alert({ created_at: '2026-06-15T10:00:00.000Z', acknowledged_at: '2026-06-15T10:01:30.000Z' }), // 90s
  ];
  assert.equal(compute(rows, NOW).avgAckSeconds, 60);
});

test('avgAckSeconds only considers alerts created today, never older ones', () => {
  const { compute } = load();
  const rows = [
    alert({ created_at: '2026-06-14T10:00:00.000Z', acknowledged_at: '2026-06-14T10:10:00.000Z' }), // yesterday: 600s, excluded
    alert({ created_at: '2026-06-15T10:00:00.000Z', acknowledged_at: '2026-06-15T10:00:10.000Z' }), // today: 10s
  ];
  assert.equal(compute(rows, NOW).avgAckSeconds, 10);
});

test('bySite groups active alerts by their real submitted site, sorted by count then name, blank site labelled explicitly', () => {
  const { compute } = load();
  const rows = [
    alert({ site: 'Site B' }), alert({ site: 'Site B' }), alert({ site: 'Site A' }),
    alert({ site: '  ' }), alert({ site: 'Site A', status: 'CLOTUREE' }), // closed: excluded from bySite
  ];
  const r = compute(rows, NOW);
  assert.deepEqual(r.bySite, [
    { site: 'Site B', count: 2 },
    { site: '(site non renseigné)', count: 1 },
    { site: 'Site A', count: 1 },
  ]);
});

test('a reasonable large volume (2000 alerts) computes correctly and without pathological slowness', () => {
  const { compute } = load();
  const rows = [];
  const sites = ['Site A', 'Site B', 'Site C', 'Site D'];
  for (let i = 0; i < 2000; i++) {
    rows.push(alert({
      level: (i % 4) + 1,
      status: ['NOTIFIEE', 'ACQUITTEE', 'EN_INTERVENTION', 'CLOTUREE'][i % 4],
      site: sites[i % sites.length],
      escalation_step: i % 5 === 0 ? 1 : 0,
      created_at: NOW.toISOString(),
      acknowledged_at: i % 3 === 0 ? new Date(NOW.getTime() + (i % 200) * 1000).toISOString() : null,
    }));
  }
  const start = Date.now();
  const r = compute(rows, NOW);
  assert.ok(Date.now() - start < 200, 'client-side aggregation of 2000 rows must stay fast');
  assert.equal(r.active, rows.filter(a => a.status !== 'CLOTUREE').length);
  assert.equal(r.bySite.reduce((s, x) => s + x.count, 0), r.active);
  assert.ok(r.avgAckSeconds !== null);
});
