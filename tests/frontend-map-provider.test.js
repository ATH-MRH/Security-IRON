'use strict';
// PG-17 — unit test of frontend/js/map-provider.js's pure geometry
// (MapGeometry.bounds/projector). No DOM, no fake external map provider:
// this only proves the coordinate <-> relative-plane math is correct.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/map-provider.js'), 'utf8');
function load() {
  const context = vm.createContext({});
  new vm.Script(source, { filename: 'map-provider.js' }).runInContext(context);
  return new vm.Script('MapGeometry').runInContext(context);
}

test('bounds() is null with no points and with only points missing GPS', () => {
  const { bounds } = load();
  assert.equal(bounds([]), null);
  assert.equal(bounds([{ latitude: null, longitude: null }, { latitude: NaN, longitude: 3 }]), null);
});

test('bounds() ignores points without a valid GPS pair but keeps the valid ones', () => {
  const { bounds } = load();
  const b = bounds([{ latitude: 10, longitude: 20 }, { latitude: null, longitude: null }, { latitude: 30, longitude: 5 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), { minLat: 10, maxLat: 30, minLng: 5, maxLng: 20 });
});

test('projector() centers a single point rather than dividing by zero', () => {
  const { bounds, projector } = load();
  const b = bounds([{ latitude: 36.75, longitude: 3.04 }]);
  const project = projector(b, { width: 1000, height: 1000, padding: 60 });
  const p = project(36.75, 3.04);
  assert.equal(p.x, 500); assert.equal(p.y, 500);
});

test('projector() places the four corners of a real bounding box correctly, Y flipped for north-up', () => {
  const { bounds, projector } = load();
  const b = bounds([{ latitude: 0, longitude: 0 }, { latitude: 10, longitude: 10 }]);
  const project = projector(b, { width: 1000, height: 1000, padding: 0 });
  // North (higher latitude) must render nearer the top (smaller y).
  const north = project(10, 5), south = project(0, 5);
  assert.ok(north.y < south.y, 'higher latitude renders higher on screen (smaller y)');
  const west = project(5, 0), east = project(5, 10);
  assert.ok(west.x < east.x, 'higher longitude renders further right (larger x)');
});

test('projector() respects padding: no point lands outside [padding, size-padding]', () => {
  const { bounds, projector } = load();
  const b = bounds([{ latitude: 1, longitude: 1 }, { latitude: 50, longitude: 50 }]);
  const project = projector(b, { width: 1000, height: 800, padding: 60 });
  for (const [lat, lng] of [[1, 1], [50, 50], [25, 25]]) {
    const p = project(lat, lng);
    assert.ok(p.x >= 60 && p.x <= 940, 'x within padded bounds');
    assert.ok(p.y >= 60 && p.y <= 740, 'y within padded bounds');
  }
});

test('projector() returns null for a non-finite lat/lng, and a no-op function when box is null', () => {
  const { bounds, projector } = load();
  const project = projector(bounds([{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }]));
  assert.equal(project(NaN, 1), null);
  assert.equal(project(1, undefined), null);
  assert.equal(projector(null)(1, 1), null);
});
