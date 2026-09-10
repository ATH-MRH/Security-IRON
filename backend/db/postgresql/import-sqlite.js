'use strict';
/**
 * Import contrôlé d'une base SécuriSite SQLite historique vers PostgreSQL.
 *
 *   SQLite (lecture seule, quick_check) -> validation -> [dry-run + rapport]
 *   -> import transactionnel dans une cible EXPLICITEMENT de test -> setval des
 *   séquences identity -> vérification (comptes + ensembles de clés + échantillon).
 *
 * Ne touche JAMAIS une base réelle sans autorisation humaine : la cible doit être
 * une base « …test… », ou `SECURISITE_IMPORT_CONFIRM` doit valoir exactement le
 * nom de la base cible. Toute base « prod/production » est refusée. La cible doit
 * être fraîche (migrations 001/002, aucune donnée) ; un réimport passe par une
 * base neuve — les journaux append-only ne peuvent pas être purgés.
 *
 * Usage :
 *   node backend/db/postgresql/import-sqlite.js <chemin.sqlite> [--dry-run]
 *
 * Connexion cible : DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.
 */
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const { configuration } = require('../../database');

const INT32_MIN = -2147483648, INT32_MAX = 2147483647;

// Tables dans l'ordre des dépendances de clés étrangères.
const TABLES = [
  { name: 'users', pk: ['id'], identity: true },
  { name: 'employes', pk: ['id'] },
  { name: 'visiteurs', pk: ['id'] },
  { name: 'vehicules', pk: ['id'] },
  { name: 'pietons', pk: ['id'] },
  { name: 'incidents', pk: ['id'] },
  { name: 'badges', pk: ['ref'] },
  { name: 'parking_zones', pk: ['zone'] },
  { name: 'parking_places', pk: ['num'] },
  { name: 'parking_mouvements', pk: ['id'] },
  { name: 'main_courante', pk: ['id'] },
  { name: 'lapi_lectures', pk: ['id'] },
  { name: 'parametres', pk: ['cle'] },
  { name: 'security_alerts', pk: ['id'] },
  { name: 'alert_audit', pk: ['id'], identity: true },
  { name: 'alert_notifications', pk: ['id'], identity: true },
  { name: 'alert_config_audit', pk: ['id'], identity: true },
  // Seul rangée pré-existante attendue (seed de 002) : on la remplace par la
  // source si elle est fournie, et on l'ignore dans le contrôle d'idempotence.
  { name: 'alert_rules', pk: ['id'], preClear: true, seeded: true },
];
const JSON_TEXT_COLUMNS = { security_alerts: ['policy'], alert_rules: ['config'] };

const fail = (code, message) => Object.assign(new Error(message), { code });
const validUtf8 = s => typeof s !== 'string' || Buffer.from(s, 'utf8').toString('utf8') === s;

function openSqlite(path) {
  let db;
  try { db = new DatabaseSync(path, { readOnly: true }); }
  catch (e) { throw fail('SQLITE_OPEN', 'Ouverture SQLite impossible : ' + e.message); }
  const check = db.prepare('PRAGMA quick_check').all();
  if (!check.length || check[0].quick_check !== 'ok') {
    db.close();
    throw fail('SQLITE_CORRUPT', 'Base SQLite incohérente (quick_check).');
  }
  return db;
}

function sqliteTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
}
function sqliteColumns(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name);
}
async function pgColumns(client, table) {
  const rows = (await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
    [table])).rows;
  return rows;
}

