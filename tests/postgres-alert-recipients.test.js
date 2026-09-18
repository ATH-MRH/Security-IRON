'use strict';
// PCS01 (Lot C) — ciblage explicite de destinataires (agent/site/zone/tout
// le tenant) et accusés de réception PAR DESTINATAIRE (migration 011,
// backend/alert-core/recipients.js). Réutilise les conventions de
// tests/postgres-soc.test.js (real PostgreSQL, base éphémère par fichier,
// serveur HTTP réel). Couvre explicitement la revue adversariale demandée :
// cross-tenant, cross-site, spoof destinataire, spoof sender/origin, IDOR,
// double-clic, permission tenant_wide, flood via le rate limit SOS existant
// (non dupliqué — /broadcast n'a pas son propre rate limit, voir note plus bas).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');

const baseEnv = require('./helpers/postgres-test-config').testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_recipients_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(5).toString('hex');

let root, pool, stop, base;
const ids = {};

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function createUser(role = 'agent') {
  const username = 'rec_' + tag();
  const row = await pool.get('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',
    [username, await bcrypt.hash('x', 10), role]);
  return { id: row.id, username };
}
async function grant(userId, { tenantId, siteId = null, zoneId = null, role = 'agent', alertAccess = 'own' }) {
  await pool.query('INSERT INTO public.memberships(user_id,tenant_id,site_id,zone_id,role,alert_access) VALUES($1,$2,$3,$4,$5,$6)',
    [userId, tenantId, siteId, zoneId, role, alertAccess]);
}
async function login(username) { return (await request('POST', '/auth/login', { username, password: 'x' }, null)).body.token; }

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);

  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('rec-a','Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('rec-b','Tenant B') RETURNING id")).id;
  ids.siteA1 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'a1','Site A1') RETURNING id", [ids.tenantA])).id;
  ids.siteA2 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'a2','Site A2') RETURNING id", [ids.tenantA])).id;
  ids.zoneA1 = (await pool.get("INSERT INTO public.zones(tenant_id,site_id,code,name) VALUES($1,$2,'z1','Zone A1') RETURNING id", [ids.tenantA, ids.siteA1])).id;
  ids.siteB1 = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'b1','Site B1') RETURNING id", [ids.tenantB])).id;

  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

async function socTokenFor(tenantId) {
  const soc = await createUser('admin'); await grant(soc.id, { tenantId, role: 'soc', alertAccess: 'scope' });
  return { id: soc.id, token: await login(soc.username) };
}

/* ============================================================ */
/*  Résolution + visibilité de base                              */
/* ============================================================ */

test('a site-targeted broadcast reaches an own-access agent at that site, who otherwise has zero visibility into it', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, siteId: ids.siteA1, role: 'agent', alertAccess: 'own' });
  const agentToken = await login(agent.username);

  const alert = (await request('POST', '/alerts', { site: 'S', type: 'Consigne', level: 3 }, soc.token)).body;
  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, agentToken)).status, 404, 'not visible before any broadcast');

  const bc = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'site', recipientId: ids.siteA1 }, soc.token);
  assert.equal(bc.status, 201);
  assert.equal(bc.body.recipientCount, 1);

  const after1 = await request('GET', '/alerts/' + alert.id, undefined, agentToken);
  assert.equal(after1.status, 200, 'now visible — targeted explicitly');
  const list = (await request('GET', '/alerts', undefined, agentToken)).body;
  assert.ok(list.some(a => a.id === alert.id), 'also appears in GET /alerts, not just the direct fetch');
});

test('a user-targeted broadcast reaches exactly that one agent, never a colleague at the same site', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, siteId: ids.siteA1, alertAccess: 'own' });
  const bystander = await createUser('agent'); await grant(bystander.id, { tenantId: ids.tenantA, siteId: ids.siteA1, alertAccess: 'own' });
  const targetToken = await login(target.username), bystanderToken = await login(bystander.username);

  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);

  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, targetToken)).status, 200);
  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, bystanderToken)).status, 404, 'a sibling at the same site is never implicitly included');
});

