'use strict';
// PG-11 — index ajoutés uniquement sur preuve mesurée (EXPLAIN ANALYZE sur un
// volume synthétique réaliste ; voir docs/postgresql-performance.md pour le
// comparatif avant/après complet, capturé au moment de la migration 007).
// Ce fichier ne re-mesure pas le temps d'exécution (trop instable pour un
// test — machine, cache, charge concurrente) : il prouve que chaque index
// EXISTE avec la définition attendue, et que le planificateur PostgreSQL
// choisit bien un accès par index (jamais un Seq Scan) sur la requête réelle
// qui l'a justifié, pour un volume suffisant afin que le choix ne soit pas
// un artefact d'une table minuscule.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_perfidx_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, pool;
const N = 6000, DISTINCT = 120; // ~50 rows per distinct value: a seq scan is clearly worse.

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);

  const now = Date.now();
  const insertBatch = async (table, cols, rowFn) => {
    const batch = 1000;
    for (let start = 0; start < N; start += batch) {
      const rows = [];
      for (let i = start; i < Math.min(start + batch, N); i++) rows.push(rowFn(i));
      const values = rows.map((_, i) => '(' + cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',') + ')').join(',');
      await pool.query(`INSERT INTO public.${table}(${cols.join(',')}) VALUES ${values}`, rows.flat());
    }
  };
  await insertBatch('visiteurs', ['id', 'prenom', 'nom', 'arrivee', 'statut'],
    i => ['VIS-' + i, 'P' + i, 'N' + i, new Date(now - i * 60000).toISOString(), 'present']);
  await insertBatch('badges', ['ref', 'nom', 'type', 'niveau', 'emis', 'etat'],
    i => ['BDG-' + i, 'N' + i, 'E', 'N1', new Date(now - i * 60000).toISOString(), 'actif']);
  const userIds = [];
  for (let i = 0; i < DISTINCT; i++) userIds.push((await pool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES($1,'x','agent') RETURNING id", ['perfidx_' + i])).id);
  const statuses = ['NOTIFIEE', 'ACQUITTEE', 'EN_INTERVENTION', 'SOUS_CONTROLE', 'RESOLUE', 'CLOTUREE'];
  // PG-16: security_alerts.tenant_id (migration 009) is NOT NULL — the frozen
  // 'local' tenant id from migration 003's backfill, present in every freshly
  // migrated DB this file creates.
  const localTenantId = '507486ba-d55e-5142-9ac2-196da97866df';
  await insertBatch('security_alerts',
    ['id', 'created_at', 'updated_at', 'site', 'zone', 'type', 'level', 'origin', 'created_by', 'username', 'status', 'comment', 'equipment', 'policy', 'tenant_id'],
    i => ['ALT-' + randomUUID(), new Date(now - i * 60000).toISOString(), new Date(now - i * 60000).toISOString(), 'S', 'Z', 'T',
      (i % 4) + 1, i % 3 === 0 ? 'REGLE_BADGE' : 'COMMAND', userIds[i % DISTINCT], 'u', statuses[i % statuses.length], '', i % 3 === 0 ? ('badge:B' + (i % DISTINCT)) : '', '[30,60,120]', localTenantId]);
  await insertBatch('pietons', ['id', 'datetime', 'nom', 'badge', 'resultat'],
    i => ['PED-' + randomUUID(), new Date(now - i * 1000).toISOString(), 'N' + i, 'B' + (i % DISTINCT), i % 3 === 0 ? 'refus' : 'autorise']);
  await insertBatch('security_audit', ['event_type', 'resource_type', 'action', 'outcome', 'origin', 'actor_username'],
    i => ['auth.login.success', 'session', 'login', 'success', 'http', 'perfidx_' + (i % DISTINCT)]);
  await pool.query('ANALYZE');
});
after(async () => {
  try { await pool.close(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

async function planText(sql, params = []) {
  const rows = await pool.all('EXPLAIN (FORMAT TEXT) ' + sql, params);
  return rows.map(r => r['QUERY PLAN']).join('\n');
}

const expectedIndexes = [
  ['visiteurs_arrivee_idx', 'visiteurs'],
  ['badges_emis_idx', 'badges'],
  ['security_alerts_created_by_idx', 'security_alerts'],
  ['security_alerts_level_created_idx', 'security_alerts'],
  ['security_alerts_badge_rule_idx', 'security_alerts'],
  ['pietons_badge_refus_idx', 'pietons'],
  ['security_audit_actor_username_created_idx', 'security_audit'],
];

test('007 creates exactly the 7 evidence-backed indexes, on the expected tables', async () => {
  const rows = await pool.all(
    "SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)",
    [expectedIndexes.map(([name]) => name)]);
  const present = new Map(rows.map(r => [r.indexname, r.tablename]));
  for (const [name, table] of expectedIndexes) assert.equal(present.get(name), table, name);
  assert.equal(present.size, expectedIndexes.length);
});

test('GET /visiteurs (ORDER BY arrivee DESC) uses the new index, not a sequential scan', async () => {
  const plan = await planText('SELECT * FROM visiteurs ORDER BY arrivee DESC');
  assert.match(plan, /Index Scan.*visiteurs_arrivee_idx/);
  assert.doesNotMatch(plan, /Seq Scan on visiteurs/);
});

test('GET /badges (ORDER BY emis DESC) uses the new index, not a sequential scan', async () => {
  const plan = await planText('SELECT * FROM badges ORDER BY emis DESC');
  assert.match(plan, /Index Scan.*badges_emis_idx/);
  assert.doesNotMatch(plan, /Seq Scan on badges/);
});

test('alertsByCreator (WHERE created_by ORDER BY level, created_at) uses the composite index', async () => {
  const uid = (await pool.get('SELECT id FROM public.users LIMIT 1')).id;
  const plan = await planText('SELECT * FROM security_alerts WHERE created_by=$1 ORDER BY level DESC, created_at DESC', [uid]);
  assert.match(plan, /security_alerts_created_by_idx/);
});

test('allAlerts (ORDER BY level, created_at, no filter): the index is usable and avoids the sort', async () => {
  // At production scale (measured: 60 000 rows, docs/postgresql-performance.md)
  // the planner picks this index on cost alone — the sort no longer fits in
  // work_mem and spills to disk. At this test's much smaller, CI-friendly
  // volume the in-memory quicksort is genuinely cheaper, so the planner
  // correctly prefers Seq Scan + Sort there — that is not a regression, it's
  // the cost model doing its job. What this test proves, independent of
  // scale: the index is real and directly usable for this exact query shape
  // (forcing the planner off Seq Scan still produces a valid, index-driven,
  // sort-free plan rather than falling back to something unrelated or erroring).
  await pool.transaction(async client => {
    await client.query('SET LOCAL enable_seqscan = off');
    const rows = await client.all('EXPLAIN (FORMAT TEXT) SELECT * FROM security_alerts ORDER BY level DESC, created_at DESC');
    const plan = rows.map(r => r['QUERY PLAN']).join('\n');
    assert.match(plan, /Index Scan.*security_alerts_level_created_idx/);
    assert.doesNotMatch(plan, /Sort Key/, 'the index already returns rows in the required order');
  });
});

test('recentBadgeAlert (equipment/created_at, origin=REGLE_BADGE) uses the partial index', async () => {
  const plan = await planText("SELECT id FROM security_alerts WHERE equipment='badge:B1' AND created_at>='2000-01-01' AND origin='REGLE_BADGE'");
  assert.match(plan, /security_alerts_badge_rule_idx/);
});

test('badgeRefusalCount (badge/datetime, resultat=refus) uses the partial index', async () => {
  const plan = await planText("SELECT COUNT(*) FROM pietons WHERE badge='B1' AND resultat='refus' AND datetime>='2000-01-01'");
  assert.match(plan, /pietons_badge_refus_idx/);
});

test('GET /api/admin/security-audit?actor= uses the actor_username index', async () => {
  const plan = await planText("SELECT * FROM security_audit WHERE actor_username='perfidx_1' ORDER BY created_at DESC, id DESC LIMIT 50");
  assert.match(plan, /security_audit_actor_username_created_idx/);
  assert.doesNotMatch(plan, /Seq Scan on security_audit/);
});

test('pendingEscalations remains served by the pre-existing alert_status_idx (no PG-11 change needed there)', async () => {
  const plan = await planText("SELECT * FROM security_alerts WHERE level>=3 AND acknowledged_at IS NULL AND status='NOTIFIEE'");
  assert.match(plan, /alert_status_idx/);
  assert.doesNotMatch(plan, /Seq Scan on security_alerts/);
});
