// Baseline frozen from d77c0d4. Keep this migration self-contained and immutable.
const { DatabaseSync } = require('node:sqlite');

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

function ensureColumn(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

function createAlertSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_alerts (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      site TEXT NOT NULL, zone TEXT NOT NULL, type TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),
      origin TEXT NOT NULL, created_by INTEGER NOT NULL, username TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT, acknowledged_at TEXT, resolved_at TEXT,
      comment TEXT NOT NULL DEFAULT '', latitude REAL, longitude REAL, equipment TEXT NOT NULL DEFAULT '',
      cancellation_requested INTEGER NOT NULL DEFAULT 0, escalation_step INTEGER NOT NULL DEFAULT 0,
      policy TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_audit (
      id INTEGER PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES security_alerts(id),
      created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS alert_audit_no_update BEFORE UPDATE ON alert_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TRIGGER IF NOT EXISTS alert_audit_no_delete BEFORE DELETE ON alert_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TABLE IF NOT EXISTS alert_notifications (
      id INTEGER PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES security_alerts(id), user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alert_config_audit (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, previous TEXT NOT NULL, current TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS alert_config_no_update BEFORE UPDATE ON alert_config_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TRIGGER IF NOT EXISTS alert_config_no_delete BEFORE DELETE ON alert_config_audit BEGIN SELECT RAISE(ABORT, 'Audit immuable'); END;
    CREATE TABLE IF NOT EXISTS alert_rules (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS alert_status_idx ON security_alerts(status, level, created_at);
    CREATE INDEX IF NOT EXISTS alert_notification_user_idx ON alert_notifications(user_id, id);
  `);
  db.prepare('INSERT OR IGNORE INTO alert_rules VALUES (1,?)').run(JSON.stringify({ escalation: [30,60,120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 }));
}

function createSchema(db) {
  for (const stmt of SCHEMA) db.exec(stmt);
  const auditTables = ['employes', 'visiteurs', 'vehicules', 'pietons', 'incidents',
    'badges', 'main_courante', 'lapi_lectures', 'parking_mouvements'];
  for (const table of auditTables) ensureColumn(db, table, 'created_by', 'TEXT');
  createAlertSchema(db);
}

// Refuse schema drift rather than certify a different schema as the baseline.
// Only inspect the baseline objects; never drop unrelated historical objects.
function validate(db) {
  const expected = new DatabaseSync(':memory:');
  try {
    createSchema(expected);
    const objects = expected.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
    objects.push({ type: 'table', name: 'schema_migrations' });
    const normalize = sql => sql.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim();
    for (const object of objects) {
      const actual = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(object.name);
      if (!actual) throw new Error(`Baseline schema mismatch: missing ${object.type} ${object.name}`);
      if (actual.type !== object.type) {
        throw new Error(`Baseline schema mismatch: ${object.name} expected ${object.type}, found ${actual.type}`);
      }
      if (object.sql && normalize(actual.sql) !== normalize(object.sql)) {
        throw new Error('Schéma baseline incompatible : ' + object.name);
      }
    }
  } finally { expected.close(); }
}

function up(db) {
  createSchema(db);
}
module.exports = { up, validate };
