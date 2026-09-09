const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Resolve existing ancestors too: an absent child of a symlink must not bypass the check.
function canonicalDirectory(directory) {
  // Preserve '..' until realpath resolves symlink ancestors with filesystem semantics.
  let ancestor = path.isAbsolute(directory) ? directory : process.cwd() + path.sep + directory;
  const suffix = [];
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return path.join(fs.realpathSync.native(ancestor), ...suffix);
}

function validateBackupDirectory(directory, migrationsDirectory = path.join(__dirname, 'migrations')) {
  const resolved = canonicalDirectory(directory);
  const relative = path.relative(canonicalDirectory(migrationsDirectory), resolved);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('backupDirectory en conflit avec le répertoire des migrations : ' + directory);
  }
  return resolved;
}

// Called only for an existing database with pending migrations, outside a transaction.
function backup(db, { directory, migrationsDirectory } = {}) {
  if (db.isTransaction) throw new Error('Backup interdit dans une transaction');
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) throw new Error('Backup disque indisponible pour une base mémoire');
  const root = validateBackupDirectory(directory || path.join(path.dirname(file), 'backups'), migrationsDirectory);
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(FULL)').get();
  if (checkpoint.busy || (checkpoint.log >= 0 && checkpoint.log !== checkpoint.checkpointed)) {
    throw new Error('Checkpoint WAL incomplet : migration refusée');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Exclusive directory creation prevents reusing or overwriting any backup path.
  const destination = path.join(root, `${path.basename(file)}-${stamp}-${randomUUID()}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  const target = path.join(destination, path.basename(file));
  try {
    db.prepare('VACUUM main INTO ?').run(target);
    fs.chmodSync(target, 0o600);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      const result = copy.prepare('PRAGMA quick_check').all();
      if (result.length !== 1 || result[0].quick_check !== 'ok') throw new Error('Backup SQLite invalide');
    } finally { copy.close(); }
    const fd = fs.openSync(target, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return target;
  } catch (error) {
    // Leave incomplete output for diagnosis; it is never reported as a valid backup.
    throw new Error(`Échec du backup (${target}) : ${error.message}`, { cause: error });
  }
}

module.exports = { backup, validateBackupDirectory };
