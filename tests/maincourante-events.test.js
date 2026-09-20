'use strict';
// Référentiel de codification Main courante (backend/maincourante-events.js) :
// tests unitaires purs, sans base de données — la validation serveur de
// POST /maincourante (backend/routes.js) est elle-même couverte avec une
// vraie base dans tests/postgres-maincourante.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mcEvents = require('../backend/maincourante-events');

test('every code from the official business grid is present exactly once', () => {
  const expected = [
    '10.00','10.01','10.02','10.03','10.04','10.05','10.06','10.07','10.08','10.09',
    '10.10','10.11','10.12','10.13','10.14','10.15','10.16','10.17','10.18','10.19','10.20','10.21',
    '15.01','15.02','15.03','15.04','15.70','15.80','15.100',
  ];
  const codes = mcEvents.EVENTS.map(e => e.code);
  assert.deepEqual([...codes].sort(), [...expected].sort());
  assert.equal(new Set(codes).size, codes.length, 'no duplicate code');
});

test('15.04, 15.70 and 15.80 have no invented label — the grid provided none', () => {
  for (const code of ['15.04', '15.70', '15.80']) {
    const ev = mcEvents.findEvent(code);
    assert.equal(ev.labelFr, null, code + ' must not carry a fabricated label');
  }
});

test('15.100 carries the exact official emergency instructions text, verbatim', () => {
  const ev = mcEvents.findEvent('15.100');
  assert.equal(ev.labelFr, "Appel / Consigne d'urgence");
  assert.equal(ev.instructions,
    "Observer et signaler tout comportement suspect. Surveiller les accès, entrées et sorties. Garder un suivi visuel de la situation sans se mettre en danger.");
  assert.equal(ev.category, 'urgence');
});

test('composite relations (10.06/10.07/10.10 -> 10.05) are recorded as metadata only, never as an auto-create instruction', () => {
  for (const code of ['10.06', '10.07', '10.10']) {
    const ev = mcEvents.findEvent(code);
    assert.equal(ev.relatedCode, '10.05');
  }
  // Aucune propriété du référentiel ne doit exposer un comportement
  // "créer une deuxième entrée" — seule une référence textuelle existe.
  for (const ev of mcEvents.EVENTS) {
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'autoCreate'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ev, 'cascade'), false);
  }
});

test('every event belongs to a declared category', () => {
  const categoryIds = new Set(mcEvents.CATEGORIES.map(c => c.id));
  for (const ev of mcEvents.EVENTS) assert.ok(categoryIds.has(ev.category), ev.code + ' -> unknown category ' + ev.category);
});

test('findEvent() trims and looks up by exact code, returns null for anything else', () => {
  assert.equal(mcEvents.findEvent(' 10.17 ').code, '10.17');
  assert.equal(mcEvents.findEvent('10.170'), null);
  assert.equal(mcEvents.findEvent(''), null);
  assert.equal(mcEvents.findEvent(undefined), null);
});

test('validateEventSelection(): no code supplied -> legacy free-text flow accepted, nothing forced', () => {
  assert.deepEqual(mcEvents.validateEventSelection({}), { code: null, categorie: null });
  assert.deepEqual(mcEvents.validateEventSelection({ code: '' }), { code: null, categorie: null });
});

test('validateEventSelection(): unknown code is refused explicitly', () => {
  const r = mcEvents.validateEventSelection({ code: '00.00' });
  assert.ok(r.error);
});

test('validateEventSelection(): categorie omitted is derived from the code (never left to the client alone)', () => {
  const r = mcEvents.validateEventSelection({ code: '15.100' });
  assert.deepEqual(r, { code: '15.100', categorie: 'urgence' });
});

test('validateEventSelection(): a categorie that contradicts the code is refused, even if both individually exist', () => {
  const r = mcEvents.validateEventSelection({ code: '10.17', categorie: 'agents' });
  assert.ok(r.error);
});

test('validateEventSelection(): matching categorie is accepted and echoed back unchanged', () => {
  const r = mcEvents.validateEventSelection({ code: '10.17', categorie: 'incidents_securite' });
  assert.deepEqual(r, { code: '10.17', categorie: 'incidents_securite' });
});
