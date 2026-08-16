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

/* ── Schéma (dialecte SQLite) ─────────────────────────────────────────────── */
const ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nom_complet   TEXT,
    role          TEXT DEFAULT 'agent',
    created_at    TEXT DEFAULT (${ISO})
  )`,
  `CREATE TABLE IF NOT EXISTS employes (
    id        TEXT PRIMARY KEY,
    matricule TEXT UNIQUE,
    prenom    TEXT,
    nom       TEXT,
    service   TEXT,
    fonction  TEXT,
    badge     TEXT,
    niveau    TEXT,
    statut    TEXT,
    creation  TEXT,
    atlas_id          INTEGER,
    site_id           INTEGER,
    site_nom          TEXT,
    groupe            TEXT,
    date_affectation  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS visiteurs (
    id      TEXT PRIMARY KEY,
    prenom  TEXT, nom TEXT, societe TEXT, hote TEXT, motif TEXT,
    arrivee TEXT, badge TEXT, statut TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS vehicules (
    id            TEXT PRIMARY KEY,
    plaque TEXT, type TEXT, conducteur TEXT, societe TEXT, motif TEXT,
    entree TEXT, sortie TEXT, statut TEXT, place_parking TEXT, lapi_photo TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pietons (
    id TEXT PRIMARY KEY,
    datetime TEXT, nom TEXT, badge TEXT, type TEXT, point TEXT,
    sens TEXT, resultat TEXT, notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    ref TEXT UNIQUE, datetime TEXT, type TEXT, lieu TEXT, gravite TEXT,
    statut TEXT, agent TEXT, description TEXT, actions TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS badges (
    ref TEXT PRIMARY KEY,
    nom TEXT, type TEXT, niveau TEXT, emis TEXT, validite TEXT, etat TEXT, societe TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS parking_zones (
    zone TEXT PRIMARY KEY,
    nom TEXT, total INTEGER, reserve INTEGER, handicap INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS parking_places (
    num TEXT PRIMARY KEY,
    zone TEXT REFERENCES parking_zones(zone),
    etat TEXT, plaque TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS parking_mouvements (
    id TEXT PRIMARY KEY,
    datetime TEXT, plaque TEXT, place TEXT, zone TEXT, action TEXT, duree INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS main_courante (
    id TEXT PRIMARY KEY,
    datetime TEXT, poste TEXT, agent TEXT, type TEXT, lieu TEXT,
    description TEXT, priorite TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS lapi_lectures (
    id TEXT PRIMARY KEY,
    datetime TEXT, plaque_detectee TEXT, plaque_raw TEXT, confiance INTEGER,
    image TEXT, statut TEXT, action TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS parametres (
    cle TEXT PRIMARY KEY,
    valeur TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_employes_atlas   ON employes(atlas_id)`,
  `CREATE INDEX IF NOT EXISTS idx_employes_site    ON employes(site_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pietons_dt       ON pietons(datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_dt     ON incidents(datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_vehicules_entree ON vehicules(entree)`,
  `CREATE INDEX IF NOT EXISTS idx_mc_dt            ON main_courante(datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_lapi_dt          ON lapi_lectures(datetime)`,
];

// Ajoute une colonne si elle n'existe pas (migration douce des bases existantes)
function ensureColumn(table, col, type) {
  const cols = sdb.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) {
    sdb.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

async function init() {
  const bcrypt = require('bcryptjs');
  for (const stmt of SCHEMA) sdb.exec(stmt);

  // Traçabilité : compte connecté ayant créé l'enregistrement (journal d'audit)
  const auditTables = ['employes', 'visiteurs', 'vehicules', 'pietons', 'incidents',
                       'badges', 'main_courante', 'lapi_lectures', 'parking_mouvements'];
  for (const t of auditTables) ensureColumn(t, 'created_by', 'TEXT');

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
  dbPath,
};

module.exports = db;