/** Lit et valide une table. Retourne { shared, rows, issues, source }. */
function readTable(db, spec, pgCols) {
  const src = sqliteColumns(db, spec.name);
  const pgByName = new Map(pgCols.map(c => [c.column_name, c.data_type]));
  const shared = src.filter(c => pgByName.has(c));
  const int32 = new Set(shared.filter(c => pgByName.get(c) === 'integer'));
  const jsonCols = new Set(JSON_TEXT_COLUMNS[spec.name] || []);
  let rows;
  try {
    rows = db.prepare(`SELECT ${shared.map(c => `"${c}"`).join(', ')} FROM "${spec.name}"`).all();
  } catch (e) {
    if (e && (e.code === 'ERR_OUT_OF_RANGE' || e.name === 'RangeError')) {
      return { shared, rows: [], source: 0, issues: [{ table: spec.name, kind: 'int_out_of_js_range' }] };
    }
    throw e;
  }
  const issues = [];
  const seen = new Set();
  for (const [i, row] of rows.entries()) {
    const key = spec.pk.map(c => row[c]).join(' ');
    if (spec.pk.some(c => row[c] === null || row[c] === undefined)) issues.push({ table: spec.name, row: i, kind: 'null_pk' });
    else if (seen.has(key)) issues.push({ table: spec.name, row: i, kind: 'duplicate_pk', value: key });
    else seen.add(key);
    for (const c of shared) {
      const v = row[c];
      if (int32.has(c) && typeof v === 'number' && (!Number.isInteger(v) || v < INT32_MIN || v > INT32_MAX)) {
        issues.push({ table: spec.name, row: i, kind: 'int32_overflow', column: c, value: v });
      }
      if (typeof v === 'bigint' && (v < BigInt(INT32_MIN) || v > BigInt(INT32_MAX)) && int32.has(c)) {
        issues.push({ table: spec.name, row: i, kind: 'int32_overflow', column: c, value: String(v) });
      }
      if (!validUtf8(v)) issues.push({ table: spec.name, row: i, kind: 'invalid_utf8', column: c });
      if (jsonCols.has(c) && typeof v === 'string') {
        try { JSON.parse(v); } catch { issues.push({ table: spec.name, row: i, kind: 'invalid_json', column: c }); }
      }
    }
  }
  return { shared, rows, issues, source: rows.length };
}

const HARD = new Set(['null_pk', 'duplicate_pk', 'int32_overflow', 'invalid_utf8', 'invalid_json', 'int_out_of_js_range']);

function assertTargetAllowed(name, env) {
  if (/prod|production/i.test(name)) throw fail('TARGET_FORBIDDEN', `Base « ${name} » : import interdit (production).`);
  if (/test/i.test(name)) return;
  if (env.SECURISITE_IMPORT_CONFIRM === name) return;
  throw fail('TARGET_UNCONFIRMED',
    `Base « ${name} » non reconnue comme base de test. Définir SECURISITE_IMPORT_CONFIRM=${name} `
    + 'après validation humaine, ou cibler une base « …test… ».');
}

