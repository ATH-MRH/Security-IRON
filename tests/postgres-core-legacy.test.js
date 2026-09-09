'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');
const { configuration } = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment(); // Explicit local, disposable test target only.
const directory = path.join(__dirname, '../backend/db/postgresql/migrations');
const filename = '001_core_legacy.sql';
const bytes = fs.readFileSync(path.join(directory, filename));
const checksum = createHash('sha256').update(bytes).digest('hex');

// Independent compatibility contract, not parsed from the SQL under test.
// All columns are nullable TEXT except PKs, users credentials and integers below.
const columns = {
  users: 'id username password_hash nom_complet role created_at',
  employes: 'id matricule prenom nom service fonction badge niveau statut creation atlas_id site_id site_nom groupe date_affectation created_by',
  visiteurs: 'id prenom nom societe hote motif arrivee badge statut created_by',
  vehicules: 'id plaque type conducteur societe motif entree sortie statut place_parking lapi_photo created_by',
  pietons: 'id datetime nom badge type point sens resultat notes created_by',
  incidents: 'id ref datetime type lieu gravite statut agent description actions created_by',
  badges: 'ref nom type niveau emis validite etat societe created_by',
  parking_zones: 'zone nom total reserve handicap',
  parking_places: 'num zone etat plaque',
  parking_mouvements: 'id datetime plaque place zone action duree created_by',
  main_courante: 'id datetime poste agent type lieu description priorite created_by',
  lapi_lectures: 'id datetime plaque_detectee plaque_raw confiance image statut action created_by',
  parametres: 'cle valeur',
};
const integers = new Set(['users.id', 'employes.atlas_id', 'employes.site_id',
  'parking_zones.total', 'parking_zones.reserve', 'parking_zones.handicap',
  'parking_mouvements.duree', 'lapi_lectures.confiance']);
const tables = Object.keys(columns).sort();
const indexes = {
  idx_employes_atlas: ['employes', 'atlas_id'],
  idx_employes_site: ['employes', 'site_id'],
  idx_pietons_dt: ['pietons', 'datetime'],
  idx_incidents_dt: ['incidents', 'datetime'],
  idx_vehicules_entree: ['vehicules', 'entree'],
  idx_mc_dt: ['main_courante', 'datetime'],
  idx_lapi_dt: ['lapi_lectures', 'datetime'],
  idx_parking_places_zone: ['parking_places', 'zone'],
};
let root;
before(async () => { root = new Client(configuration(baseEnv)); await root.connect(); });
after(async () => { if (root) await root.end(); });

