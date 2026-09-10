'use strict';
// PG-5 — pipeline d'import SQLite -> PostgreSQL : validation, dry-run, import
// transactionnel, setval des séquences, vérification. Bases jetables locales.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { importSqlite, assertTargetAllowed } = require('../backend/db/postgresql/import-sqlite');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const tag = () => randomBytes(5).toString('hex');

let root, tmpDir;
before(async () => {
  root = new Client(db.configuration(baseEnv)); await root.connect();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-import-'));
});
after(async () => {
  if (root) await root.end();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Historical SQLite schema + rows. `edge` injects one problematic row per kind.
function buildSqlite(edge = null) {
  const file = path.join(tmpDir, 'src-' + tag() + '.db');
  const s = new DatabaseSync(file);
  s.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, nom_complet TEXT, role TEXT, created_at TEXT);
    CREATE TABLE employes (id TEXT PRIMARY KEY, matricule TEXT UNIQUE, prenom TEXT, nom TEXT, service TEXT, fonction TEXT, badge TEXT, niveau TEXT, statut TEXT, creation TEXT, atlas_id INTEGER, site_id INTEGER, site_nom TEXT, groupe TEXT, date_affectation TEXT, created_by TEXT);
    CREATE TABLE visiteurs (id TEXT PRIMARY KEY, prenom TEXT, nom TEXT, societe TEXT, hote TEXT, motif TEXT, arrivee TEXT, badge TEXT, statut TEXT, created_by TEXT);
    CREATE TABLE vehicules (id TEXT PRIMARY KEY, plaque TEXT, type TEXT, conducteur TEXT, societe TEXT, motif TEXT, entree TEXT, sortie TEXT, statut TEXT, place_parking TEXT, lapi_photo TEXT, created_by TEXT);
    CREATE TABLE pietons (id TEXT PRIMARY KEY, datetime TEXT, nom TEXT, badge TEXT, type TEXT, point TEXT, sens TEXT, resultat TEXT, notes TEXT, created_by TEXT);
    CREATE TABLE incidents (id TEXT PRIMARY KEY, ref TEXT UNIQUE, datetime TEXT, type TEXT, lieu TEXT, gravite TEXT, statut TEXT, agent TEXT, description TEXT, actions TEXT, created_by TEXT);
    CREATE TABLE badges (ref TEXT PRIMARY KEY, nom TEXT, type TEXT, niveau TEXT, emis TEXT, validite TEXT, etat TEXT, societe TEXT, created_by TEXT);
    CREATE TABLE parking_zones (zone TEXT PRIMARY KEY, nom TEXT, total INTEGER, reserve INTEGER, handicap INTEGER);
    CREATE TABLE parking_places (num TEXT PRIMARY KEY, zone TEXT, etat TEXT, plaque TEXT);
    CREATE TABLE parking_mouvements (id TEXT PRIMARY KEY, datetime TEXT, plaque TEXT, place TEXT, zone TEXT, action TEXT, duree INTEGER, created_by TEXT);
    CREATE TABLE main_courante (id TEXT PRIMARY KEY, datetime TEXT, poste TEXT, agent TEXT, type TEXT, lieu TEXT, description TEXT, priorite TEXT, created_by TEXT);
    CREATE TABLE lapi_lectures (id TEXT PRIMARY KEY, datetime TEXT, plaque_detectee TEXT, plaque_raw TEXT, confiance INTEGER, image TEXT, statut TEXT, action TEXT, created_by TEXT);
    CREATE TABLE parametres (cle TEXT PRIMARY KEY, valeur TEXT);
    CREATE TABLE security_alerts (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, site TEXT, zone TEXT, type TEXT, level INTEGER, origin TEXT, created_by INTEGER, username TEXT, status TEXT, owner TEXT, acknowledged_at TEXT, resolved_at TEXT, comment TEXT, latitude REAL, longitude REAL, equipment TEXT, cancellation_requested INTEGER, escalation_step INTEGER, policy TEXT);
    CREATE TABLE alert_audit (id INTEGER PRIMARY KEY, alert_id TEXT, created_at TEXT, actor TEXT, action TEXT, detail TEXT);
    CREATE TABLE alert_notifications (id INTEGER PRIMARY KEY, alert_id TEXT, user_id INTEGER, created_at TEXT, message TEXT, read_at TEXT);
    CREATE TABLE alert_config_audit (id INTEGER PRIMARY KEY, created_at TEXT, actor TEXT, previous TEXT, current TEXT);
    CREATE TABLE alert_rules (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT);
  `);
  s.prepare('INSERT INTO users (id,username,password_hash,nom_complet,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(1, 'admin', 'h1', 'Administrateur', 'admin', '2026-01-01T00:00:00.000Z');
  s.prepare('INSERT INTO users (id,username,password_hash,nom_complet,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(7, 'agent', 'h2', 'Agent', 'agent', '2026-01-02T00:00:00.000Z');   // gap in ids on purpose
  s.prepare('INSERT INTO employes (id,matricule,prenom,nom,atlas_id,site_id,creation) VALUES (?,?,?,?,?,?,?)')
    .run('EMP-1', 'M1000', 'Marie', 'Dubois', 42, null, '2026-01-01');
  s.prepare('INSERT INTO parking_zones (zone,nom,total,reserve,handicap) VALUES (?,?,?,?,?)').run('A', 'Visiteurs', 20, 3, 2);
  s.prepare('INSERT INTO parking_places (num,zone,etat,plaque) VALUES (?,?,?,?)').run('A1', 'A', 'libre', null);
  s.prepare('INSERT INTO parametres (cle,valeur) VALUES (?,?)').run('site', 'Accentué é à û — Site');
  s.prepare('INSERT INTO incidents (id,ref,datetime,type,gravite,statut) VALUES (?,?,?,?,?,?)')
    .run('INC-1', 'INC-2026000', '2026-01-05T09:00:00.000Z', 'Alarme', 'mineur', 'ouvert');
  s.prepare('INSERT INTO security_alerts (id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,equipment,cancellation_requested,escalation_step,policy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('ALT-1', '2026-01-06T10:00:00.000Z', '2026-01-06T10:00:00.000Z', 'Oran', 'Q', 'SOS', 4, 'COMMAND', 7, 'agent', 'NOTIFIEE', '', '', 0, 0, '[30,60,120]');
  s.prepare('INSERT INTO alert_audit (id,alert_id,created_at,actor,action,detail) VALUES (?,?,?,?,?,?)')
    .run(1, 'ALT-1', '2026-01-06T10:00:00.000Z', 'agent', 'CREATION', 'SOS — niveau 4');
  s.prepare('INSERT INTO alert_audit (id,alert_id,created_at,actor,action,detail) VALUES (?,?,?,?,?,?)')
    .run(5, 'ALT-1', '2026-01-06T10:00:01.000Z', 'system', 'NOTIFICATION_INTERNE', '1 destinataire(s)');
  s.prepare('INSERT INTO alert_rules (id,config) VALUES (1,?)').run('{"escalation":[30,60,120],"incidentCritical":true,"badgeThreshold":3,"badgeWindowSeconds":120}');

  if (edge === 'null_pk') s.prepare('INSERT INTO parametres (cle,valeur) VALUES (?,?)').run(null, 'x');
  if (edge === 'int32_overflow') s.prepare('INSERT INTO employes (id,atlas_id) VALUES (?,?)').run('EMP-BIG', 3000000000);
  if (edge === 'invalid_json') s.prepare('INSERT INTO security_alerts (id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,policy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('ALT-BAD', 'x', 'x', 's', 'z', 't', 1, 'o', 1, 'u', 'NOTIFIEE', '{not json');

  s.close();
  return file;
}

async function freshTarget(t) {
  const n = 'securisite_test_import_' + tag();
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(() => root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'));
  const env = { ...baseEnv, DATABASE_URL: (u => (u.pathname = '/' + n, u.href))(new URL(baseEnv.DATABASE_URL)) };
  await migrate({ directory: migrationsDir, migrationEnv: env });
  return env;
}
const q = (env, sql, params) => (async () => {
  const c = new Client({ connectionString: env.DATABASE_URL }); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
})();

test('assertTargetAllowed: production refused, test allowed, explicit confirmation allowed', () => {
  assert.throws(() => assertTargetAllowed('securisite_prod', {}), /interdit/);
  assert.throws(() => assertTargetAllowed('securisite', {}), /SECURISITE_IMPORT_CONFIRM/);
  assert.doesNotThrow(() => assertTargetAllowed('securisite_test_x', {}));
  assert.doesNotThrow(() => assertTargetAllowed('securisite', { SECURISITE_IMPORT_CONFIRM: 'securisite' }));
});

test('dry-run validates and reports without writing to the target', async t => {
  const env = await freshTarget(t);
  const src = buildSqlite();
  const report = await importSqlite({ sqlitePath: src, targetEnv: env, dryRun: true });
  assert.equal(report.verification, 'dry-run');
  assert.equal(report.tables.find(x => x.name === 'users').source, 2);
  assert.equal(report.tables.find(x => x.name === 'alert_audit').source, 2);
  assert.deepEqual(report.tables.flatMap(x => x.issues), []);
  assert.equal((await q(env, 'SELECT count(*)::int n FROM public.users'))[0].n, 0, 'nothing was written');
});

test('real import copies every row, matches counts and keys, and advances identity sequences', async t => {
  const env = await freshTarget(t);
  const src = buildSqlite();
  const report = await importSqlite({ sqlitePath: src, targetEnv: env });
  assert.equal(report.verification, 'ok');
  assert.equal(report.tables.find(x => x.name === 'users').imported, 2);
  assert.equal(report.sequences.users, 7);
  assert.equal(report.sequences.alert_audit, 5);

  assert.equal((await q(env, 'SELECT count(*)::int n FROM public.security_alerts'))[0].n, 1);
  assert.equal((await q(env, 'SELECT count(*)::int n FROM public.alert_audit'))[0].n, 2);
  assert.equal((await q(env, "SELECT valeur v FROM public.parametres WHERE cle='site'"))[0].v, 'Accentué é à û — Site');
  assert.equal((await q(env, "SELECT atlas_id FROM public.employes WHERE id='EMP-1'"))[0].atlas_id, 42);

  // Sequences: a new row with no explicit id must not collide with imported ids.
  const nid = (await q(env, "INSERT INTO public.users (username,password_hash,role) VALUES ('new','h','agent') RETURNING id"))[0].id;
  assert.equal(nid, 8);
  const aid = (await q(env, "INSERT INTO public.alert_audit (alert_id,created_at,actor,action,detail) VALUES ('ALT-1','x','a','A','d') RETURNING id"))[0].id;
  assert.equal(aid, 6);
});

test('a second import into the same target is refused; a fresh target accepts it', async t => {
  const src = buildSqlite();
  const env = await freshTarget(t);
  await importSqlite({ sqlitePath: src, targetEnv: env });
  await assert.rejects(importSqlite({ sqlitePath: src, targetEnv: env }), e => e.code === 'TARGET_NOT_EMPTY');
  const fresh = await freshTarget(t);
  const again = await importSqlite({ sqlitePath: src, targetEnv: fresh });
  assert.equal(again.verification, 'ok');
  assert.equal((await q(fresh, 'SELECT count(*)::int n FROM public.users'))[0].n, 2);
});

test('the target must be an explicitly test/confirmed database', async t => {
  const env = await freshTarget(t);
  const src = buildSqlite();
  // Point a fresh migrated database with a non-test name.
  const n = 'securisite_confirm_' + tag();
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(() => root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'));
  const named = { ...baseEnv, DATABASE_URL: (u => (u.pathname = '/' + n, u.href))(new URL(baseEnv.DATABASE_URL)) };
  await migrate({ directory: migrationsDir, migrationEnv: named });
  await assert.rejects(importSqlite({ sqlitePath: src, targetEnv: named }), e => e.code === 'TARGET_UNCONFIRMED');
  const ok = await importSqlite({ sqlitePath: src, targetEnv: { ...named, SECURISITE_IMPORT_CONFIRM: n } });
  assert.equal(ok.verification, 'ok');
});

for (const kind of ['null_pk', 'int32_overflow', 'invalid_json']) {
  test(`a ${kind} row is a blocking issue: import is refused and the target stays empty`, async t => {
    const env = await freshTarget(t);
    const src = buildSqlite(kind);
    await assert.rejects(importSqlite({ sqlitePath: src, targetEnv: env }), e => {
      assert.equal(e.code, 'VALIDATION_FAILED');
      assert.ok(e.report.tables.flatMap(x => x.issues).some(i => i.kind === kind), 'issue kind ' + kind + ' reported');
      return true;
    });
    assert.equal((await q(env, 'SELECT count(*)::int n FROM public.parametres'))[0].n, 0, 'no partial write');
  });
}

test('foreign-key order is respected (parking_zones before parking_places, security_alerts before alert_audit)', async t => {
  const env = await freshTarget(t);
  const report = await importSqlite({ sqlitePath: buildSqlite(), targetEnv: env });
  assert.equal(report.verification, 'ok');
  assert.equal((await q(env, "SELECT zone FROM public.parking_places WHERE num='A1'"))[0].zone, 'A');
  assert.equal((await q(env, "SELECT count(*)::int n FROM public.alert_audit WHERE alert_id='ALT-1'"))[0].n, 2);
});
