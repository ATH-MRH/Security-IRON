const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

function report(db) {
  const missing = [];
  function rows(table, columns, sql) {
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const actual = found ? db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name) : [];
    if (!found || columns.some(column => !actual.includes(column))) {
      missing.push({ table, columns: columns.filter(column => !actual.includes(column)) });
      return null;
    }
    return db.prepare(sql).all();
  }
  const parameters = rows('parametres', ['cle','valeur'], "SELECT cle,valeur FROM parametres WHERE cle IN ('site','adresse') ORDER BY cle");
  const counts = (table, column) => rows(table, [column], `SELECT "${column}" AS value, COUNT(*) AS count FROM "${table}" GROUP BY "${column}" ORDER BY "${column}"`);
  return {
    parametres: parameters === null ? null : Object.fromEntries(['site','adresse'].map(key => [key, parameters.find(row => row.cle === key)?.valeur ?? null])),
    employes: rows('employes', ['site_id','site_nom'], 'SELECT DISTINCT site_id,site_nom FROM employes ORDER BY site_id,site_nom'),
    incidents_lieu: counts('incidents', 'lieu'),
    main_courante_lieu: counts('main_courante', 'lieu'),
    pietons_point: counts('pietons', 'point'),
    parking_zones: rows('parking_zones', ['zone','nom'], 'SELECT zone AS code,nom FROM parking_zones ORDER BY zone'),
    parking_mouvements_zone: counts('parking_mouvements', 'zone'),
    security_alerts_site: counts('security_alerts', 'site'),
    security_alerts_zone: counts('security_alerts', 'zone'),
    unavailable: missing,
  };
}

// SQLite opens only an isolated copy: the original is read with filesystem APIs.
// Rebuild SHM on the copy; copying a live shared-memory lock/index is unnecessary.
function reportFile(file) {
  function capture() {
    const main = fs.readFileSync(file); // Missing source fails before any temp creation.
    const optional = suffix => {
      try { return fs.readFileSync(file + suffix); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    if (optional('-journal')?.length) throw new Error('Journal source présent : diagnostic refusé, utiliser une copie cohérente au repos');
    return [main, optional('-wal')];
  }
  const first = capture();
  const second = capture();
  if (first.some((value, i) => value === null ? second[i] !== null : second[i] === null || !value.equals(second[i]))) {
    throw new Error('Source modifiée pendant la copie : réessayer lorsque les écritures sont suspendues');
  }
  let directory, db, failure, result;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-location-report-'));
    const copy = path.join(directory, 'snapshot.db');
    fs.writeFileSync(copy, first[0], { mode: 0o600 });
    if (first[1] !== null) fs.writeFileSync(copy + '-wal', first[1], { mode: 0o600 });
    db = new DatabaseSync(copy, { readOnly: true });
    db.exec('BEGIN');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.some(row => row.quick_check !== 'ok')) throw new Error('Copie SQLite incohérente');
    result = report(db);
    db.exec('COMMIT');
  } catch (error) { failure = error; }
  finally {
    for (const cleanup of [() => { if (db) db.close(); }, () => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }]) {
      try { cleanup(); }
      catch (error) {
        if (failure) failure.message += ' ; nettoyage échoué : ' + error.message;
        else failure = new Error('Nettoyage échoué : ' + error.message, { cause: error });
      }
    }
  }
  if (failure) throw failure;
  return result;
}

function main() {
  if (process.argv.length > 3) throw new Error('Usage: node backend/scripts/report-historical-locations.js [database-path]');
  const file = process.argv[2] || process.env.SECURISITE_DB_PATH ||
    path.join(process.env.SECURISITE_DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'securisite.db');
  process.stdout.write(JSON.stringify(reportFile(file), null, 2) + '\n');
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error('Diagnostic historique : ' + error.message); process.exitCode = 1; }
}
module.exports = { report, reportFile };