async function importSqlite({ sqlitePath, targetEnv = process.env, dryRun = false } = {}) {
  if (!sqlitePath) throw fail('SOURCE_REQUIRED', 'Chemin de la base SQLite source requis.');
  const db = openSqlite(sqlitePath);
  const client = new Client({ ...configuration(targetEnv), application_name: 'securisite-import' });
  await client.connect();
  const report = { source: sqlitePath, database: null, dryRun, tables: [], sequences: {}, verification: null };
  try {
    report.database = (await client.query('SELECT current_database() AS d')).rows[0].d;
    const present = sqliteTables(db);

    // 1. Lecture + validation de toutes les tables présentes des deux côtés.
    const plan = [];
    for (const spec of TABLES) {
      const pgCols = await pgColumns(client, spec.name);
      if (!pgCols.length) throw fail('TARGET_SCHEMA', `Table cible public.${spec.name} absente (migrations non appliquées ?).`);
      if (!present.has(spec.name)) { report.tables.push({ name: spec.name, source: 0, imported: 0, shared: [], issues: [], skipped: 'absent de la source' }); continue; }
      const read = readTable(db, spec, pgCols);
      plan.push({ spec, ...read });
      report.tables.push({ name: spec.name, source: read.source, imported: 0, shared: read.shared, issues: read.issues });
    }
    const hardIssues = plan.flatMap(p => p.issues).filter(i => HARD.has(i.kind));
    if (hardIssues.length) {
      report.verification = 'refusé';
      throw Object.assign(fail('VALIDATION_FAILED', `${hardIssues.length} anomalie(s) bloquante(s) : import refusé.`), { report });
    }

    if (dryRun) { report.verification = 'dry-run'; return report; }

    // 2. Cible autorisée + fraîche. Les journaux append-only ne peuvent pas être
    //    purgés (triggers d'immuabilité) : un réimport passe par une base neuve.
    assertTargetAllowed(report.database, targetEnv);
    const nonEmpty = [];
    for (const { spec } of plan) {
      if (spec.seeded) continue; // seule rangée de seed attendue (alert_rules id=1)
      const n = Number((await client.query(`SELECT count(*)::int AS n FROM public.${spec.name}`)).rows[0].n);
      if (n > 0) nonEmpty.push(spec.name + '(' + n + ')');
    }
    if (nonEmpty.length) {
      throw fail('TARGET_NOT_EMPTY',
        'Tables cibles non vides : ' + nonEmpty.join(', ')
        + '. Recréer une base cible neuve (migrations 001/002) pour réimporter.');
    }

    // 3. Import transactionnel.
    await client.query('BEGIN');
    try {
      for (const { spec, shared, rows } of plan) {
        if (!rows.length) continue;
        if (spec.preClear) await client.query(`DELETE FROM public.${spec.name}`); // remplace le seed
        const cols = shared.map(c => `"${c}"`).join(', ');
        const CHUNK = 500;
        for (let off = 0; off < rows.length; off += CHUNK) {
          const slice = rows.slice(off, off + CHUNK);
          const params = [];
          const values = slice.map((row, r) => {
            const ph = shared.map((c, k) => {
              params.push(row[c] === undefined ? null : (typeof row[c] === 'bigint' ? row[c].toString() : row[c]));
              return '$' + (r * shared.length + k + 1);
            });
            return '(' + ph.join(', ') + ')';
          });
          await client.query(`INSERT INTO public.${spec.name} (${cols}) VALUES ${values.join(', ')}`, params);
        }
        report.tables.find(t => t.name === spec.name).imported = rows.length;
      }
      // 4. setval des séquences identity sur MAX(pk).
      for (const { spec } of plan) {
        if (!spec.identity) continue;
        const col = spec.pk[0];
        const seq = (await client.query('SELECT pg_get_serial_sequence($1,$2) AS s', ['public.' + spec.name, col])).rows[0].s;
        if (!seq) continue;
        const max = (await client.query(`SELECT COALESCE(MAX(${col}),0)::bigint AS m FROM public.${spec.name}`)).rows[0].m;
        await client.query('SELECT setval($1, GREATEST($2::bigint, 1), $3)', [seq, max, Number(max) > 0]);
        report.sequences[spec.name] = Number(max);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }

    // 5. Vérification post-commit (lecture seule).
    const mismatches = [];
    for (const { spec, rows } of plan) {
      const n = Number((await client.query(`SELECT count(*)::int AS n FROM public.${spec.name}`)).rows[0].n);
      if (n !== rows.length) mismatches.push(`${spec.name}: source ${rows.length} != cible ${n}`);
      const pgKeys = new Set((await client.query(
        `SELECT ${spec.pk.map(c => c).join(" || ' ' || ")} AS k FROM public.${spec.name}`)).rows.map(r => String(r.k)));
      for (const row of rows) {
        const k = spec.pk.map(c => row[c]).join(' ');
        if (!pgKeys.has(k)) mismatches.push(`${spec.name}: clé manquante « ${k} »`);
      }
    }
    report.verification = mismatches.length ? mismatches : 'ok';
    if (mismatches.length) throw Object.assign(fail('VERIFICATION_FAILED', 'Vérification post-import en échec.'), { report });
    return report;
  } finally {
    db.close();
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sqlitePath = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const report = await importSqlite({ sqlitePath, targetEnv: process.env, dryRun });
  const soft = report.tables.flatMap(t => t.issues || []);
  console.log(`[import] base ${report.database}${dryRun ? ' (dry-run)' : ''}`);
  for (const t of report.tables) {
    const flag = t.skipped ? ` — ${t.skipped}` : ` — source ${t.source}, importées ${t.imported}` + (t.issues.length ? `, ${t.issues.length} remarque(s)` : '');
    console.log(`  ${t.name}${flag}`);
  }
  if (Object.keys(report.sequences).length) console.log('  séquences :', JSON.stringify(report.sequences));
  console.log('  vérification :', Array.isArray(report.verification) ? report.verification.join(' ; ') : report.verification);
  if (soft.length) console.log(`  ${soft.length} remarque(s) non bloquante(s).`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[import] échec' + (err.code ? ' [' + err.code + ']' : '') + ' : ' + err.message);
    if (err.report) for (const i of err.report.tables.flatMap(t => t.issues || []).filter(x => HARD.has(x.kind))) {
      console.error('  -', JSON.stringify(i));
    }
    process.exit(1);
  });
}

module.exports = { importSqlite, assertTargetAllowed, TABLES };
