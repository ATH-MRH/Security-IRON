'use strict';
// PG-3.3C — validation end-to-end du backend PostgreSQL : un seul serveur réel,
// base jetable, migrations 001/002, utilisateurs provisionnés. On traverse chaque
// famille de routes historiques + Alert Core + les préoccupations transverses
// (auth, concurrence HTTP, interblocage, rollback, arrêt, absence de SQLite runtime).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_e2e_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const now = () => new Date().toISOString();

let root, started, base, admin, agent;

async function api(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, body: type.includes('application/json') ? await r.json() : await r.text() };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    for (const [u, p, r] of [['admin', 'securisite', 'admin'], ['agent', 'agent', 'agent']]) {
      const row = await pool.get('INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id',
        [u, await bcrypt.hash(p, 10), u, r]);
      await seedMembership(pool, row.id, r); // PG-8: business/alert routes require an active membership.
    }
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  base = 'http://127.0.0.1:' + started.port;
  admin = (await api('POST', '/auth/login', { username: 'admin', password: 'securisite' }, null)).body.token;
  agent = (await api('POST', '/auth/login', { username: 'agent', password: 'agent' }, null)).body.token;
});
after(async () => {
  try { if (started) await started.stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

test('startup + readiness: the migrated server listens and enforces JWT', async () => {
  assert.ok(admin && agent, 'both demo accounts logged in at startup');
  assert.equal((await api('GET', '/employes', undefined, null)).status, 401);
});

test('auth: login, /me, missing token, invalid token, revoked user', async () => {
  assert.equal((await api('POST', '/auth/login', { username: 'admin', password: 'wrong' }, null)).status, 401);
  assert.equal((await api('GET', '/auth/me')).body.user.username, 'admin');
  assert.equal((await api('GET', '/auth/me', undefined, null)).status, 401);
  assert.equal((await api('GET', '/auth/me', undefined, 'Bearer-nonsense')).status, 401);
  // A token for a user removed after issuance: /api/* still trusts the JWT, but
  // Alert Core re-reads identity and rejects.
  const tmp = (await api('POST', '/admin/users', { username: 'ghost', password: 'x', role: 'agent' })).body;
  const ghost = (await api('POST', '/auth/login', { username: 'ghost', password: 'x' }, null)).body.token;
  await api('DELETE', '/admin/users/' + tmp.id);
  assert.equal((await api('GET', '/alerts', undefined, ghost)).status, 401);
});

test('admin users CRUD keeps at least one administrator', async () => {
  const created = (await api('POST', '/admin/users', { username: 'u_' + randomBytes(3).toString('hex'), password: 'p', role: 'agent' })).body;
  assert.ok(created.id);
  assert.equal((await api('PUT', '/admin/users/' + created.id, { role: 'admin' })).body.role, 'admin');
  assert.equal((await api('DELETE', '/admin/users/' + created.id)).status, 200);
  assert.equal((await api('POST', '/admin/users', { username: 'x' }, agent)).status, 403);
  assert.ok((await api('GET', '/admin/users')).body.some(u => u.username === 'admin'));
});

test('admin/system exposes a neutral database label and no connection string', async () => {
  const sys = (await api('GET', '/admin/system')).body;
  assert.equal(sys.database, 'PostgreSQL');
  assert.ok(!('db_url' in sys) && !('db_path' in sys));
  assert.doesNotMatch(JSON.stringify(sys), /postgres:\/\/|DATABASE_URL|sqlite/i);
});

test('personnel routes: employes, visiteurs, vehicules round-trip', async () => {
  const e = (await api('POST', '/employes', { prenom: 'A', nom: 'B', service: 'S' })).body;
  assert.ok(e.id && e.matricule);
  assert.equal((await api('PUT', '/employes/' + e.id, { statut: 'suspendu' })).body.statut, 'suspendu');
  assert.ok((await api('GET', '/employes')).body.some(x => x.id === e.id));

  const v = (await api('POST', '/visiteurs', { prenom: 'V', nom: 'W' }, agent)).body;
  assert.equal(v.statut, 'attendu');
  assert.equal((await api('PUT', '/visiteurs/' + v.id + '/checkin', {}, agent)).body.statut, 'present');
  assert.equal((await api('PUT', '/visiteurs/' + v.id + '/checkout', {}, agent)).body.statut, 'parti');

  const veh = (await api('POST', '/vehicules', { plaque: 'ab-123-cd', type: 'VL' }, agent)).body;
  assert.equal(veh.plaque, 'AB-123-CD');
  assert.equal((await api('PUT', '/vehicules/' + veh.id + '/sortie', {}, agent)).body.statut, 'dehors');
});

test('access routes: pietons, badges, parking, main courante, lapi', async () => {
  assert.equal((await api('POST', '/pietons', { badge: 'B1', nom: 'x', point: 'P', sens: 'entree', resultat: 'autorise' }, agent)).status, 200);
  assert.ok((await api('GET', '/pietons')).body.length >= 1);

  const b = (await api('POST', '/badges', { ref: 'BDG-E2E', nom: 'x', type: 'E', niveau: 'N1' })).body;
  assert.equal(b.ref, 'BDG-E2E');
  assert.equal((await api('PUT', '/badges/BDG-E2E', { etat: 'perdu' })).body.etat, 'perdu');

  const parking = (await api('GET', '/parking')).body;
  assert.ok(Array.isArray(parking.zones) && Array.isArray(parking.mouvements));

  const mc = (await api('POST', '/maincourante', { type: 'Ronde', description: 'RAS', poste: 'PC' }, agent)).body;
  assert.ok(mc.id);
  assert.ok((await api('GET', '/maincourante')).body.some(x => x.id === mc.id));

  assert.equal((await api('POST', '/lapi', { plaqueDetectee: 'XY-000-ZZ', confiance: 90 }, agent)).status, 200);
  assert.ok((await api('GET', '/lapi')).body.length >= 1);
});

test('parametres: atomic batch update reflected by GET', async () => {
  assert.equal((await api('PUT', '/parametres', { site: 'E2E Site', tel: '+213' })).status, 200);
  const p = (await api('GET', '/parametres')).body;
  assert.equal(p.site, 'E2E Site'); assert.equal(p.tel, '+213');
  assert.equal((await api('PUT', '/parametres', { site: 'x' }, agent)).status, 403);
});

test('reports and dashboard stats are computed from PostgreSQL', async () => {
  const dash = (await api('GET', '/stats/dashboard')).body;
  for (const k of ['employes_actifs', 'visiteurs_total', 'incidents_ouverts']) assert.equal(typeof dash[k], 'number');
  const rap = (await api('GET', '/rapports?periode=30')).body;
  assert.ok(Array.isArray(rap.incidents) && typeof rap.employes_actifs === 'number');
});

test('Alert Core end-to-end: create, list, detail, rules, notifications, actions, escalation', async () => {
  const a = (await api('POST', '/alerts', { site: 'Oran', zone: 'Q', type: 'SOS', level: 4 }, agent)).body;
  assert.equal(a.status, 'NOTIFIEE');
  assert.ok((await api('GET', '/alerts')).body.some(x => x.id === a.id));       // admin sees it
  assert.equal((await api('GET', '/alerts/' + a.id)).body.timeline[0].action, 'CREATION');

  assert.equal((await api('PUT', '/alerts/rules', { escalation: [40, 80, 160], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 })).status, 200);
  assert.equal((await api('PUT', '/alerts/rules', { escalation: [1, 2, 3], incidentCritical: 'x', badgeThreshold: 1, badgeWindowSeconds: 1 })).status, 400);
  await api('PUT', '/alerts/rules', { escalation: [30, 60, 120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 });

  const notice = (await api('GET', '/alerts/notifications')).body.find(n => n.alert_id === a.id);
  assert.ok(notice);
  await api('POST', '/alerts/notifications/' + notice.id + '/read', {});

  // Escalation: overdue steps recovered without duplication, stopped by acknowledgement.
  const t0 = Date.parse(a.created_at);
  for (const off of [31000, 61000, 121000]) await require('../backend/alerts').escalateDue(t0 + off);
  assert.equal((await api('GET', '/alerts/' + a.id)).body.escalation_step, 3);
  assert.equal((await api('POST', '/alerts/' + a.id + '/actions', { action: 'ACQUITTEE' })).status, 200);
});

test('HTTP concurrency: two simultaneous acknowledgements serialise to [200, 409]', async () => {
  const a = (await api('POST', '/alerts', { site: 'Oran', zone: 'Q', type: 'SOS', level: 4 }, agent)).body;
  const race = await Promise.all([
    api('POST', '/alerts/' + a.id + '/actions', { action: 'ACQUITTEE' }),
    api('POST', '/alerts/' + a.id + '/actions', { action: 'ACQUITTEE' }),
  ]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
});

test('deadlock: a real PostgreSQL 40P01 is surfaced with its SQLSTATE (mapped to 503 by the transport)', async () => {
  const { classifyError } = require('../backend/http-errors');
  const pool = db.createDatabase(env);
  const other = db.createDatabase(env);
  try {
    await pool.query("INSERT INTO public.parametres (cle,valeur) VALUES ('dlk_a','1') ON CONFLICT (cle) DO UPDATE SET valeur='1'");
    await pool.query("INSERT INTO public.parametres (cle,valeur) VALUES ('dlk_b','1') ON CONFLICT (cle) DO UPDATE SET valeur='1'");
    let relA, relB; const gateA = new Promise(r => { relA = r; }); const gateB = new Promise(r => { relB = r; });
    const txA = pool.transaction(async c => {
      await c.query("UPDATE public.parametres SET valeur='A' WHERE cle='dlk_a'");
      relA(); await gateB;
      await c.query("UPDATE public.parametres SET valeur='A' WHERE cle='dlk_b'");
    });
    const txB = other.transaction(async c => {
      await c.query("UPDATE public.parametres SET valeur='B' WHERE cle='dlk_b'");
      relB(); await gateA;
      await c.query("UPDATE public.parametres SET valeur='B' WHERE cle='dlk_a'");
    });
    const outcomes = await Promise.allSettled([txA, txB]);
    const failed = outcomes.find(o => o.status === 'rejected');
    assert.ok(failed, 'one transaction must be chosen as the deadlock victim');
    assert.equal(failed.reason && failed.reason.code, '40P01');
    assert.deepEqual(classifyError(failed.reason), { kind: 'transient', status: 503, body: { error: 'Opération temporairement indisponible' } });
  } finally { await pool.close(); await other.close(); }
});

test('rollback: a failed incident leaves the database exactly as before', async () => {
  const before = {
    incidents: (await api('GET', '/incidents')).body.length,
    alerts: (await api('GET', '/alerts')).body.length,
  };
  // gravite null -> INSERT succeeds (nullable), fromIncident config check is false -> no alert.
  // The point: a malformed follow-up must not leave a half-written incident.
  const pool = db.createDatabase(env);
  try {
    await assert.rejects(pool.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('securisite:incidents:ref')::bigint)");
      await client.query(
        "INSERT INTO incidents (id, ref, datetime, type, gravite, statut) VALUES ($1,$2,now()::text,'x','critique','ouvert')",
        ['INC-' + randomBytes(4).toString('hex'), 'INC-RB-' + randomBytes(3).toString('hex')]);
      throw Object.assign(new Error('downstream failed'), { code: 'FAULT' });
    }), /downstream failed/);
  } finally { await pool.close(); }
  assert.equal((await api('GET', '/incidents')).body.length, before.incidents);
  assert.equal((await api('GET', '/alerts')).body.length, before.alerts);
});

test('no SQLite dependency remains in the running server require graph', () => {
  const loaded = Object.keys(require.cache).filter(p =>
    (p.includes('/backend/') || p.endsWith('/server.js')) && !p.includes('/node_modules/'));
  assert.ok(loaded.length >= 5, 'server graph is loaded');
  const offenders = [];
  for (const file of loaded) {
    const src = fs.readFileSync(file, 'utf8');
    if (/require\(['"]node:sqlite['"]\)|\bDatabaseSync\b|\bdb\.raw\b|\bdb\.dbPath\b|sqlite-local/.test(src)) {
      offenders.push(path.relative(path.resolve(__dirname, '..'), file));
    }
  }
  assert.deepEqual(offenders, [], 'runtime files still referencing SQLite: ' + offenders.join(', '));
});

test('graceful shutdown: stop() closes the listener and the pool, idempotently', async () => {
  // Re-uses the shared server: this test runs last in file order.
  const url = base + '/api/employes';
  assert.equal((await fetch(url)).status, 401);
  await started.stop();
  await assert.rejects(fetch(url));
  await started.stop();
  await assert.rejects(db.query('SELECT 1'), /Pool PostgreSQL fermé/);
});