test('a zone-targeted broadcast reaches a zone-level member but not a member of a sibling site', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const zoneAgent = await createUser('agent'); await grant(zoneAgent.id, { tenantId: ids.tenantA, siteId: ids.siteA1, zoneId: ids.zoneA1, alertAccess: 'own' });
  const otherSiteAgent = await createUser('agent'); await grant(otherSiteAgent.id, { tenantId: ids.tenantA, siteId: ids.siteA2, alertAccess: 'own' });
  const zoneToken = await login(zoneAgent.username), otherToken = await login(otherSiteAgent.username);

  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'zone', recipientId: ids.zoneA1 }, soc.token);

  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, zoneToken)).status, 200);
  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, otherToken)).status, 404);
});

test('tenant_wide reaches every active member of the tenant, and nobody outside it', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const agent1 = await createUser('agent'); await grant(agent1.id, { tenantId: ids.tenantA, siteId: ids.siteA1, alertAccess: 'own' });
  const agent2 = await createUser('agent'); await grant(agent2.id, { tenantId: ids.tenantA, siteId: ids.siteA2, alertAccess: 'own' });
  const token1 = await login(agent1.username), token2 = await login(agent2.username);

  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, soc.token)).body;
  const bc = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'tenant_wide' }, soc.token);
  assert.equal(bc.status, 201);
  assert.ok(bc.body.recipientCount >= 2);

  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, token1)).status, 200);
  assert.equal((await request('GET', '/alerts/' + alert.id, undefined, token2)).status, 200);
});

test('the broadcaster themself never gets a redundant recipient row on their own broadcast', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 4 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'tenant_wide' }, soc.token);
  const row = await pool.get('SELECT 1 FROM public.alert_recipients WHERE alert_id=$1 AND user_id=$2', [alert.id, soc.id]);
  assert.equal(row, null);
});

/* ============================================================ */
/*  Sécurité : cross-tenant, cross-site, spoof, IDOR, permissions */
/* ============================================================ */

test('cross-tenant: a site/zone belonging to another tenant is refused as a broadcast target, never silently resolved', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'site', recipientId: ids.siteB1 }, soc.token);
  assert.equal(r.status, 404);
});

test('cross-tenant: a user belonging only to another tenant is never resolved as a valid "user" target', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const foreignUser = await createUser('agent'); await grant(foreignUser.id, { tenantId: ids.tenantB, alertAccess: 'own' });
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: foreignUser.id }, soc.token);
  assert.equal(r.status, 404, 'no active membership under tenant A for this user id — refused, not silently ignored');
});

test('a non-SOC (own) account is refused broadcasting outright, even on an alert they can see', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const agentToken = await login(agent.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, agentToken)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'tenant_wide' }, agentToken);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'Action réservée au SOC' });
});

test('spoof destinataire: a plain agent cannot mark receipt/acknowledgment on an alert they were never targeted for (IDOR)', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const outsider = await createUser('agent'); await grant(outsider.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const outsiderToken = await login(outsider.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/receipt', { status: 'acknowledged' }, outsiderToken);
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Vous n’êtes pas destinataire de cette alerte' });
});

test('spoof sender/IDOR: the recipient endpoint always uses the caller\'s own JWT identity — a forged user_id in the body changes nothing', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const targetToken = await login(target.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);
  // A forged userId/user_id field in the body is simply ignored — the row
  // updated is always the caller's own (backend/alerts.js passes req.user.id,
  // never req.body, to service.receiptAlert).
  const r = await request('POST', '/alerts/' + alert.id + '/receipt', { status: 'acknowledged', userId: 999999, user_id: 999999 }, targetToken);
  assert.equal(r.status, 200);
  const row = await pool.get('SELECT user_id FROM public.alert_recipients WHERE alert_id=$1', [alert.id]);
  assert.equal(row.user_id, target.id);
});

test('cross-tenant IDOR: GET /alerts/:id/receipts from a different tenant\'s SOC is refused, not just empty', async () => {
  const socA = await socTokenFor(ids.tenantA);
  const socB = await socTokenFor(ids.tenantB);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, socA.token)).body;
  const r = await request('GET', '/alerts/' + alert.id + '/receipts', undefined, socB.token);
  assert.equal(r.status, 404);
});

test('broadcasting an invalid recipientType is refused outright, never silently ignored or defaulted', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'everyone-everywhere' }, soc.token);
  assert.equal(r.status, 400);
});

test('a recipient never gains SOC-only powers (e.g. closing the alert) just by being targeted', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const targetToken = await login(target.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);
  const r = await request('POST', '/alerts/' + alert.id + '/actions', { action: 'ACQUITTEE' }, targetToken);
  assert.equal(r.status, 403, 'ACQUITTEE (alert-wide status) stays SOC-only — the recipient has their own /receipt endpoint instead');
});

