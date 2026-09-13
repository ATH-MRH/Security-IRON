'use strict';
// PG-17 — unit test of frontend/js/map.js's pure marker computation
// (computeMapMarkers). No simulated data: sites/alerts are shaped exactly
// like the real GET /api/map/sites and GET /api/alerts responses. DOM
// rendering (SiteMap) is exercised indirectly here only through this pure
// function — no fake external map provider is involved anywhere.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const providerSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/map-provider.js'), 'utf8');
const mapSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/map.js'), 'utf8');

function load() {
  const context = vm.createContext({});
  new vm.Script(providerSource, { filename: 'map-provider.js' }).runInContext(context);
  new vm.Script(mapSource, { filename: 'map.js' }).runInContext(context);
  const sandboxed = new vm.Script('MapMarkers').runInContext(context);
  // Re-serialize once at the sandbox boundary: same cross-realm deepEqual
  // gotcha already documented in tests/frontend-soc-kpis.test.js.
  return (...args) => JSON.parse(JSON.stringify(sandboxed.compute(...args)));
}

function site(overrides = {}) { return { id: 's1', code: 's1', name: 'Site A', latitude: 36.75, longitude: 3.04, ...overrides }; }
let seq = 0;
function alertRow(overrides = {}) {
  seq++;
  return {
    id: 'ALT-' + seq, type: 'Intrusion', level: 2, status: 'NOTIFIEE', site: 'Site A',
    created_at: '2026-06-15T10:00:00.000Z', latitude: 36.76, longitude: 3.05, ...overrides,
  };
}

test('no sites and no geolocated alert: null box, no markers, never an error', () => {
  const compute = load();
  assert.deepEqual(compute([], []), { box: null, markers: [] });
  assert.deepEqual(compute(undefined, undefined), { box: null, markers: [] });
});

test('a site without GPS is skipped, never plotted at a fabricated position', () => {
  const compute = load();
  const r = compute([site({ latitude: null, longitude: null })], []);
  assert.deepEqual(r, { box: null, markers: [] });
});

test('a site with GPS produces exactly one "site" marker', () => {
  const compute = load();
  const r = compute([site()], []);
  assert.equal(r.markers.length, 1);
  assert.equal(r.markers[0].kind, 'site');
  assert.equal(r.markers[0].id, 's1');
  assert.ok(Number.isFinite(r.markers[0].x) && Number.isFinite(r.markers[0].y));
});

test('an active geolocated alert produces an "alert" marker; a level-4 one is "sos"', () => {
  const compute = load();
  const r = compute([], [alertRow({ level: 2 }), alertRow({ level: 4 })]);
  assert.equal(r.markers.length, 2);
  assert.deepEqual(r.markers.map(m => m.kind).sort(), ['alert', 'sos']);
});

test('a closed/cancelled/false-alarm/resolved alert is never plotted', () => {
  const compute = load();
  const r = compute([], [
    alertRow({ status: 'CLOTUREE' }), alertRow({ status: 'ANNULEE' }),
    alertRow({ status: 'FAUSSE_ALERTE' }), alertRow({ status: 'RESOLUE' }),
  ]);
  assert.deepEqual(r, { box: null, markers: [] });
});

test('an alert without GPS is skipped, a site without GPS does not block other markers', () => {
  const compute = load();
  const r = compute([site(), site({ id: 's2', latitude: null, longitude: null })], [alertRow({ latitude: null, longitude: null })]);
  assert.equal(r.markers.length, 1);
  assert.equal(r.markers[0].kind, 'site');
});

test('sites and active alerts share the same bounding box, so relative positions stay coherent', () => {
  const compute = load();
  const r = compute([site({ latitude: 0, longitude: 0 })], [alertRow({ latitude: 10, longitude: 10 })]);
  assert.deepEqual(r.box, { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 });
  const s = r.markers.find(m => m.kind === 'site'), a = r.markers.find(m => m.kind === 'alert');
  assert.ok(a.y < s.y, 'the higher-latitude alert renders above the site');
});
