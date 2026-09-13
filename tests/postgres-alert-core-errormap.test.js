'use strict';
// PG-3.3A (correctif) — mapping transport des erreurs Alert Core.
// N'ouvre aucune base : le routeur est monté seul et le service est instrumenté.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const service = require('../backend/alert-core/service');
const scope = require('../backend/scope');
const alerts = require('../backend/alerts');

let server, origin;
const realCurrentUser = service.currentUser;
const realConfig = service.config;
const realResolveScope = scope.resolveScope;

before(async () => {
  service.currentUser = async () => ({ id: 1, username: 'admin', role: 'admin' });
  // PG-8/PG-16: alerts.js resolves a périmètre via backend/scope.js
  // (memberships, now through scope.requireScope()), a real DB call this
  // deliberately DB-less fixture cannot make. Stub it the same way
  // service.currentUser/service.config are stubbed: full SOC scope, matching
  // this test's pre-PG-8 role:'admin'. requireScope() dispatches through
  // module.exports.resolveScope precisely so this interception keeps working
  // even though its middleware closure was already built at router-load time.
  scope.resolveScope = async () => ({
    hasAccess: true, tenantIds: ['fixture-tenant'],
    resolveTenant: () => 'fixture-tenant', tenantAccess: () => 'scope',
    hasRole: () => true, allows: () => true, coverage: () => 'scope',
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/alerts', alerts.router);
  // Marqueur : si le routeur laissait passer next(err), __global apparaîtrait dans le corps.
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.message || 'Erreur serveur', __global: true }); }); // eslint-disable-line
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  service.currentUser = realCurrentUser;
  service.config = realConfig;
  scope.resolveScope = realResolveScope;
  if (server) await new Promise(r => server.close(r));
});

const raise = value => { service.config = async () => { throw value; }; };
async function get() {
  const r = await fetch(origin + '/api/alerts/rules');
  return { status: r.status, body: await r.json() };
}

for (const code of ['40P01', '40001', '55P03']) {
  test(`PostgreSQL ${code} maps to 503 "Opération temporairement indisponible"`, async () => {
    raise(Object.assign(new Error(`pg error ${code} on relation security_alerts; password=hunter2`), { code, detail: 'd', where: 'w' }));
    const r = await get();
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'Opération temporairement indisponible' });
  });
}

test('ALERT_LOCK_TIMEOUT maps to the same 503 body as a deadlock', async () => {
  raise(Object.assign(new Error('Opération temporairement indisponible', { cause: new Error('55P03') }), { code: 'ALERT_LOCK_TIMEOUT' }));
  const r = await get();
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'Opération temporairement indisponible' });
});

for (const code of ['ALERT_SCHEMA_UNAVAILABLE', 'ALERT_CONFIG_MISSING']) {
  test(`${code} maps to 503 "Service momentanément indisponible" without leaking its detail`, async () => {
    raise(Object.assign(new Error('Configuration Alert Core indisponible : règle id=1 absente'), { code }));
    const r = await get();
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: 'Service momentanément indisponible' });
    assert.doesNotMatch(JSON.stringify(r.body), /id=1|ALERT_|absente/);
  });
}

for (const status of [400, 401, 403, 404, 409]) {
  test(`a business error keeps status ${status} and its message verbatim`, async () => {
    raise(Object.assign(new Error('Message métier ' + status), { status }));
    const r = await get();
    assert.equal(r.status, status);
    assert.deepEqual(r.body, { error: 'Message métier ' + status });
  });
}

test('an unknown technical error is a generic 500 with no SQL / detail / credential leak', async () => {
  raise(Object.assign(new Error('relation "public.alert_rules" does not exist; host=10.0.0.9 password=s3cr3t'), { code: '42P01', detail: 'secret detail', where: 'PL/pgSQL function alert_rules_check()' }));
  const r = await get();
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'Erreur serveur' });
  assert.doesNotMatch(JSON.stringify(r.body), /hunter2|s3cr3t|10\.0\.0\.9|does not exist|relation |password|PL\/pgSQL|42P01|__global/);
});

test('a JSON SyntaxError from configuration parsing is a generic 500', async () => {
  raise(new SyntaxError('Unexpected token o in JSON at position 1'));
  const r = await get();
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'Erreur serveur' });
  assert.doesNotMatch(JSON.stringify(r.body), /JSON|position|token/);
});

test('no mapped error ever reaches the application-level handler', async () => {
  for (const value of [
    Object.assign(new Error('x'), { code: '40P01' }),
    Object.assign(new Error('x'), { code: 'ALERT_CONFIG_MISSING' }),
    Object.assign(new Error('x'), { status: 404 }),
    new SyntaxError('x'),
  ]) {
    raise(value);
    const r = await get();
    assert.ok(!('__global' in r.body), 'router forwarded to the global handler for ' + (value.code || value.status || value.name));
  }
});
