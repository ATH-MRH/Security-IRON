const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { backup, validateBackupDirectory } = require('./backup');

const DEFAULT_DIRECTORY = path.join(__dirname, 'migrations');
const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT
)`;

function discover(directory) {
  const entries = fs.readdirSync(directory).map(name => {
    const match = /^(\d+)_([a-z0-9_-]+)\.(js|sql)$/.exec(name);
    if (!match) throw new Error('Nom de migration invalide : ' + name);
    const file = path.resolve(directory, name);
    const source = fs.readFileSync(file);
    return { version: Number(match[1]), name, file, source,
      checksum: createHash('sha256').update(source).digest('hex'), type: match[3] };
  }).sort((a, b) => a.version - b.version);
  if (!entries.length) throw new Error('Aucune migration disponible');
  entries.forEach((entry, index) => {
    if (entry.version !== index + 1) throw new Error('Versions de migrations non consécutives ou dupliquées');
  });
  return entries;
}

function applied(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get()) return [];
  return db.prepare('SELECT version,name,applied_at,checksum FROM schema_migrations ORDER BY version').all();
}

function pending(db, entries) {
  const rows = applied(db);
  rows.forEach((row, index) => {
    const known = entries[index];
    if (!known || row.version !== known.version || row.name !== known.name) {
      throw new Error('Historique de migrations inconnu ou incohérent : ' + row.version);
    }
    // NULL is representable for interoperability, but never silently trusted.
    if (row.checksum !== known.checksum) throw new Error('Checksum incohérent pour la migration ' + row.version);
  });
  return entries.slice(rows.length);
}

function assertCurrent(db, { directory = DEFAULT_DIRECTORY } = {}) {
  const entries = discover(directory);
  if (pending(db, entries).length) throw new Error('Schéma non initialisé : migrations requises');
  validateBaseline(db, entries);
}

function loadJS(entry) {
  // Execute exactly the bytes hashed above, without the CommonJS module cache.
  const module = { exports: {} };
  compileFunction(entry.source.toString('utf8'), ['require', 'module', 'exports', '__filename', '__dirname'],
    { filename: entry.file })(createRequire(entry.file), module, module.exports, entry.file, path.dirname(entry.file));
  return module.exports;
}

function validateBaseline(db, entries) {
  const { validate } = loadJS(entries[0]);
  if (typeof validate !== 'function') throw new Error('Validateur baseline manquant');
  validate(db);
}

function execute(db, entry) {
  if (entry.type === 'sql') return db.exec(entry.source.toString('utf8'));
  const { up } = loadJS(entry);
  if (typeof up !== 'function' || up.constructor.name === 'AsyncFunction') {
    throw new Error('Migration JS attendue : up(db) synchrone');
  }
  const result = up(db);
  if (result && typeof result.then === 'function') throw new Error('Promise interdite dans une migration');
}

function migrate(db, { directory = DEFAULT_DIRECTORY, backupDirectory, backupDatabase = backup } = {}) {
  if (db.isTransaction) throw new Error('Migration interdite dans une transaction parente');
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
    throw new Error('Les migrations exigent PRAGMA foreign_keys=ON avant la transaction');
  }
  const entries = discover(directory);
  const databaseFile = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const backupRoot = backupDirectory || (databaseFile && path.join(path.dirname(databaseFile), 'backups'));
  if (backupRoot) validateBackupDirectory(backupRoot, directory);
  const todo = pending(db, entries);
  if (!todo.length) {
    validateBaseline(db, entries);
    return { applied: [], backup: null };
  }
  const existing = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  let backupPath = null;
  if (existing) {
    backupPath = backupDatabase(db, { directory: backupDirectory, migrationsDirectory: directory });
    if (!backupPath || typeof backupPath !== 'string') throw new Error('Backup non confirmé : migration refusée');
  }
  const completed = [];
  for (const entry of todo) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after acquiring SQLite's writer lock (another startup may have advanced).
      const remaining = pending(db, entries);
      if (remaining.some(item => item.version === entry.version)) {
        db.exec(LEDGER);
        execute(db, entry);
        if (!db.isTransaction) throw new Error('La migration a interrompu sa transaction');
        validateBaseline(db, entries);
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Violation de clé étrangère après migration');
        db.prepare('INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES(?,?,?,?)')
          .run(entry.version, entry.name, new Date().toISOString(), entry.checksum);
        completed.push(entry.version);
      }
      db.exec('COMMIT');
    } catch (error) {
      const failure = new Error(`Migration ${entry.version} (${entry.name}) échouée : ${error.message}`, { cause: error });
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch (rollbackError) {
        failure.rollbackError = rollbackError;
        failure.message += ` ; ROLLBACK également échoué : ${rollbackError.message}`;
      }
      throw failure;
    }
  }
  return { applied: completed, backup: backupPath };
}

module.exports = { migrate, assertCurrent };
