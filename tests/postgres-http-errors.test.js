'use strict';
// PG-3.3C — classification transport partagée (backend/http-errors.js). Aucune base :
// on vérifie le contrat que server.js et backend/alerts.js appliquent tel quel.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { classifyError, sendError } = require('../backend/http-errors');

test('classifyError keeps business errors (400-499) with their status and message', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const c = classifyError(Object.assign(new Error('Message métier'), { status }));
    assert.deepEqual(c, { kind: 'business', status, body: { error: 'Message métier' } });
  }
});

test('classifyError maps recognised transient PostgreSQL conflicts to a generic 503', () => {
  for (const code of ['40P01', '40001', '55P03', 'ALERT_LOCK_TIMEOUT']) {
    const c = classifyError(Object.assign(new Error('deadlock on relation security_alerts; password=x'), { code }));
    assert.equal(c.kind, 'transient');
    assert.equal(c.status, 503);
    assert.deepEqual(c.body, { error: 'Opération temporairement indisponible' });
  }
});

test('classifyError maps Alert Core unavailability to a generic 503', () => {
  for (const code of ['ALERT_SCHEMA_UNAVAILABLE', 'ALERT_CONFIG_MISSING']) {
    const c = classifyError(Object.assign(new Error('règle id=1 absente'), { code }));
    assert.deepEqual(c, { kind: 'unavailable', status: 503, body: { error: 'Service momentanément indisponible' } });
  }
});

test('classifyError maps every other technical error to a generic 500 with no leak', () => {
  for (const err of [
    Object.assign(new Error('relation "public.users" does not exist'), { code: '42P01', detail: 'x', where: 'y' }),
    Object.assign(new Error('duplicate key value violates unique constraint "incidents_ref_key"'), { code: '23505' }),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    new SyntaxError('Unexpected token o in JSON at position 1'),
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432 password=hunter2'), { code: 'ECONNREFUSED' }),
    'a bare string',
    null,
  ]) {
    const c = classifyError(err);
    assert.deepEqual(c, { kind: 'technical', status: 500, body: { error: 'Erreur serveur' } });
  }
});

// Same wiring as server.js: app.use((err, req, res, next) => httpErrors.sendError(res, err, 'HTTP'))
let server, origin;
before(async () => {
  const app = express();
  app.get('/boom/business', () => { throw Object.assign(new Error('Utilisateur introuvable'), { status: 404 }); });
  app.get('/boom/deadlock', () => { throw Object.assign(new Error('deadlock detected\nDETAIL: process 1 waits for ShareLock; host=db-prod password=s3cret'), { code: '40P01', detail: 'process 1', where: 'SQL statement "UPDATE ..."' }); });
  app.get('/boom/unknown', () => { throw Object.assign(new Error('relation "public.incidents" does not exist; DATABASE_URL=postgres://u:p@h/db'), { code: '42P01', detail: 'secret', where: 'PL/pgSQL', schema: 'public', table: 'incidents', constraint: 'incidents_pkey' }); });
  // Mirrors backend/routes.js: handlers forward errors through next(err).
  app.get('/boom/next-serial', (req, res, next) => { next(Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' })); });
  app.get('/boom/next-timeout', (req, res, next) => { next(Object.assign(new Error('canceling statement due to statement timeout on SELECT * FROM users'), { code: '57014' })); });
  app.use((err, req, res, next) => sendError(res, err, 'HTTP')); // signature à 4 arguments
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { if (server) await new Promise(r => server.close(r)); });

async function call(path) {
  const r = await fetch(origin + path);
  return { status: r.status, body: await r.json() };
}

test('global handler: a business error keeps its status and message', async () => {
  assert.deepEqual(await call('/boom/business'), { status: 404, body: { error: 'Utilisateur introuvable' } });
});

test('global handler: a recognised deadlock becomes 503 with no SQL/host/credential leak', async () => {
  const r = await call('/boom/deadlock');
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'Opération temporairement indisponible' });
  assert.doesNotMatch(JSON.stringify(r.body), /deadlock|ShareLock|db-prod|s3cret|process 1|UPDATE/i);
});

test('global handler: an unknown technical error becomes a generic 500 with no leak', async () => {
  const r = await call('/boom/unknown');
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'Erreur serveur' });
  assert.doesNotMatch(JSON.stringify(r.body), /relation|does not exist|DATABASE_URL|postgres:|constraint|incidents/i);
});

test('global handler: a recognised serialization failure via next() becomes 503 with no leak', async () => {
  const r = await call('/boom/next-serial');
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'Opération temporairement indisponible' });
  assert.doesNotMatch(JSON.stringify(r.body), /serialize|concurrent/i);
});

test('global handler: an unrecognised SQLSTATE (statement timeout) stays a generic 500', async () => {
  const r = await call('/boom/next-timeout');
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'Erreur serveur' });
  assert.doesNotMatch(JSON.stringify(r.body), /timeout|SELECT|users/i);
});
