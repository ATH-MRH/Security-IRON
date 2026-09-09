/**
 * SécuriSite — Moteur de base de données LOCAL (SQLite)
 * ------------------------------------------------------
 * Produit autonome vendu sur clé USB : aucune dépendance serveur.
 * La base est un simple fichier sur le PC du client.
 *
 * Cette couche expose la MÊME interface que l'ancienne version PostgreSQL
 * (query / get / all / init / transaction) afin de ne quasiment rien changer
 * dans routes.js / auth.js. Les placeholders façon Postgres ($1,$2,…) sont
 * automatiquement convertis en placeholders SQLite (?).
 */
const path = require('path');
const fs   = require('fs');
const { DatabaseSync } = require('node:sqlite');   // SQLite intégré à Node (aucune compilation)

/* ── Emplacement du fichier base ──────────────────────────────────────────
 * Dans l'app Electron, main.js définit SECURISITE_DB_PATH vers un dossier
 * inscriptible (userData). En exécution Node simple, on retombe sur ./data.  */
const dataDir = process.env.SECURISITE_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.SECURISITE_DB_PATH || path.join(dataDir, 'securisite.db');

const sdb = new DatabaseSync(dbPath);
sdb.exec('PRAGMA journal_mode = WAL');   // meilleure robustesse / concurrence lecture
sdb.exec('PRAGMA foreign_keys = ON');

/* ── Conversion $1,$2,… → ?  (+ undefined → null) ─────────────────────────── */
function convert(sql, params) {
  if (!params || params.length === 0) return [sql, []];
  const ordered = [];
  const newSql = sql.replace(/\$(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1];
    ordered.push(v === undefined ? null : v);
    return '?';
  });
  return [newSql, ordered];
}

// Un statement qui RENVOIE des lignes (SELECT / PRAGMA / …RETURNING) doit
// passer par .all(), sinon better-sqlite3 lève « does not return data ».
const RETURNS_ROWS = /^\s*(select|pragma|with|explain)/i;
function isReader(sql) {
  return RETURNS_ROWS.test(sql) || /\breturning\b/i.test(sql);
}

function exec(sql, params) {
  const [s, p] = convert(sql, params);
  const stmt = sdb.prepare(s);
  if (isReader(s)) return { rows: stmt.all(...p) };
  const info = stmt.run(...p);
  return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
}

// The migration runner is the only owner of schema initialization.
const migrations = require('./db/migrate');
async function init() {
  migrations.migrate(sdb);
  const bcrypt = require('bcryptjs');

  console.log('[DB] Schéma SQLite initialisé →', dbPath);

  const { c } = sdb.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c === 0) {
    const defaults = [
      ['admin',        'securisite',     'Administrateur',         'admin'],
      ['system_admin', 'securisite2026', 'Administrateur système', 'admin'],
      ['agent',        'agent',          'Agent de sûreté',        'agent'],
    ];
    const ins = sdb.prepare(
      'INSERT OR IGNORE INTO users (username, password_hash, nom_complet, role) VALUES (?,?,?,?)'
    );
    for (const [u, p, n, r] of defaults) ins.run(u, await bcrypt.hash(p, 10), n, r);
    console.log('[DB] Comptes par défaut créés : admin/securisite, system_admin/securisite2026, agent/agent');
  }
}

/* ── Transaction (remplace l'ancien pool.connect + BEGIN/COMMIT) ──────────── */
function transaction(fn) {
  sdb.exec('BEGIN');
  try {
    const r = fn();
    sdb.exec('COMMIT');
    return r;
  } catch (e) {
    sdb.exec('ROLLBACK');
    throw e;
  }
}

const db = {
  raw: sdb,
  query: async (sql, params = []) => exec(sql, params),
  get:   async (sql, params = []) => exec(sql, params).rows[0],
  all:   async (sql, params = []) => exec(sql, params).rows,
  run:   (sql, params = []) => exec(sql, params),   // synchrone, pour les transactions
  transaction,
  init,
  assertSchemaReady: () => migrations.assertCurrent(sdb),
  dbPath,
};

module.exports = db;
