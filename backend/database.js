const { Pool } = require('pg');

const sslRequired =
  process.env.DATABASE_URL?.includes('sslmode=require') ||
  process.env.PGSSLMODE === 'require';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/securisite',
  ssl: sslRequired ? { rejectUnauthorized: false } : false,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nom_complet TEXT,
    role        TEXT DEFAULT 'agent',
    created_at  TIMESTAMPTZ DEFAULT NOW()
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
    creation  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS visiteurs (
    id      TEXT PRIMARY KEY,
    prenom  TEXT,
    nom     TEXT,
    societe TEXT,
    hote    TEXT,
    motif   TEXT,
    arrivee TEXT,
    badge   TEXT,
    statut  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS vehicules (
    id            TEXT PRIMARY KEY,
    plaque        TEXT,
    type          TEXT,
    conducteur    TEXT,
    societe       TEXT,
    motif         TEXT,
    entree        TEXT,
    sortie        TEXT,
    statut        TEXT,
    place_parking TEXT,
    lapi_photo    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pietons (
    id       TEXT PRIMARY KEY,
    datetime TEXT,
    nom      TEXT,
    badge    TEXT,
    type     TEXT,
    point    TEXT,
    sens     TEXT,
    resultat TEXT,
    notes    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id          TEXT PRIMARY KEY,
    ref         TEXT UNIQUE,
    datetime    TEXT,
    type        TEXT,
    lieu        TEXT,
    gravite     TEXT,
    statut      TEXT,
    agent       TEXT,
    description TEXT,
    actions     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS badges (
    ref      TEXT PRIMARY KEY,
    nom      TEXT,
    type     TEXT,
    niveau   TEXT,
    emis     TEXT,
    validite TEXT,
    etat     TEXT,
    societe  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS parking_zones (
    zone     TEXT PRIMARY KEY,
    nom      TEXT,
    total    INTEGER,
    reserve  INTEGER,
    handicap INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS parking_places (
    num   TEXT PRIMARY KEY,
    zone  TEXT REFERENCES parking_zones(zone),
    etat  TEXT,
    plaque TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS parking_mouvements (
    id       TEXT PRIMARY KEY,
    datetime TEXT,
    plaque   TEXT,
    place    TEXT,
    zone     TEXT,
    action   TEXT,
    duree    INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS main_courante (
    id          TEXT PRIMARY KEY,
    datetime    TEXT,
    poste       TEXT,
    agent       TEXT,
    type        TEXT,
    lieu        TEXT,
    description TEXT,
    priorite    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS lapi_lectures (
    id               TEXT PRIMARY KEY,
    datetime         TEXT,
    plaque_detectee  TEXT,
    plaque_raw       TEXT,
    confiance        INTEGER,
    image            TEXT,
    statut           TEXT,
    action           TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS parametres (
    cle    TEXT PRIMARY KEY,
    valeur TEXT
  )`,
  `ALTER TABLE employes ADD COLUMN IF NOT EXISTS atlas_id          INTEGER`,
  `ALTER TABLE employes ADD COLUMN IF NOT EXISTS site_id           INTEGER`,
  `ALTER TABLE employes ADD COLUMN IF NOT EXISTS site_nom          TEXT`,
  `ALTER TABLE employes ADD COLUMN IF NOT EXISTS groupe            TEXT`,
  `ALTER TABLE employes ADD COLUMN IF NOT EXISTS date_affectation  TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_employes_atlas   ON employes(atlas_id)`,
  `CREATE INDEX IF NOT EXISTS idx_employes_site    ON employes(site_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pietons_dt       ON pietons(datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_dt     ON incidents(datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_vehicules_entree ON vehicules(entree)`,
  `CREATE INDEX IF NOT EXISTS idx_mc_dt            ON main_courante(datetime)`,
  `CREATE INDEX IF NOT EXISTS idx_lapi_dt          ON lapi_lectures(datetime)`,
];

async function init() {
  const bcrypt = require('bcryptjs');
  const client = await pool.connect();
  try {
    for (const stmt of SCHEMA) await client.query(stmt);
    console.log('[DB] Schéma PostgreSQL initialisé');
    // Crée les comptes par défaut si la table users est vide
    const { rows } = await client.query('SELECT COUNT(*) AS n FROM users');
    if (parseInt(rows[0].n, 10) === 0) {
      const defaults = [
        ['admin',        'securisite',    'Administrateur',         'admin'],
        ['system_admin', 'securisite2026','Administrateur système', 'admin'],
        ['agent',        'agent',         'Agent de sûreté',        'agent'],
      ];
      for (const [u, p, n, r] of defaults) {
        const hash = await bcrypt.hash(p, 10);
        await client.query(
          'INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [u, hash, n, r]
        );
      }
      console.log('[DB] Comptes par défaut créés : admin/securisite, system_admin/securisite2026, agent/agent');
    }
  } finally {
    client.release();
  }
}

const db = {
  pool,
  query: (sql, params = []) => pool.query(sql, params),
  get:   async (sql, params = []) => (await pool.query(sql, params)).rows[0],
  all:   async (sql, params = []) => (await pool.query(sql, params)).rows,
  init,
};

module.exports = db;
