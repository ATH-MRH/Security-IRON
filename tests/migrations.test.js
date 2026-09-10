// Historical fixture frozen from d77c0d4, independent of the migration.
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


const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { migrate: runMigrations, assertCurrent: checkCurrent } = require('../backend/db/migrate');
const { backup } = require('../backend/db/backup');
const baselineFile = path.join(__dirname, '../backend/db/migrations/001_baseline.js');

// Existing A2.1 cases explicitly exercise the frozen version-001 catalog.
const baselineDirectories = new WeakMap();
function migrate(db, options = {}) {
  return runMigrations(db, { directory: baselineDirectories.get(db), ...options });
}
function assertCurrent(db, options = {}) {
  return checkCurrent(db, { directory: baselineDirectories.get(db), ...options });
}

function fixture(t, disk = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-migration-test-'));
  const file = path.join(directory, 'source.db');
  const db = new DatabaseSync(disk ? file : ':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  const baselineDirectory = path.join(directory, 'baseline-only');
  fs.mkdirSync(baselineDirectory);
  fs.copyFileSync(baselineFile, path.join(baselineDirectory, '001_baseline.js'));
  baselineDirectories.set(db, baselineDirectory);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, file };
}
function historical(db, alerts = false, createdBy = true) {
  for (const sql of SCHEMA) db.exec(sql);
  if (createdBy) for (const table of ['employes','visiteurs','vehicules','pietons','incidents','badges','main_courante','lapi_lectures','parking_mouvements']) ensureColumn(db,table,'created_by','TEXT');
  if (alerts) createAlertSchema(db);
}
function snapshot(db) {
  const result = {};
  for (const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all()) {
    result[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return JSON.parse(JSON.stringify(result));
}
function objects(db) {
  return db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all();
}
function catalog(root, extra) {
  const directory = path.join(root, 'migrations');
  fs.mkdirSync(directory);
  fs.copyFileSync(baselineFile, path.join(directory, '001_baseline.js'));
  for (const [name, content] of Object.entries(extra || {})) fs.writeFileSync(path.join(directory, name), content);
  return directory;
}
const memoryBackup = () => 'test:memory-snapshot';
function seedHistorical(db) {
  db.exec("INSERT INTO users(id,username,password_hash,nom_complet,role) VALUES(42,'operator','hash-original','Opérateur','agent'); INSERT INTO parametres VALUES('site','Nom de site historique'); INSERT INTO incidents(id,ref,statut,created_by) VALUES('INC-1','REF-1','ouvert','operator'); INSERT INTO visiteurs(id,nom,statut) VALUES('VIS-1','Visiteur','attendu');");
}
function seedAlert(db) {
  db.prepare(`INSERT INTO security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,policy)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ALT-old','2026-01-01','2026-01-02','Site texte','Zone texte','Historique',3,'INCIDENT',42,'operator','ACQUITTEE','À conserver','[40,80,160]');
  db.exec("INSERT INTO alert_audit VALUES(5,'ALT-old','2026-01-01','operator','CREATION','Historique'); INSERT INTO alert_notifications VALUES(7,'ALT-old',42,'2026-01-01','Message historique','2026-01-02'); INSERT INTO alert_config_audit VALUES(3,'2026-01-01','operator','{}','{}');");
  db.prepare('UPDATE alert_rules SET config=?').run(JSON.stringify({escalation:[40,80,160],incidentCritical:false,badgeThreshold:7,badgeWindowSeconds:60}));
}

test('migration: fresh database receives exactly the historical baseline plus ledger', t => {
  const {db}=fixture(t); const reference=new DatabaseSync(':memory:');
  try {
    historical(reference,true);
    const result=migrate(db,{backupDatabase:()=>{throw new Error('Unexpected backup');}});
    assert.deepEqual(result,{applied:[1],backup:null});
    assert.deepEqual(objects(db),objects(reference));
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,0);
    assert.equal(db.prepare('SELECT version,name,length(checksum) AS length FROM schema_migrations').get().length,64);
    assertCurrent(db);
  } finally {reference.close();}
});
test('migration: pre-Alert-Core database keeps business rows and gains alerts', t => {
  const {db}=fixture(t); historical(db);seedHistorical(db);const before=snapshot(db);
  let backups=0;migrate(db,{backupDatabase:()=>{backups++;return memoryBackup();}});
  for(const [table,rows] of Object.entries(before))assert.deepEqual(snapshot(db)[table],rows);
  assert.equal(backups,1);assert.ok(snapshot(db).security_alerts);
  assert.equal(db.prepare("SELECT valeur FROM parametres WHERE cle='site'").get().valeur,'Nom de site historique');
});
test('migration: missing historical created_by columns are added without changing rows', t => {
  const {db}=fixture(t); historical(db,false,false);
  db.exec("INSERT INTO visiteurs(id,nom,statut) VALUES('VIS-1','Ancien','attendu')");
  migrate(db,{backupDatabase:memoryBackup});
  assert.deepEqual({...db.prepare("SELECT id,nom,statut,created_by FROM visiteurs").get()},{id:'VIS-1',nom:'Ancien',statut:'attendu',created_by:null});
});
test('migration: post-Alert-Core adoption preserves all data and custom rules', t => {
  const {db}=fixture(t);historical(db,true);seedHistorical(db);seedAlert(db);
  const before=snapshot(db),schema=objects(db);migrate(db,{backupDatabase:memoryBackup});
  assert.deepEqual(snapshot(db),before);assert.deepEqual(objects(db),schema);
});
test('migration: replay is a no-op without backup or new audit', t => {
  const {db}=fixture(t);migrate(db);seedHistorical(db);seedAlert(db);
  const before=snapshot(db),ledger=db.prepare('SELECT * FROM schema_migrations').all();
  assert.deepEqual(migrate(db,{backupDatabase:()=>{throw new Error('Unexpected backup');}}),{applied:[],backup:null});
  assert.deepEqual(snapshot(db),before);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),ledger);
});
test('migration: audit and config triggers continue rejecting updates and deletes', t => {
  const {db}=fixture(t);migrate(db);seedHistorical(db);seedAlert(db);
  for(const table of ['alert_audit','alert_config_audit']) {
    assert.throws(()=>db.exec(`UPDATE ${table} SET actor='modified'`),/Audit immuable/);
    assert.throws(()=>db.exec(`DELETE FROM ${table}`),/Audit immuable/);
  }
});
test('migration: failed JS migration rolls back DDL, data and ledger; previous version survives', t => {
  const {db,directory}=fixture(t);migrate(db);seedHistorical(db);
  const before=snapshot(db),ledger=db.prepare('SELECT * FROM schema_migrations').all();
  const dir=catalog(directory,{'002_failure.js':`module.exports.up=db=>{db.exec("CREATE TABLE failed_probe(id); UPDATE users SET role='changed';");throw new Error('injected failure');};`});
  assert.throws(()=>migrate(db,{directory:dir,backupDatabase:memoryBackup}),/Migration 2.*injected failure/);
  assert.deepEqual(snapshot(db),before);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),ledger);assert.equal(db.isTransaction,false);
});
test('migration: failed first baseline leaves neither partial schema nor version', t => {
  const {db}=fixture(t);db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');const before=objects(db);
  assert.throws(()=>migrate(db,{backupDatabase:memoryBackup}),/Schéma baseline incompatible : users/);
  assert.deepEqual(objects(db),before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='schema_migrations'").get().n,0);
});
test('migration: changed applied source checksum is rejected before any backup', t => {
  const {db,directory}=fixture(t);const dir=catalog(directory);migrate(db,{directory:dir});
  fs.appendFileSync(path.join(dir,'001_baseline.js'),'\n// changed after application\n');
  const before=db.prepare('SELECT * FROM schema_migrations').all();
  assert.throws(()=>migrate(db,{directory:dir,backupDatabase:()=>{throw new Error('Unexpected backup');}}),/Checksum incohérent/);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),before);
});
test('migration: null checksums and unknown versions are refused explicitly', t => {
  const {db}=fixture(t);migrate(db);db.exec('UPDATE schema_migrations SET checksum=NULL');
  assert.throws(()=>migrate(db),/Checksum incohérent/);
  db.exec('UPDATE schema_migrations SET version=9');
  assert.throws(()=>migrate(db),/Historique de migrations inconnu/);
});
test('migration: SQL format works and failing SQL rolls back', t => {
  const {db,directory}=fixture(t);const dir=catalog(directory,{'002_probe.sql':'CREATE TABLE migration_probe(id INTEGER PRIMARY KEY); INSERT INTO migration_probe VALUES(1);'});
  assert.deepEqual(migrate(db,{directory:dir}).applied,[1,2]);
  fs.writeFileSync(path.join(dir,'003_failure.sql'),'INSERT INTO migration_probe VALUES(2); SELECT * FROM nonexistent_table;');
  assert.throws(()=>migrate(db,{directory:dir,backupDatabase:memoryBackup}),/Migration 3/);
  assert.deepEqual(db.prepare('SELECT id FROM migration_probe').all().map(r=>r.id),[1]);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,2);
});
test('migration: foreign keys stay enabled and violations abort a migration', t => {
  const {db,directory}=fixture(t);migrate(db);
  const dir=catalog(directory,{'002_fk.sql':"INSERT INTO alert_audit(alert_id,created_at,actor,action,detail) VALUES('missing','now','test','test','test');"});
  assert.throws(()=>migrate(db,{directory:dir,backupDatabase:memoryBackup}),/FOREIGN KEY/);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alert_audit').get().n,0);
});
test('migration: disabled foreign keys and parent transactions are refused', t => {
  const {db}=fixture(t);db.exec('PRAGMA foreign_keys=OFF');assert.throws(()=>migrate(db),/foreign_keys=ON/);
  db.exec('PRAGMA foreign_keys=ON; BEGIN;');assert.throws(()=>migrate(db),/transaction parente/);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
});
test('migration: async JS migration is rejected before its body executes', t => {
  const {db,directory}=fixture(t);migrate(db);const dir=catalog(directory,{'002_async.js':'module.exports.up=async db=>{db.exec("CREATE TABLE async_probe(id)");};'});
  assert.throws(()=>migrate(db,{directory:dir,backupDatabase:memoryBackup}),/synchrone/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='async_probe'").get().n,0);
});
test('backup: pending historical baseline creates a coherent WAL snapshot, not a post-migration copy', t => {
  const {db,directory}=fixture(t,true);historical(db,true);seedHistorical(db);seedAlert(db);db.exec('PRAGMA wal_autocheckpoint=0');
  db.exec("INSERT INTO visiteurs(id,nom) VALUES('WAL-only','Dernière ligne')");const before=snapshot(db);
  const result=migrate(db,{backupDirectory:path.join(directory,'backups')});
  assert.ok(fs.existsSync(result.backup));assert.match(result.backup,/source\.db-\d{4}-\d{2}-\d{2}T/);
  const copy=new DatabaseSync(result.backup,{readOnly:true});
  try {assert.deepEqual(snapshot(copy),before);assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='schema_migrations'").get().n,0);assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{copy.close();}
  const entries=fs.readdirSync(path.join(directory,'backups'));
  assert.deepEqual(migrate(db,{backupDirectory:path.join(directory,'backups')}),{applied:[],backup:null});
  assert.deepEqual(fs.readdirSync(path.join(directory,'backups')),entries);
});
test('backup: fresh disk database does not create a backup directory', t => {
  const {db,directory}=fixture(t,true);const dest=path.join(directory,'backups');migrate(db,{backupDirectory:dest});assert.equal(fs.existsSync(dest),false);
});
test('backup: two snapshots never overwrite one another', t => {
  const {db,directory}=fixture(t,true);historical(db);const dest=path.join(directory,'backups');
  const first=backup(db,{directory:dest});const bytes=fs.readFileSync(first);
  db.exec("INSERT INTO parametres VALUES('site','Changed')");const second=backup(db,{directory:dest});
  assert.notEqual(first,second);assert.deepEqual(fs.readFileSync(first),bytes);assert.ok(fs.existsSync(second));
});
test('backup: filesystem failure prevents every migration write', t => {
  const {db,directory}=fixture(t,true);historical(db);seedHistorical(db);const before=snapshot(db),schema=objects(db);
  const invalid=path.join(directory,'not-a-directory');fs.writeFileSync(invalid,'occupied');
  assert.throws(()=>migrate(db,{backupDirectory:invalid}));
  assert.deepEqual(snapshot(db),before);assert.deepEqual(objects(db),schema);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='schema_migrations'").get().n,0);
});
test('backup: busy WAL checkpoint prevents migration', t => {
  const {db,file}=fixture(t,true);historical(db);db.exec("INSERT INTO parametres VALUES('site','Before')");
  const reader=new DatabaseSync(file);reader.exec('BEGIN');reader.prepare('SELECT * FROM parametres').all();
  db.exec("UPDATE parametres SET valeur='After'");
  try {assert.throws(()=>migrate(db),/Checkpoint WAL incomplet/);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='schema_migrations'").get().n,0);}finally{reader.exec('ROLLBACK');reader.close();}
});
// The former 'startup: failed migration prevents listen…' test booted the PostgreSQL
// server against a SQLite migration state; server.js no longer uses the SQLite runner.
// Its PostgreSQL equivalent (start() rejects before listen/timer on an invalid migration
// history) lives in tests/postgres-alert-core-readiness.test.js and
// tests/postgres-alert-core-startup.test.js. This file keeps the standalone SQLite runner
// unit tests below, which still cover backend/db/migrate.js as historical reference.

for (const [type,name] of [
  ['table','alert_notifications'],
  ['trigger','alert_audit_no_update'],
  ['index','alert_status_idx'],
]) test(`readiness: missing ${type} ${name} is refused without repair`, t => {
  const {db}=fixture(t);migrate(db);
  const ledger=db.prepare('SELECT * FROM schema_migrations').all();
  db.exec(`DROP ${type} ${name}`);
  const expected=new RegExp(`missing ${type} ${name}`);
  assert.throws(()=>assertCurrent(db),expected);
  assert.throws(()=>migrate(db,{backupDatabase:()=>{throw new Error('Unexpected backup');}}),expected);
  assert.equal(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(name),undefined);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),ledger);
});
test('readiness: wrong physical object type names the object and expected type', t => {
  const {db}=fixture(t);migrate(db);
  db.exec('DROP TABLE alert_notifications; CREATE VIEW alert_notifications AS SELECT 1 AS placeholder;');
  assert.throws(()=>assertCurrent(db),/alert_notifications expected table, found view/);
  assert.throws(()=>migrate(db),/alert_notifications expected table, found view/);
});
test('readiness: healthy current baseline validates without migration, backup or data changes', t => {
  const {db}=fixture(t);migrate(db);seedHistorical(db);seedAlert(db);
  const before=snapshot(db),schema=objects(db),ledger=db.prepare('SELECT * FROM schema_migrations').all();
  assertCurrent(db);assertCurrent(db);
  assert.deepEqual(migrate(db,{backupDatabase:()=>{throw new Error('Unexpected backup');}}),{applied:[],backup:null});
  assert.deepEqual(snapshot(db),before);assert.deepEqual(objects(db),schema);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),ledger);
});
test('readiness: missing baseline object after a new migration aborts before version commit', t => {
  const {db,directory}=fixture(t);migrate(db);
  const dir=catalog(directory,{'002_break.sql':'DROP INDEX alert_status_idx;'});
  assert.throws(()=>migrate(db,{directory:dir,backupDatabase:memoryBackup}),/missing index alert_status_idx/);
  assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='alert_status_idx'").get());
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,1);
  assertCurrent(db);
});
for(const rollbackFails of [false,true]) test(`rollback: original cause preserved when rollback ${rollbackFails?'fails':'succeeds'}`, t => {
  const {db,directory}=fixture(t);migrate(db);
  const dir=catalog(directory,{'002_failure.sql':'INJECTED_FAILURE'});
  const originalError=new Error('original migration failure');
  const rollbackError=new Error('secondary rollback failure');
  const proxy=new Proxy(db,{get(target,key){
    if(key==='exec')return sql=>{
      if(sql==='INJECTED_FAILURE')throw originalError;
      if(sql==='ROLLBACK'&&rollbackFails)throw rollbackError;
      return target.exec(sql);
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  try {
    assert.throws(()=>migrate(proxy,{directory:dir,backupDatabase:memoryBackup}),error=>{
      assert.match(error.message,/Migration 2.*original migration failure/);
      assert.equal(error.cause,originalError);
      if(rollbackFails){assert.match(error.message,/ROLLBACK.*secondary rollback failure/);assert.equal(error.rollbackError,rollbackError);}
      else assert.equal(error.rollbackError,undefined);
      return true;
    });
    assert.equal(db.isTransaction,rollbackFails);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,1);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');}
});
for(const child of [false,true])test(`backup path: migrations ${child?'child':'directory itself'} refused before writes`,t=>{
  const {db,directory}=fixture(t,true);historical(db);seedHistorical(db);
  const dir=catalog(directory);const target=child?path.join(dir,'backups'):dir;
  const before=objects(db),rows=snapshot(db),files=fs.readdirSync(dir);
  assert.throws(()=>migrate(db,{directory:dir,backupDirectory:target,backupDatabase:()=>{throw new Error('Backup must not run');}}),/backupDirectory en conflit/);
  assert.deepEqual(objects(db),before);assert.deepEqual(snapshot(db),rows);assert.deepEqual(fs.readdirSync(dir),files);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").get(),undefined);
});
test('backup path: symlink alias with absent child cannot bypass migration directory check', t=>{
  const {db,directory}=fixture(t,true);historical(db);const dir=catalog(directory);
  const alias=path.join(directory,'alias');fs.symlinkSync(dir,alias,'junction');
  assert.throws(()=>migrate(db,{directory:dir,backupDirectory:path.join(alias,'not-created')}),/backupDirectory en conflit/);
  assert.equal(fs.existsSync(path.join(dir,'not-created')),false);
});
test('backup path: separate sibling directory still creates a valid backup',t=>{
  const {db,directory}=fixture(t,true);historical(db);seedHistorical(db);const before=snapshot(db);
  const dir=catalog(directory),destination=path.join(directory,'migrations-backups');
  const result=migrate(db,{directory:dir,backupDirectory:destination});
  assert.deepEqual(result.applied,[1]);assert.ok(fs.existsSync(result.backup));
  const copy=new DatabaseSync(result.backup,{readOnly:true});
  try {assert.deepEqual(snapshot(copy),before);}finally{copy.close();}
  assertCurrent(db,{directory:dir});
});
test('backup path: parent traversal after a symlink is resolved by filesystem semantics',t=>{
  const {db,directory}=fixture(t,true);historical(db);const dir=catalog(directory);
  const nested=path.join(dir,'nested');fs.mkdirSync(nested);
  const alias=path.join(directory,'alias-parent');fs.symlinkSync(nested,alias,'junction');
  const destination=alias+path.sep+'..'+path.sep+'not-created';
  assert.throws(()=>backup(db,{directory:destination,migrationsDirectory:dir}),/backupDirectory en conflit/);
  assert.equal(fs.existsSync(path.join(dir,'not-created')),false);
});

// A2.2 runs against the real, complete migration catalog.
const { randomUUID } = require('node:crypto');
function currentDatabase(t) {
  const { db } = fixture(t);
  runMigrations(db);
  return db;
}
function local(db) {
  return {
    tenant: db.prepare("SELECT * FROM tenants WHERE code='local'").get(),
    site: db.prepare("SELECT * FROM sites WHERE code='main'").get(),
  };
}
function tenantRow(db, code = randomUUID()) {
  const id = randomUUID();
  db.prepare('INSERT INTO tenants(id,code,name,created_at) VALUES(?,?,?,?)').run(id,code,'Client test','2026-01-01');
  return id;
}
function siteRow(db, tenant, code = randomUUID()) {
  const id = randomUUID();
  db.prepare('INSERT INTO sites(id,tenant_id,code,name,timezone,created_at) VALUES(?,?,?,?,?,?)').run(id,tenant,code,'Site test','UTC','2026-01-01');
  return id;
}
function zoneRow(db, site, tenant, code = randomUUID(), kind = null, status = 'active') {
  const id = randomUUID();
  db.prepare('INSERT INTO zones(id,site_id,tenant_id,code,name,kind,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,site,tenant,code,'Zone test',kind,status,'2026-01-01');
  return id;
}
function historicalLocations(db) {
  seedHistorical(db);seedAlert(db);
  db.exec(`UPDATE incidents SET lieu='Hall';
    INSERT INTO incidents(id,lieu) VALUES('INC-2','Hall');
    INSERT INTO main_courante(id,lieu) VALUES('MC-1','Hall libre');
    INSERT INTO pietons(id,point) VALUES('P-1','Entrée libre');
    INSERT INTO parking_mouvements(id,zone) VALUES('PM-1','P texte');
    INSERT INTO parking_zones(zone,nom) VALUES('P','Parking historique');
    INSERT INTO employes(id,site_id,site_nom) VALUES('E-1',123,'Site ATLAS');
    INSERT INTO parametres VALUES('adresse','  Adresse historique  ');`);
}

test('A2.2: fresh database applies 001 then 002 without backup', t => {
  const {db}=fixture(t);
  assert.deepEqual(runMigrations(db,{backupDatabase:()=>{throw new Error('Unexpected backup');}}),{applied:[1,2],backup:null});
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version),[1,2]);
  checkCurrent(db);
});
test('A2.2: exactly one local tenant with stable UUID and independent name', t => {
  const {db}=fixture(t);migrate(db);seedHistorical(db);runMigrations(db,{backupDatabase:memoryBackup});
  const {tenant}=local(db);
  assert.equal(tenant.id,'507486ba-d55e-5142-9ac2-196da97866df');
  assert.equal(tenant.name,'Client local');assert.equal(tenant.status,'active');
  assert.ok(Number.isFinite(Date.parse(tenant.created_at)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,1);
});
test('A2.2: exactly one main site with stable UUID, UTC and no inferred mapping', t => {
  const db=currentDatabase(t),{tenant,site}=local(db);
  assert.equal(site.id,'fa831124-0323-581e-993c-1f4332a36282');
  assert.equal(site.tenant_id,tenant.id);assert.equal(site.status,'active');assert.equal(site.timezone,'UTC');
  for(const field of ['address','latitude','longitude','external_ref'])assert.equal(site[field],null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n,1);
});
test('A2.2: historical site name and address are trimmed without changing parameters', t => {
  const {db}=fixture(t);migrate(db);
  db.exec("INSERT INTO parametres VALUES('site','  Site historique  '),('adresse','  Adresse historique  ')");
  const before=snapshot(db).parametres;runMigrations(db,{backupDatabase:memoryBackup});
  assert.equal(local(db).site.name,'Site historique');assert.equal(local(db).site.address,'Adresse historique');
  assert.deepEqual(snapshot(db).parametres,before);
});
for(const value of [undefined,'','   ',null])test(`A2.2: empty or absent parameters fall back (${String(value)})`,t=>{
  const {db}=fixture(t);migrate(db);
  if(value!==undefined)for(const key of ['site','adresse'])db.prepare('INSERT INTO parametres VALUES(?,?)').run(key,value);
  runMigrations(db,{backupDatabase:memoryBackup});
  assert.equal(local(db).site.name,'Site principal');assert.equal(local(db).site.address,null);
});
test('A2.2: historical location strings produce no zones and all business rows remain identical', t => {
  const {db}=fixture(t);migrate(db);historicalLocations(db);
  const before=snapshot(db),ddl=objects(db);runMigrations(db,{backupDatabase:memoryBackup});
  const after=snapshot(db);
  for(const [table,rows] of Object.entries(before))assert.deepEqual(after[table],rows,table);
  assert.deepEqual(objects(db).filter(object=>ddl.some(old=>old.name===object.name)),ddl);
  assert.equal(after.zones.length,0);
});
test('A2.2: rerun preserves all rows and timestamps, with no duplicates or backup', t => {
  const db=currentDatabase(t),before=snapshot(db),ledger=db.prepare('SELECT * FROM schema_migrations').all();
  assert.deepEqual(runMigrations(db,{backupDatabase:()=>{throw new Error('Unexpected backup');}}),{applied:[],backup:null});
  assert.deepEqual(snapshot(db),before);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),ledger);
});
test('A2.2: direct migration replay preserves existing natural keys and edited names', t => {
  const db=currentDatabase(t);
  db.exec("UPDATE tenants SET name='Client conservé'; UPDATE sites SET name='Site conservé'");
  const before=snapshot(db);
  require('../backend/db/migrations/002_tenants_sites_zones').up(db);
  assert.deepEqual(snapshot(db),before);
});
test('A2.2: site foreign key rejects nonexistent tenant and deletion of referenced tenant', t => {
  const db=currentDatabase(t);
  assert.throws(()=>siteRow(db,randomUUID()),/FOREIGN KEY/);
  assert.throws(()=>db.exec('DELETE FROM tenants'),/FOREIGN KEY/);
});
test('A2.2: zone foreign keys and indexes target the declared parents', t => {
  const db=currentDatabase(t);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(zones)').all().map(r=>[r.from,r.table,r.to]).sort(),[['site_id','sites','id'],['tenant_id','tenants','id']]);
  for(const [index,column] of [['idx_sites_tenant','tenant_id'],['idx_zones_site','site_id'],['idx_zones_tenant','tenant_id']]){
    assert.deepEqual(db.prepare(`PRAGMA index_info(${index})`).all().map(r=>r.name),[column]);
  }
  const {site,tenant}=local(db);zoneRow(db,site.id,tenant.id);
  assert.throws(()=>db.exec('DELETE FROM sites'),/FOREIGN KEY/);
});
test('A2.2: zone insert rejects missing site with controlled error', t => {
  const db=currentDatabase(t);assert.throws(()=>zoneRow(db,randomUUID(),local(db).tenant.id),/site parent inexistant/);
});
test('A2.2: zone insert rejects another or nonexistent tenant with controlled error', t => {
  const db=currentDatabase(t);
  for(const tenant of [tenantRow(db),randomUUID()])assert.throws(()=>zoneRow(db,local(db).site.id,tenant),/tenant incompatible/);
  assert.equal(snapshot(db).zones.length,0);
});
test('A2.2: coherent zone insert and transfer to another site of same tenant succeed', t => {
  const db=currentDatabase(t),{tenant,site}=local(db),id=zoneRow(db,site.id,tenant.id);
  const other=siteRow(db,tenant.id);
  db.prepare('UPDATE zones SET site_id=? WHERE id=?').run(other,id);
  assert.equal(db.prepare('SELECT site_id FROM zones WHERE id=?').get(id).site_id,other);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('A2.2: zone update rejects missing site and tenant mismatch without mutation', t => {
  const db=currentDatabase(t),{tenant,site}=local(db),id=zoneRow(db,site.id,tenant.id),other=tenantRow(db),otherSite=siteRow(db,other);
  const before=snapshot(db).zones;
  assert.throws(()=>db.prepare('UPDATE zones SET site_id=? WHERE id=?').run(randomUUID(),id),/site parent inexistant/);
  assert.throws(()=>db.prepare('UPDATE zones SET tenant_id=? WHERE id=?').run(other,id),/tenant incompatible/);
  assert.throws(()=>db.prepare('UPDATE zones SET site_id=? WHERE id=?').run(otherSite,id),/tenant incompatible/);
  assert.deepEqual(snapshot(db).zones,before);
  db.prepare('UPDATE zones SET site_id=?,tenant_id=? WHERE id=?').run(otherSite,other,id);
  assert.equal(db.prepare('SELECT tenant_id FROM zones WHERE id=?').get(id).tenant_id,other);
});
test('A2.2: changing parent tenant cannot make existing zones inconsistent', t => {
  const db=currentDatabase(t),{tenant,site}=local(db),other=tenantRow(db);zoneRow(db,site.id,tenant.id);
  assert.throws(()=>db.prepare('UPDATE sites SET tenant_id=? WHERE id=?').run(other,site.id),/incompatible avec les zones/);
  assert.equal(local(db).site.tenant_id,tenant.id);
  const empty=siteRow(db,tenant.id);
  db.prepare('UPDATE sites SET tenant_id=? WHERE id=?').run(other,empty);
  assert.equal(db.prepare('SELECT tenant_id FROM sites WHERE id=?').get(empty).tenant_id,other);
});
test('A2.2: tenant code is globally unique', t => {
  const db=currentDatabase(t);assert.throws(()=>tenantRow(db,'local'),/UNIQUE/);
});
test('A2.2: site code is unique per tenant, reusable by another tenant', t => {
  const db=currentDatabase(t);assert.throws(()=>siteRow(db,local(db).tenant.id,'main'),/UNIQUE/);
  assert.ok(siteRow(db,tenantRow(db),'main'));
});
test('A2.2: zone code is unique per site, reusable by another site', t => {
  const db=currentDatabase(t),{tenant,site}=local(db);zoneRow(db,site.id,tenant.id,'entry');
  assert.throws(()=>zoneRow(db,site.id,tenant.id,'entry'),/UNIQUE/);
  assert.ok(zoneRow(db,siteRow(db,tenant.id),tenant.id,'entry'));
});
test('A2.2: tenant status allows only the three specified values', t => {
  const db=currentDatabase(t);
  for(const status of ['active','suspended','archived'])db.prepare('UPDATE tenants SET status=?').run(status);
  assert.throws(()=>db.exec("UPDATE tenants SET status='deleted'"),/CHECK/);
  assert.throws(()=>db.exec('UPDATE tenants SET status=NULL'),/NOT NULL/);
});
test('A2.2: zone kind and status enforce their exact domains', t => {
  const db=currentDatabase(t),{tenant,site}=local(db);
  for(const kind of [null,'perimeter','parking','building','access_point','other']){
    for(const status of ['active','archived'])assert.ok(zoneRow(db,site.id,tenant.id,randomUUID(),kind,status));
  }
  assert.throws(()=>zoneRow(db,site.id,tenant.id,randomUUID(),'guessed'),/CHECK/);
  assert.throws(()=>zoneRow(db,site.id,tenant.id,randomUUID(),null,'suspended'),/CHECK/);
  assert.throws(()=>db.exec("UPDATE zones SET kind='invalid'"),/CHECK/);
  assert.throws(()=>db.exec('UPDATE zones SET status=NULL'),/NOT NULL/);
});
test('A2.2: error at ledger write rolls back schema and backfill; retry uses stable IDs', t => {
  const {db}=fixture(t);migrate(db);historicalLocations(db);
  db.exec("CREATE TRIGGER fail_002 BEFORE INSERT ON schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'injected A2.2 failure'); END;");
  const before=snapshot(db),ddl=objects(db);
  assert.throws(()=>runMigrations(db,{backupDatabase:memoryBackup}),/injected A2.2 failure/);
  assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);assert.deepEqual(objects(db),ddl);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,1);
  db.exec('DROP TRIGGER fail_002');runMigrations(db,{backupDatabase:memoryBackup});
  assert.equal(local(db).tenant.id,'507486ba-d55e-5142-9ac2-196da97866df');
  assert.equal(local(db).site.id,'fa831124-0323-581e-993c-1f4332a36282');
});
test('A2.2: 001 to 002 backs up original database; reopened database needs no further backup', t => {
  const {db,file}=fixture(t,true);migrate(db);historicalLocations(db);const before=snapshot(db);
  const result=runMigrations(db);assert.deepEqual(result.applied,[2]);assert.ok(result.backup);
  const copy=new DatabaseSync(result.backup,{readOnly:true});
  try{
    assert.deepEqual(snapshot(copy),before);
    assert.equal(copy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,1);
    assert.equal(copy.prepare("SELECT name FROM sqlite_schema WHERE name='tenants'").get(),undefined);
  }finally{copy.close();}
  // A separate process opens the migrated file through the same runner as startup.
  const child=spawnSync(process.execPath,['-e',`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA foreign_keys=ON');try{console.log(JSON.stringify(require('./backend/db/migrate').migrate(db,{backupDatabase:()=>{throw Error('Unexpected backup')}})))}finally{db.close()}`,file],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{applied:[],backup:null});
});
test('A2.2 diagnostic: structured historical counts without database writes or migration', t => {
  const {db,file}=fixture(t,true);migrate(db);historicalLocations(db);
  const before=snapshot(db),ddl=objects(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const bytes=fs.readFileSync(file);
  const child=spawnSync(process.execPath,[path.join(__dirname,'../backend/scripts/report-historical-locations.js'),file],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const report=JSON.parse(child.stdout);
  assert.deepEqual(report.parametres,{site:'Nom de site historique',adresse:'  Adresse historique  '});
  assert.deepEqual(report.employes,[{site_id:123,site_nom:'Site ATLAS'}]);
  assert.deepEqual(report.incidents_lieu,[{value:'Hall',count:2}]);
  assert.deepEqual(report.main_courante_lieu,[{value:'Hall libre',count:1}]);
  assert.deepEqual(report.pietons_point,[{value:'Entrée libre',count:1}]);
  assert.deepEqual(report.parking_zones,[{code:'P',nom:'Parking historique'}]);
  assert.deepEqual(report.parking_mouvements_zone,[{value:'P texte',count:1}]);
  assert.deepEqual(report.security_alerts_site,[{value:'Site texte',count:1}]);
  assert.deepEqual(report.security_alerts_zone,[{value:'Zone texte',count:1}]);assert.deepEqual(report.unavailable,[]);
  assert.deepEqual(snapshot(db),before);assert.deepEqual(objects(db),ddl);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('A2.2 diagnostic: absent alerts and empty sources remain explicit', t => {
  const {db}=fixture(t);historical(db);
  const result=require('../backend/scripts/report-historical-locations').report(db);
  assert.equal(result.security_alerts_site,null);assert.equal(result.security_alerts_zone,null);
  assert.deepEqual(result.incidents_lieu,[]);assert.deepEqual(result.parametres,{site:null,adresse:null});
  assert.ok(result.unavailable.some(item=>item.table==='security_alerts'));
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").get(),undefined);
});
test('A2.2 diagnostic: missing input file fails without creating it', t => {
  const {directory}=fixture(t);const file=path.join(directory,'missing.db');
  const before=fs.readdirSync(directory);
  const child=spawnSync(process.execPath,[path.join(__dirname,'../backend/scripts/report-historical-locations.js'),file],{encoding:'utf8'});
  assert.equal(child.status,1);assert.equal(child.stdout,'');assert.match(child.stderr,/Diagnostic historique/);
  assert.equal(fs.existsSync(file),false);assert.deepEqual(fs.readdirSync(directory),before);
});

for (const status of ['active','suspended','archived']) test(`A2.2 correction: site status ${status} accepted`, t => {
  const db=currentDatabase(t),id=siteRow(db,local(db).tenant.id);
  db.prepare('UPDATE sites SET status=? WHERE id=?').run(status,id);
  assert.equal(db.prepare('SELECT status FROM sites WHERE id=?').get(id).status,status);
});
test('A2.2 correction: invalid site status refuses insert/update and transaction rolls back', t => {
  const db=currentDatabase(t),before=snapshot(db);
  db.exec('BEGIN');
  try {
    siteRow(db,local(db).tenant.id);
    assert.throws(()=>db.prepare('INSERT INTO sites(id,tenant_id,code,name,timezone,status,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),local(db).tenant.id,'invalid','Test','UTC','invalid-status','2026-01-01'),/CHECK/);
  } finally { db.exec('ROLLBACK'); }
  assert.deepEqual(snapshot(db),before);
  assert.throws(()=>db.exec("UPDATE sites SET status='invalid-status'"),/CHECK/);
  assert.deepEqual(snapshot(db),before);
});
function diagnosticFixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'a22-zero-write-test-'));
  const source=path.join(directory,'source'),temp=path.join(directory,'temp');fs.mkdirSync(source);fs.mkdirSync(temp);
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(source,'review.db');
  const capture=()=>Object.fromEntries(fs.readdirSync(source).sort().map(name=>[name,fs.readFileSync(path.join(source,name))]));
  const run=()=>spawnSync(process.execPath,[path.join(__dirname,'../backend/scripts/report-historical-locations.js'),file],{encoding:'utf8',env:{...process.env,TMPDIR:temp,TMP:temp,TEMP:temp}});
  return {source,temp,file,capture,run};
}
test('A2.2 correction: closed WAL source stays a single file over two diagnostics, no temp residue', t => {
  const f=diagnosticFixture(t),db=new DatabaseSync(f.file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE parametres(cle TEXT,valeur TEXT); INSERT INTO parametres VALUES('site','Closed WAL');");db.close();
  assert.deepEqual(fs.readdirSync(f.source),['review.db']);const before=f.capture();
  for(let i=0;i<2;i++){
    const child=f.run();assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).parametres.site,'Closed WAL');
    assert.deepEqual(f.capture(),before);assert.deepEqual(fs.readdirSync(f.temp),[]);
  }
});
test('A2.2 correction: uncheckpointed WAL data visible, source main/WAL/SHM unchanged', t => {
  const f=diagnosticFixture(t),db=new DatabaseSync(f.file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE parametres(cle TEXT,valeur TEXT); PRAGMA wal_checkpoint(TRUNCATE);");
    const main=fs.readFileSync(f.file);
    db.exec("INSERT INTO parametres VALUES('site','Only in WAL');");assert.deepEqual(fs.readFileSync(f.file),main);
    assert.ok(fs.statSync(f.file+'-wal').size>0);const before=f.capture();
    for(let i=0;i<2;i++){
      const child=f.run();assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).parametres.site,'Only in WAL');
      assert.deepEqual(f.capture(),before);assert.deepEqual(fs.readdirSync(f.temp),[]);
    }
  } finally {db.close();}
});
test('A2.2 correction: missing source creates neither source nor temp files', t => {
  const f=diagnosticFixture(t);const child=f.run();assert.equal(child.status,1);assert.match(child.stderr,/ENOENT/);
  assert.deepEqual(fs.readdirSync(f.source),[]);assert.deepEqual(fs.readdirSync(f.temp),[]);
});
test('A2.2 correction: invalid SQLite input cleans isolated copy after error', t => {
  const f=diagnosticFixture(t);fs.writeFileSync(f.file,'not a SQLite database');const before=f.capture();
  const child=f.run();assert.equal(child.status,1);assert.match(child.stderr,/Diagnostic historique/);assert.equal(child.stdout,'');
  assert.deepEqual(f.capture(),before);assert.deepEqual(fs.readdirSync(f.temp),[]);
});
test('A2.2 correction: source rollback journal refuses report without source or temp changes', t => {
  const f=diagnosticFixture(t);const db=new DatabaseSync(f.file);db.exec('CREATE TABLE data(id)');db.close();fs.writeFileSync(f.file+'-journal','pending');
  const before=f.capture(),child=f.run();assert.equal(child.status,1);assert.match(child.stderr,/Journal source présent/);
  assert.deepEqual(f.capture(),before);assert.deepEqual(fs.readdirSync(f.temp),[]);
});