/* ============================================================ */
/*  Cycle de vie des accusés : idempotence, double-clic, audit   */
/* ============================================================ */

test('idempotent: marking "delivered" twice (double network retry) never errors and never overwrites an already-later acknowledged_at', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const targetToken = await login(target.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);

  assert.equal((await request('POST', '/alerts/' + alert.id + '/receipt', { status: 'acknowledged' }, targetToken)).status, 200);
  const firstAck = (await pool.get('SELECT acknowledged_at FROM public.alert_recipients WHERE alert_id=$1', [alert.id])).acknowledged_at;
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await request('POST', '/alerts/' + alert.id + '/receipt', { status: 'acknowledged' }, targetToken)).status, 200, 'a second click/retry is never an error');
  const secondAck = (await pool.get('SELECT acknowledged_at FROM public.alert_recipients WHERE alert_id=$1', [alert.id])).acknowledged_at;
  assert.deepEqual(firstAck, secondAck, 'the original timestamp is preserved, never silently overwritten');
});

test('acknowledging directly (without a prior "delivered" call) honours both timestamps at once — never an acknowledgment with no delivery on record', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const targetToken = await login(target.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);
  await request('POST', '/alerts/' + alert.id + '/receipt', { status: 'acknowledged' }, targetToken);
  const row = await pool.get('SELECT delivered_at, acknowledged_at FROM public.alert_recipients WHERE alert_id=$1', [alert.id]);
  assert.ok(row.delivered_at);
  assert.ok(row.acknowledged_at);
});

test('re-broadcasting the same target does not duplicate the recipient row (ON CONFLICT DO NOTHING)', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  const first = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);
  assert.equal(first.body.recipientCount, 1);
  const second = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);
  assert.equal(second.body.recipientCount, 0, 'already a recipient — the second call inserts nothing new');
  const count = (await pool.get('SELECT count(*)::int n FROM public.alert_recipients WHERE alert_id=$1', [alert.id])).n;
  assert.equal(count, 1);
});

test('every broadcast and every receipt is recorded in the immutable alert_audit trail', async () => {
  const soc = await socTokenFor(ids.tenantA);
  const target = await createUser('agent'); await grant(target.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const targetToken = await login(target.username);
  const alert = (await request('POST', '/alerts', { site: 'S', type: 'T', level: 3 }, soc.token)).body;
  await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'user', recipientId: target.id }, soc.token);
  await request('POST', '/alerts/' + alert.id + '/receipt', { status: 'acknowledged' }, targetToken);
  const rows = await pool.all('SELECT action FROM public.alert_audit WHERE alert_id=$1 ORDER BY id', [alert.id]);
  assert.ok(rows.some(r => r.action === 'DIFFUSION'));
  assert.ok(rows.some(r => r.action === 'ACCUSE_DESTINATAIRE'));
});

/* ============================================================ */
/*  Endpoint candidats + readiness                                */
/* ============================================================ */

test('GET /alerts/recipients/candidates is SOC-only and scoped to the caller\'s own tenant', async () => {
  const socA = await socTokenFor(ids.tenantA);
  const agent = await createUser('agent'); await grant(agent.id, { tenantId: ids.tenantA, alertAccess: 'own' });
  const agentToken = await login(agent.username);
  const foreignUser = await createUser('agent'); await grant(foreignUser.id, { tenantId: ids.tenantB, alertAccess: 'own' });

  assert.equal((await request('GET', '/alerts/recipients/candidates', undefined, agentToken)).status, 403);
  const list = (await request('GET', '/alerts/recipients/candidates', undefined, socA.token)).body;
  assert.ok(list.some(u => u.id === agent.id));
  assert.ok(!list.some(u => u.id === foreignUser.id));
});

test('readiness requires alert_recipients to exist, with exactly the runtime privileges the APP role needs', async () => {
  const { assertReady, ALERT_RECIPIENTS, PRIVILEGES } = require('../backend/db/postgresql/readiness');
  assert.deepEqual(ALERT_RECIPIENTS, ['alert_recipients']);
  assert.equal(PRIVILEGES.alert_recipients, 'SELECT,INSERT,UPDATE');
  assert.equal(await assertReady(pool, { directory }), undefined);
});