async function fixture(t, apply = true) {
  const name = 'securisite_test_pg22_' + randomBytes(6).toString('hex');
  const clients = [];
  const temporary = [];
  let created = false;
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.end()));
    try { if (created) await root.query('DROP DATABASE "' + name + '" WITH (FORCE)'); }
    finally { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await root.query('CREATE DATABASE "' + name + '"'); created = true;
  const url = new URL(baseEnv.DATABASE_URL); url.pathname = '/' + name;
  const env = { ...baseEnv, DATABASE_URL: url.href };
  const db = new Client(configuration(env)); clients.push(db); await db.connect();
  const options = { directory, migrationEnv: env, lockTimeoutMs: 2000, retryDelayMs: 10 };
  const run = overrides => migrate({ ...options, ...overrides });
  const result = apply ? await run() : null;
  return { db, env, run, result,
    copy(sql) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-pg22-'));
      temporary.push(dir); fs.writeFileSync(path.join(dir, filename), sql);
      return dir;
    },
    rows: async () => (await db.query('SELECT * FROM securisite_meta.schema_migrations ORDER BY version')).rows,
  };
}
async function publicTables(db) {
  return (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('PG22: empty database applies 001 and creates exactly 13 business tables plus registry', async t => {
  const f = await fixture(t, false);
  assert.deepEqual(await publicTables(f.db), []);
  assert.deepEqual(await f.run(), { applied: [1], reconciled: false, pending: [] });
  assert.deepEqual(await publicTables(f.db), tables);
  const all = (await f.db.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1")).rows.map(r => r.name);
  assert.deepEqual(all, [...tables.map(n => 'public.' + n), 'securisite_meta.schema_migrations'].sort());
});

test('PG22: no Alert Core, multitenant, new schema, extension, view, trigger or routine', async t => {
  const f = await fixture(t, false);
  const schemas = async () => (await f.db.query("SELECT nspname FROM pg_namespace ORDER BY 1")).rows;
  const extensions = async () => (await f.db.query('SELECT extname FROM pg_extension ORDER BY 1')).rows;
  const previousSchemas = await schemas(), previousExtensions = await extensions();
  await f.run();
  assert.deepEqual(await schemas(), [...previousSchemas, { nspname: 'securisite_meta' }].sort((a,b) => a.nspname.localeCompare(b.nspname)));
  assert.deepEqual(await extensions(), previousExtensions);
  for (const name of ['security_alerts','alert_audit','alert_notifications','alert_config_audit','alert_rules','tenants','sites','zones','memberships']) {
    assert.equal((await f.db.query('SELECT to_regclass($1) AS name', ['public.' + name])).rows[0].name, null);
  }
  assert.equal((await f.db.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','securisite_meta')")).rows[0].n, 0);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal")).rows[0].n, 0);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m','f')")).rows[0].n, 0);
});

for (const [table, list] of Object.entries(columns)) {
  test('PG22: exact PostgreSQL column types/nullability/defaults/order/identity for ' + table, async t => {
    const f = await fixture(t);
    const actual = (await f.db.query(`
      SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
             a.attnotnull AS required, a.attidentity AS identity,
             a.attgenerated AS generated, pg_get_expr(d.adbin,d.adrelid) AS default_sql
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum
    `, ['public.' + table])).rows;
    const expected = list.split(' ').map((name, i) => ({
      name, type: integers.has(table + '.' + name) ? 'integer' : 'text',
      required: i === 0 || (table === 'users' && ['username','password_hash'].includes(name)),
      identity: table === 'users' && name === 'id' ? 'd' : '', generated: '',
      default_sql: table === 'users' && name === 'role' ? "'agent'::text"
        : table === 'users' && name === 'created_at'
          ? `to_char((clock_timestamp() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'::text)`
          : null,
    }));
    assert.deepEqual(actual, expected);
  });
}

test('PG22: exactly 13 primary keys, 3 uniques and 1 FK; no added business CHECKs', async t => {
  const f = await fixture(t);
  const actual = (await f.db.query(`
    SELECT c.relname AS table_name, k.contype AS type,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS u(n,i)
        JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n ORDER BY u.i) AS columns
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname,k.contype
  `)).rows;
  const expected = Object.entries(columns).map(([table_name,list]) => ({table_name,type:'p',columns:[list.split(' ')[0]]}));
  for (const [table_name, column] of [['users','username'],['employes','matricule'],['incidents','ref']]) expected.push({table_name,type:'u',columns:[column]});
  expected.push({table_name:'parking_places',type:'f',columns:['zone']});
  expected.sort((a,b) => a.table_name.localeCompare(b.table_name) || a.type.localeCompare(b.type));
  assert.deepEqual(actual, expected);
});

test('PG22: all primary keys reject duplicates and NULL', async t => {
  const f = await fixture(t);
  for (const [table, list] of Object.entries(columns)) {
    const key = list.split(' ')[0];
    const insert = table === 'users'
      ? "INSERT INTO public.users(id,username,password_hash) VALUES($1,'fixture','not-a-login-hash')"
      : 'INSERT INTO public.' + table + '(' + key + ') VALUES($1)';
    const value = table === 'users' ? 50 : 'fixture-key';
    await f.db.query(insert, [value]);
    await rejectsCode(f.db.query(insert, [value]), '23505');
    await rejectsCode(f.db.query(insert, [null]), '23502');
  }
});

for (const [table, column] of [['users','username'],['employes','matricule'],['incidents','ref']]) {
  test('PG22: UNIQUE ' + table + '.' + column + ' enforced on distinct IDs', async t => {
    const f = await fixture(t);
    const sql = table === 'users'
      ? "INSERT INTO public.users(id,username,password_hash) VALUES($1,$2,'fixture-only')"
      : 'INSERT INTO public.' + table + '(id,' + column + ') VALUES($1,$2)';
    await f.db.query(sql, [table === 'users' ? 10 : 'a','same']);
    await rejectsCode(f.db.query(sql, [table === 'users' ? 11 : 'b','same']), '23505');
    if (table !== 'users') {
      await f.db.query(sql, ['c',null]); await f.db.query(sql, ['d',null]);
    }
  });
}

test('PG22: users requires credentials but keeps optional nullable fields and defaults', async t => {
  const f = await fixture(t);
  await rejectsCode(f.db.query("INSERT INTO public.users(password_hash) VALUES('fixture')"), '23502');
  await rejectsCode(f.db.query("INSERT INTO public.users(username) VALUES('fixture')"), '23502');
  const first = (await f.db.query("INSERT INTO public.users(username,password_hash) VALUES('fixture-a','fixture') RETURNING role,nom_complet")).rows[0];
  assert.deepEqual(first, {role:'agent',nom_complet:null});
  const second = (await f.db.query("INSERT INTO public.users(username,password_hash,role,created_at) VALUES('fixture-b','fixture',NULL,NULL) RETURNING role,created_at")).rows[0];
  assert.deepEqual(second, {role:null,created_at:null});
});

test('PG22: users.created_at is ISO UTC TEXT independent of session timezone and explicit values survive', async t => {
  const f = await fixture(t);
  await f.db.query("SET TIME ZONE 'Pacific/Auckland'");
  const row = (await f.db.query(`INSERT INTO public.users(username,password_hash)
    VALUES('fixture','fixture') RETURNING created_at,
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_now`)).rows[0];
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(row.created_at).toISOString(), row.created_at);
  assert.ok(Math.abs(Date.parse(row.created_at) - Date.parse(row.server_now)) < 2000);
  const explicit = (await f.db.query("INSERT INTO public.users(username,password_hash,created_at) VALUES('import','fixture',$1) RETURNING created_at", ['legacy date untouched'])).rows[0];
  assert.equal(explicit.created_at, 'legacy date untouched');
});

test('PG22: FK catalog is exactly nullable parking_places.zone -> parking_zones.zone NO ACTION', async t => {
  const f = await fixture(t);
  const rows = (await f.db.query(`SELECT confrelid::regclass::text AS target,
    pg_get_constraintdef(oid) AS definition, confupdtype,confdeltype,confmatchtype,
    condeferrable,condeferred,convalidated FROM pg_constraint
    WHERE conrelid='public.parking_places'::regclass AND contype='f'`)).rows;
  assert.deepEqual(rows, [{target:'parking_zones',definition:'FOREIGN KEY (zone) REFERENCES parking_zones(zone)',
    confupdtype:'a',confdeltype:'a',confmatchtype:'s',condeferrable:false,condeferred:false,convalidated:true}]);
});

test('PG22: real FK refuses orphan insert/update, accepts NULL, prevents parent delete/update without cascade', async t => {
  const f = await fixture(t);
  await f.db.query("INSERT INTO public.parking_zones(zone) VALUES('Z')");
  await f.db.query("INSERT INTO public.parking_places(num,zone) VALUES('P','Z'),('nullable',NULL)");
  await rejectsCode(f.db.query("INSERT INTO public.parking_places(num,zone) VALUES('bad','absent')"), '23503');
  await rejectsCode(f.db.query("UPDATE public.parking_places SET zone='absent' WHERE num='P'"), '23503');
  await rejectsCode(f.db.query("DELETE FROM public.parking_zones WHERE zone='Z'"), '23503');
  await rejectsCode(f.db.query("UPDATE public.parking_zones SET zone='changed' WHERE zone='Z'"), '23503');
  assert.deepEqual((await f.db.query("SELECT num,zone FROM public.parking_places WHERE num='P'")).rows, [{num:'P',zone:'Z'}]);
  await f.db.query("DELETE FROM public.parking_places WHERE num='P'");
  await f.db.query("DELETE FROM public.parking_zones WHERE zone='Z'");
});

test('PG22: historical external site, created_by, movements and negative integers remain unconstrained', async t => {
  const f = await fixture(t);
  await f.db.query("INSERT INTO public.employes(id,atlas_id,site_id,created_by) VALUES('E',42,987654,'external-user')");
  assert.deepEqual((await f.db.query('SELECT atlas_id,site_id,created_by FROM public.employes')).rows, [{atlas_id:42,site_id:987654,created_by:'external-user'}]);
  await f.db.query("INSERT INTO public.parking_mouvements(id,place,zone,duree,created_by) VALUES('M','external-place','external-zone',-1,'unknown-user')");
  await f.db.query("INSERT INTO public.parking_zones(zone,total,reserve,handicap) VALUES('Z',-1,-2,-3)");
  for (const [table,list] of Object.entries(columns)) {
    if (!list.includes('created_by') || table === 'employes') continue;
    const key = list.split(' ')[0];
    await f.db.query('INSERT INTO public.' + table + '(' + key + ',created_by) VALUES($1,$2)', ['legacy','unmapped-user']);
  }
});

test('PG22: dates and legacy strings round-trip without business type coercion', async t => {
  const f = await fixture(t);
  for (const [table,fields] of [
    ['employes',['creation','date_affectation']],['visiteurs',['arrivee']],
    ['vehicules',['entree','sortie']],['pietons',['datetime']],['incidents',['datetime']],
    ['badges',['emis','validite']],['parking_mouvements',['datetime']],
    ['main_courante',['datetime']],['lapi_lectures',['datetime']],
  ]) {
    const key = columns[table].split(' ')[0];
    const values = fields.map((_,i) => i ? '' : '09/09/2026 heure inconnue');
    await f.db.query('INSERT INTO public.' + table + '(' + [key,...fields].join(',') + ') VALUES(' + [key,...fields].map((_,i) => '$' + (i+1)).join(',') + ')', ['fixture',...values]);
    const row = (await f.db.query('SELECT ' + fields.join(',') + ' FROM public.' + table)).rows[0];
    assert.deepEqual(row, Object.fromEntries(fields.map((field,i) => [field,values[i]])));
  }
});

test('PG22: seven historical indexes plus parking FK index, exact keys and no added unique/partial index', async t => {
  const f = await fixture(t);
  const rows = (await f.db.query(`
    SELECT i.relname AS name,t.relname AS table_name,am.amname AS method,
      x.indisunique AS unique,x.indisvalid AS valid,x.indisready AS ready,
      pg_get_expr(x.indpred,x.indrelid) AS predicate,pg_get_expr(x.indexprs,x.indrelid) AS expression,
      ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY u(n,i)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.n ORDER BY u.i) AS columns,
      x.indoption::text AS options
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_am am ON am.oid=i.relam
    WHERE t.relnamespace='public'::regnamespace AND NOT EXISTS
      (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.oid) ORDER BY i.relname
  `)).rows;
  const expected = Object.entries(indexes).sort(([a],[b]) => a.localeCompare(b)).map(([name,[table_name,column]]) => ({
    name,table_name,method:'btree',unique:false,valid:true,ready:true,predicate:null,expression:null,columns:[column],options:'0',
  }));
  assert.deepEqual(rows, expected);
});

test('PG22: only users has an integer BY DEFAULT identity with its owned sequence', async t => {
  const f = await fixture(t);
  const identities = (await f.db.query("SELECT table_name,column_name,identity_generation,identity_start,identity_increment,identity_cycle FROM information_schema.columns WHERE table_schema='public' AND is_identity='YES'")).rows;
  assert.deepEqual(identities, [{table_name:'users',column_name:'id',identity_generation:'BY DEFAULT',identity_start:'1',identity_increment:'1',identity_cycle:'NO'}]);
  const sequence = (await f.db.query("SELECT pg_get_serial_sequence('public.users','id') AS name")).rows[0].name;
  assert.equal(sequence, 'public.users_id_seq');
  assert.deepEqual((await f.db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S'")).rows, [{relname:'users_id_seq'}]);
  const owned = (await f.db.query("SELECT refobjid::regclass::text AS owner,refobjsubid,deptype FROM pg_depend WHERE objid='public.users_id_seq'::regclass AND refobjid='public.users'::regclass")).rows;
  assert.deepEqual(owned, [{owner:'users',refobjsubid:1,deptype:'i'}]);
});

test('PG22: automatic IDs, explicit import ID, sequence untouched, next generated ID', async t => {
  const f = await fixture(t);
  const insert = async name => (await f.db.query("INSERT INTO public.users(username,password_hash) VALUES($1,'fixture') RETURNING id", [name])).rows[0].id;
  assert.equal(await insert('a'), 1);
  await f.db.query("INSERT INTO public.users(id,username,password_hash) VALUES(1000,'import','fixture')");
  assert.deepEqual((await f.db.query('SELECT last_value::int,is_called FROM public.users_id_seq')).rows, [{last_value:1,is_called:true}]);
  assert.equal(await insert('b'), 2);
  assert.equal((await f.db.query("SELECT id FROM public.users WHERE username='import'")).rows[0].id, 1000);
});

test('PG22: import collision is visible until PG-6 explicitly repositions identity (no automatic reset)', async t => {
  const f = await fixture(t);
  await f.db.query("INSERT INTO public.users(id,username,password_hash) VALUES(1,'import','fixture')");
  assert.deepEqual((await f.db.query('SELECT last_value::int,is_called FROM public.users_id_seq')).rows, [{last_value:1,is_called:false}]);
  await rejectsCode(f.db.query("INSERT INTO public.users(username,password_hash) VALUES('auto','fixture')"), '23505');
  assert.deepEqual((await f.db.query('SELECT id,username FROM public.users')).rows, [{id:1,username:'import'}]);
});

test('PG22: all business tables empty, no default account, parameter or parking seed', async t => {
  const f = await fixture(t);
  for (const table of tables) assert.equal((await f.db.query('SELECT count(*)::int n FROM public.' + table)).rows[0].n, 0, table);
  assert.deepEqual((await f.db.query('SELECT last_value::int,is_called FROM public.users_id_seq')).rows, [{last_value:1,is_called:false}]);
});

test('PG22: PUBLIC receives no table or sequence privilege; no RLS policy introduced', async t => {
  const f = await fixture(t);
  const privileges = (await f.db.query(`SELECT c.relname,a.privilege_type FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S') AND a.grantee=0`)).rows;
  assert.deepEqual(privileges, []);
  assert.deepEqual((await f.db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND (relrowsecurity OR relforcerowsecurity)")).rows, []);
  assert.deepEqual((await f.db.query("SELECT * FROM pg_policies WHERE schemaname='public'")).rows, []);
});

test('PG22: exact version/checksum metadata and restart is no-op preserving data and identity', async t => {
  const f = await fixture(t);
  const rows = await f.rows();
  assert.equal(rows.length,1); assert.equal(rows[0].version,1); assert.equal(rows[0].name,filename);
  assert.equal(rows[0].checksum,checksum); assert.ok(rows[0].applied_at instanceof Date); assert.ok(BigInt(rows[0].execution_ms)>=0n);
  await f.db.query("INSERT INTO public.users(username,password_hash) VALUES('keep','fixture')");
  const sequence = (await f.db.query('SELECT last_value,is_called FROM public.users_id_seq')).rows;
  assert.deepEqual(await f.run(), {applied:[],reconciled:false,pending:[]});
  assert.deepEqual(await f.rows(), rows);
  assert.deepEqual((await f.db.query('SELECT id,username FROM public.users')).rows, [{id:1,username:'keep'}]);
  assert.deepEqual((await f.db.query('SELECT last_value,is_called FROM public.users_id_seq')).rows, sequence);
});

test('PG22: altered fixture checksum is refused; original catalogue and tables remain intact', async t => {
  const f = await fixture(t);
  const history = await f.rows();
  const changed = f.copy(Buffer.concat([bytes,Buffer.from('\n-- fixture drift\n')]));
  await rejectsCode(f.run({directory:changed}), 'HISTORY_MISMATCH');
  assert.deepEqual(await f.rows(),history);
  assert.deepEqual(await publicTables(f.db),tables);
  assert.deepEqual(fs.readFileSync(path.join(directory,filename)),bytes);
});

test('PG22: late failure rolls back ALL 13 tables, identity, indexes and version; corrected fixture can restart', async t => {
  const f = await fixture(t, false);
  const broken = f.copy(Buffer.concat([bytes,Buffer.from('\nSELECT 1 / 0;\n')]));
  await assert.rejects(f.run({directory:broken}), e => e.code === 'MIGRATION_FAILED' && e.cause.code === '22012');
  assert.deepEqual(await publicTables(f.db),[]);
  assert.deepEqual((await f.db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace")).rows,[]);
  assert.deepEqual(await f.rows(),[]); // Technical bootstrap has its own transaction.
  assert.deepEqual(fs.readFileSync(path.join(directory,filename)),bytes);
  assert.deepEqual((await f.run()).applied,[1]);
  assert.deepEqual(await publicTables(f.db),tables);
  assert.equal((await f.rows())[0].checksum,checksum);
});
