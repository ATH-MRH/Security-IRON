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
const { migrate, assertCurrent } = require('../backend/db/migrate');
const { backup } = require('../backend/db/backup');
const baselineFile = path.join(__dirname, '../backend/db/migrations/001_baseline.js');

function fixture(t, disk = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-migration-test-'));
  const file = path.join(directory, 'source.db');
  const db = new DatabaseSync(disk ? file : ':memory:');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
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
test('startup: failed migration prevents listen, escalation timer and user seeding', t => {
  const {db,directory,file}=fixture(t,true);historical(db,true);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL,checksum TEXT); INSERT INTO schema_migrations VALUES(99,'unknown','old','bad');");
  const script=`const assert=require('node:assert/strict');const {app,start}=require('./server');const db=require('./backend/database');let listens=0,timers=0;app.listen=()=>{listens++;throw new Error('must not listen');};global.setInterval=()=>{timers++;throw new Error('must not schedule');};start({host:'127.0.0.1',port:0}).then(()=>{process.exitCode=1;},error=>{assert.match(error.message,/Historique de migrations inconnu/);assert.equal(listens,0);assert.equal(timers,0);assert.equal(db.raw.prepare('SELECT count(*) AS n FROM users').get().n,0);db.raw.close();});`;
  const result=spawnSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,SECURISITE_DATA_DIR:directory,SECURISITE_DB_PATH:file},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

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
