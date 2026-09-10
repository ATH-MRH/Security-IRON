'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');
const { configuration } = require('../backend/database');
const { testEnvironment } = require('./helpers/postgres-test-config');
const { migrate } = require('../backend/db/postgresql/migrate');

const env = testEnvironment();
const realDirectory = path.join(__dirname, '../backend/db/postgresql/migrations');
const names = ['001_core_legacy.sql', '002_alert_core.sql'];
const source = names.map(name => fs.readFileSync(path.join(realDirectory, name)));
const hashes = source.map(bytes => createHash('sha256').update(bytes).digest('hex'));
// This suite validates the PG-2.3 catalogue (001 -> 002) in isolation; later
// migrations (003+) must not widen its scope, so it runs against a private
// two-file directory rather than the live migrations folder.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-pg23-catalogue-'));
names.forEach((n, i) => fs.writeFileSync(path.join(directory, n), source[i]));
const initialRule = { escalation: [30,60,120], incidentCritical: true, badgeThreshold: 3, badgeWindowSeconds: 120 };
const expectedColumns = {
  security_alerts: 'id created_at updated_at site zone type level origin created_by username status owner acknowledged_at resolved_at comment latitude longitude equipment cancellation_requested escalation_step policy',
  alert_audit: 'id alert_id created_at actor action detail',
  alert_notifications: 'id alert_id user_id created_at message read_at',
  alert_config_audit: 'id created_at actor previous current',
  alert_rules: 'id config',
};
const alertTables = Object.keys(expectedColumns).sort();
const coreTables = ['users','employes','visiteurs','vehicules','pietons','incidents','badges','parking_zones','parking_places','parking_mouvements','main_courante','lapi_lectures','parametres'].sort();
const allTables = [...coreTables, ...alertTables].sort();
const identityTables = ['alert_audit', 'alert_notifications', 'alert_config_audit'];
const integerColumns = new Set(['security_alerts.level','security_alerts.created_by','security_alerts.cancellation_requested','security_alerts.escalation_step','alert_audit.id','alert_notifications.id','alert_notifications.user_id','alert_config_audit.id','alert_rules.id']);
const nullableColumns = new Set(['security_alerts.owner','security_alerts.acknowledged_at','security_alerts.resolved_at','security_alerts.latitude','security_alerts.longitude','alert_notifications.read_at']);
let root;
before(async () => { root = new Client(configuration(env)); await root.connect(); });
after(async () => { if (root) await root.end(); fs.rmSync(directory, { recursive: true, force: true }); });

async function fixture(t, apply = true) {
  const database = 'securisite_test_pg23_' + randomBytes(6).toString('hex');
  let created = false;
  const roles = [], dirs = [], clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.end()));
    try {
      if (created) await root.query('DROP DATABASE "' + database + '" WITH (FORCE)');
      for (const role of roles) await root.query('DROP ROLE "' + role + '"');
    } finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await root.query('CREATE DATABASE "' + database + '"'); created = true;
  const url = new URL(env.DATABASE_URL); url.pathname = '/' + database;
  const migrationEnv = { ...env, DATABASE_URL: url.href };
  const db = new Client(configuration(migrationEnv)); clients.push(db); await db.connect();
  const run = extra => migrate({ directory, migrationEnv, lockTimeoutMs: 2000, retryDelayMs: 10, ...extra });
  const result = apply ? await run() : null;
  return {
    db, database, migrationEnv, run, result,
    async role(login = false) {
      const name = 'pg23_role_' + randomBytes(6).toString('hex');
      const password = randomBytes(24).toString('hex');
      await root.query('CREATE ROLE "' + name + '" ' + (login ? "LOGIN PASSWORD '" + password + "'" : 'NOLOGIN') + ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');
      roles.push(name); return { name, password };
    },
    catalogue(second = source[1]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-pg23-')); dirs.push(dir);
      fs.writeFileSync(path.join(dir, names[0]), source[0]);
      if (second !== null) fs.writeFileSync(path.join(dir, names[1]), second);
      return dir;
    },
    rows: async () => (await db.query('SELECT * FROM securisite_meta.schema_migrations ORDER BY version')).rows,
  };
}
async function tableNames(db) {
  return (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
}
async function alert(db, id = 'fixture-alert', level = 3, creator = 777) {
  await db.query(`INSERT INTO public.security_alerts
    (id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,policy)
    VALUES($1,'legacy timestamp','legacy timestamp','site','zone','type',$2,'MANUEL',$3,'historical-user','NOTIFIEE','[30,60,120]')`, [id,level,creator]);
}
function auditInsert(table, explicit = false) {
  const values = table === 'alert_audit'
    ? "(alert_id,created_at,actor,action,detail) VALUES('fixture-alert','stamp','actor','CREATE','original')"
    : "(created_at,actor,previous,current) VALUES('stamp','actor','{}','original')";
  return 'INSERT INTO public.' + table + (explicit ? values.replace('(', '(id,').replace('VALUES(', 'VALUES(10,') : values);
}
async function auditFixture(t, table) {
  const f = await fixture(t);
  await alert(f.db);
  await f.db.query(auditInsert(table, true));
  return f;
}

test('PG23: real catalogue 001 -> 002, exactly 18 tables and no multitenant tables', async t => {
  const f = await fixture(t, false);
  assert.deepEqual(await tableNames(f.db), []);
  assert.deepEqual(await f.run(), { applied: [1,2], reconciled: false, pending: [] });
  assert.deepEqual(await tableNames(f.db), allTables);
  assert.deepEqual((await f.db.query("SELECT tablename FROM pg_tables WHERE schemaname='securisite_meta'")).rows, [{tablename:'schema_migrations'}]);
  for (const name of ['tenants','sites','zones','memberships']) assert.equal((await f.db.query('SELECT to_regclass($1) AS name', ['public.' + name])).rows[0].name, null);
});

for (const [table, columns] of Object.entries(expectedColumns)) {
  test('PG23: exact columns/types/nullability/defaults/identity ' + table, async t => {
    const f = await fixture(t);
    const rows = (await f.db.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required,a.attidentity AS identity,a.attgenerated AS generated,
      pg_get_expr(d.adbin,d.adrelid) AS default_sql FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, ['public.' + table])).rows;
    assert.deepEqual(rows, columns.split(' ').map(name => {
      const full = table + '.' + name;
      return { name, type: integerColumns.has(full) ? 'integer' : ['security_alerts.latitude','security_alerts.longitude'].includes(full) ? 'double precision' : 'text',
        required: !nullableColumns.has(full), identity: name === 'id' && identityTables.includes(table) ? 'd' : '', generated: '',
        default_sql: ['security_alerts.comment','security_alerts.equipment'].includes(full) ? "''::text"
          : ['security_alerts.cancellation_requested','security_alerts.escalation_step'].includes(full) ? '0' : null };
    }));
  });
}

test('PG23: exact primary keys, two NO ACTION foreign keys and only two business CHECKs', async t => {
  const f = await fixture(t);
  const rows = (await f.db.query(`SELECT c.relname AS table_name,k.contype,pg_get_constraintdef(k.oid) AS definition,
    k.condeferrable,k.condeferred,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY 1,2,3`, [alertTables])).rows;
  const expected = alertTables.map(table_name => ({table_name,contype:'p',definition:'PRIMARY KEY (id)'}));
  for (const table_name of ['alert_audit','alert_notifications']) expected.push({table_name,contype:'f',definition:'FOREIGN KEY (alert_id) REFERENCES security_alerts(id)'});
  expected.push({table_name:'alert_rules',contype:'c',definition:'CHECK ((id = 1))'});
  expected.push({table_name:'security_alerts',contype:'c',definition:'CHECK (((level >= 1) AND (level <= 4)))'});
  expected.sort((a,b) => a.table_name.localeCompare(b.table_name) || a.contype.localeCompare(b.contype));
  assert.deepEqual(rows, expected.map(r => ({...r,condeferrable:false,condeferred:false,convalidated:true})));
  const fk = (await f.db.query("SELECT confupdtype,confdeltype,confmatchtype FROM pg_constraint WHERE conrelid=ANY($1::regclass[]) AND contype='f'", [['public.alert_audit','public.alert_notifications']])).rows;
  assert.deepEqual(fk, Array(2).fill({confupdtype:'a',confdeltype:'a',confmatchtype:'s'}));
});

test('PG23: levels 1..4 accepted, 0/5 rejected; existing lifecycle strings and integer flags unrestricted', async t => {
  const f = await fixture(t);
  for (const level of [1,2,3,4]) await alert(f.db, 'level-' + level, level);
  for (const level of [0,5]) await assert.rejects(alert(f.db,'invalid-'+level,level), e => e.code === '23514');
  await f.db.query("UPDATE public.security_alerts SET status='legacy-status',cancellation_requested=2,escalation_step=99 WHERE id='level-1'");
  const r = (await f.db.query("SELECT comment,equipment,owner,acknowledged_at,resolved_at,latitude,longitude FROM public.security_alerts WHERE id='level-2'")).rows[0];
  assert.deepEqual(r,{comment:'',equipment:'',owner:null,acknowledged_at:null,resolved_at:null,latitude:null,longitude:null});
});

test('PG23: rules seed exactly matches current JSON; singleton CHECK/PK and TEXT enforced', async t => {
  const f = await fixture(t);
  const rows = (await f.db.query('SELECT * FROM public.alert_rules')).rows;
  assert.deepEqual(rows, [{id:1,config:JSON.stringify(initialRule)}]);
  for (const id of [0,2]) await assert.rejects(f.db.query("INSERT INTO public.alert_rules VALUES($1,'{}')",[id]),e=>e.code==='23514');
  await assert.rejects(f.db.query("INSERT INTO public.alert_rules VALUES(1,'{}')"),e=>e.code==='23505');
  await assert.rejects(f.db.query('UPDATE public.alert_rules SET config=NULL'),e=>e.code==='23502');
  await f.db.query("UPDATE public.alert_rules SET config='legacy non-json text'");
});

test('PG23: exactly four new non-unique btree indexes, ordered keys and no partial predicate', async t => {
  const f = await fixture(t);
  const rows = (await f.db.query(`SELECT i.relname AS name,t.relname AS table_name,
    am.amname AS method,x.indisunique AS unique,x.indisvalid AS valid,x.indisready AS ready,
    pg_get_expr(x.indpred,x.indrelid) AS predicate,pg_get_expr(x.indexprs,x.indrelid) AS expression,
    ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY u(n,i)
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.n ORDER BY u.i) AS columns,
    x.indoption::text AS options
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_am am ON am.oid=i.relam WHERE t.relnamespace='public'::regnamespace
    AND t.relname=ANY($1::text[]) AND NOT x.indisprimary ORDER BY i.relname`,[alertTables])).rows;
  const indexes = [
    ['alert_audit_alert_id_idx','alert_audit',['alert_id','id']],
    ['alert_notification_user_idx','alert_notifications',['user_id','id']],
    ['alert_notifications_alert_id_idx','alert_notifications',['alert_id']],
    ['alert_status_idx','security_alerts',['status','level','created_at']],
  ];
  assert.deepEqual(rows,indexes.map(([name,table_name,columns])=>({name,table_name,method:'btree',unique:false,valid:true,ready:true,predicate:null,expression:null,columns,options:columns.map(()=>'0').join(' ')})));
});

test('PG23: trigger function is controlled, invoker, fixed search_path, no PUBLIC EXECUTE; four exact triggers', async t => {
  const f = await fixture(t);
  const functions = (await f.db.query(`SELECT n.nspname,p.proname,p.prosecdef,p.proconfig,p.prorettype::regtype::text AS returns,
    l.lanname,r.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname IN ('public','securisite_meta') ORDER BY 1,2`)).rows;
  const owner = (await f.db.query('SELECT current_user AS name')).rows[0].name;
  assert.deepEqual(functions,[{nspname:'securisite_meta',proname:'reject_alert_audit_mutation',prosecdef:false,proconfig:['search_path=pg_catalog'],returns:'trigger',lanname:'plpgsql',owner}]);
  const acl = (await f.db.query(`SELECT a.grantee,a.privilege_type FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='securisite_meta.reject_alert_audit_mutation()'::regprocedure AND a.grantee=0`)).rows;
  assert.deepEqual(acl,[]);
  const triggers = (await f.db.query(`SELECT c.relname AS table_name,t.tgname,t.tgtype,t.tgenabled,t.tgnargs,
    t.tgfoid::regprocedure::text AS function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
  const expected = ['alert_audit','alert_config_audit'].flatMap(table_name => [
    {table_name,tgname:table_name+'_no_mutation',tgtype:27},
    {table_name,tgname:table_name+'_no_truncate',tgtype:34},
  ]).map(r=>({...r,tgenabled:'O',tgnargs:0,function:'securisite_meta.reject_alert_audit_mutation()'}));
  assert.deepEqual(triggers,expected);
});

const operations = ['UPDATE','DELETE','TRUNCATE','UPSERT','MERGE UPDATE','MERGE DELETE'];
for (const table of ['alert_audit','alert_config_audit']) {
  for (const elevated of [false,true]) {
    for (const operation of operations) {
      test('PG23: '+table+' '+operation+' blocked by '+(elevated?'trigger despite artificial grants':'application ACL'), async t => {
        const f = await auditFixture(t,table);
        const role = (await f.role()).name;
        await f.db.query('GRANT USAGE ON SCHEMA public TO "'+role+'"');
        await f.db.query('GRANT SELECT,INSERT'+(elevated?',UPDATE,DELETE,TRUNCATE':'')+' ON public.'+table+' TO "'+role+'"');
        await f.db.query('GRANT USAGE ON SEQUENCE public.'+table+'_id_seq TO "'+role+'"');
        const original = (await f.db.query('SELECT * FROM public.'+table+' WHERE id=10')).rows;
        await f.db.query('SET ROLE "'+role+'"');
        // Ordinary application reads/inserts work even without USAGE on securisite_meta.
        assert.deepEqual((await f.db.query('SELECT * FROM public.'+table+' WHERE id=10')).rows,original);
        assert.equal((await f.db.query(auditInsert(table)+' RETURNING id')).rows[0].id,1);
        const field = table === 'alert_audit' ? 'detail' : 'current';
        const sql = {
          UPDATE: 'UPDATE public.'+table+" SET "+field+"='changed' WHERE id=10",
          DELETE: 'DELETE FROM public.'+table+' WHERE id=10',
          TRUNCATE: 'TRUNCATE public.'+table,
          UPSERT: auditInsert(table,true)+' ON CONFLICT(id) DO UPDATE SET '+field+"='changed'",
          'MERGE UPDATE': 'MERGE INTO public.'+table+' AS target USING (SELECT 10 AS id) AS source ON target.id=source.id WHEN MATCHED THEN UPDATE SET '+field+"='changed'",
          'MERGE DELETE': 'MERGE INTO public.'+table+' AS target USING (SELECT 10 AS id) AS source ON target.id=source.id WHEN MATCHED THEN DELETE',
        }[operation];
        await assert.rejects(f.db.query(sql),e=>elevated ? e.code==='23514' && e.message.includes('Audit immuable') : e.code==='42501');
        assert.deepEqual((await f.db.query('SELECT * FROM public.'+table+' WHERE id=10')).rows,original);
        assert.equal((await f.db.query('SELECT count(*)::int n FROM public.'+table)).rows[0].n,2);
        await f.db.query('RESET ROLE');
      });
    }
  }
  test('PG23: '+table+' empty TRUNCATE blocked by statement trigger',async t=>{
    const f=await fixture(t);
    await assert.rejects(f.db.query('TRUNCATE public.'+table),e=>e.code==='23514'&&e.message==='Audit immuable');
  });
  test('PG23: '+table+' insert and non-conflicting upsert allowed; multirow UPDATE atomic',async t=>{
    const f=await auditFixture(t,table);
    await f.db.query(auditInsert(table)+' ON CONFLICT(id) DO NOTHING');
    const original=(await f.db.query('SELECT * FROM public.'+table+' ORDER BY id')).rows;
    const field=table==='alert_audit'?'detail':'current';
    await assert.rejects(f.db.query('UPDATE public.'+table+' SET '+field+"='changed'"),e=>e.code==='23514');
    assert.deepEqual((await f.db.query('SELECT * FROM public.'+table+' ORDER BY id')).rows,original);
  });
}

for (const table of ['alert_audit','alert_notifications']) {
  test('PG23: '+table+' FK rejects orphan/NULL and prevents parent deletion or ID update',async t=>{
    const f=await fixture(t);
    const sql=table==='alert_audit'
      ? "INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES($1,'stamp','actor','CREATE','detail')"
      : "INSERT INTO public.alert_notifications(alert_id,user_id,created_at,message) VALUES($1,777,'stamp','message')";
    await assert.rejects(f.db.query(sql,['absent']),e=>e.code==='23503');
    await assert.rejects(f.db.query(sql,[null]),e=>e.code==='23502');
    await alert(f.db);await f.db.query(sql,['fixture-alert']);
    await assert.rejects(f.db.query("DELETE FROM public.security_alerts WHERE id='fixture-alert'"),e=>e.code==='23503');
    await assert.rejects(f.db.query("UPDATE public.security_alerts SET id='changed' WHERE id='fixture-alert'"),e=>e.code==='23503');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM public.'+table)).rows[0].n,1);
  });
}

test('PG23: deleting historical user leaves alert.created_by and notification.user_id intact',async t=>{
  const f=await fixture(t);
  await f.db.query("INSERT INTO public.users(id,username,password_hash) VALUES(777,'fixture-user','fixture')");
  await alert(f.db);
  await f.db.query("INSERT INTO public.alert_notifications(alert_id,user_id,created_at,message) VALUES('fixture-alert',777,'stamp','message')");
  await f.db.query('DELETE FROM public.users WHERE id=777');
  assert.deepEqual((await f.db.query('SELECT created_by,username FROM public.security_alerts')).rows,[{created_by:777,username:'historical-user'}]);
  assert.deepEqual((await f.db.query('SELECT user_id FROM public.alert_notifications')).rows,[{user_id:777}]);
  await alert(f.db,'unknown-user',3,888);
});

for (const table of identityTables) {
  test('PG23: '+table+' auto ID, explicit ID accepted, sequence not reset by explicit import',async t=>{
    const f=await fixture(t);await alert(f.db);
    const insert=table==='alert_notifications'
      ? "INSERT INTO public.alert_notifications(alert_id,user_id,created_at,message) VALUES('fixture-alert',777,'stamp','message')"
      : auditInsert(table);
    assert.equal((await f.db.query(insert+' RETURNING id')).rows[0].id,1);
    await f.db.query(insert.replace('(', '(id,').replace('VALUES(', 'VALUES(1000,'));
    assert.equal((await f.db.query(insert+' RETURNING id')).rows[0].id,2);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM public.'+table+' WHERE id=1000')).rows[0].n,1);
    const owned=(await f.db.query("SELECT refobjid::regclass::text AS owner,deptype FROM pg_depend WHERE objid=$1::regclass AND refobjid=$2::regclass",['public.'+table+'_id_seq','public.'+table])).rows;
    assert.deepEqual(owned,[{owner:table,deptype:'i'}]);
  });
}

test('PG23: all dates and JSON stay TEXT; no JSON validation, coordinates preserve precision',async t=>{
  const f=await fixture(t);await alert(f.db);
  await f.db.query("UPDATE public.security_alerts SET policy='not-json',created_at='legacy date',latitude=36.752887,longitude=3.042048");
  const r=(await f.db.query('SELECT policy,created_at,latitude,longitude FROM public.security_alerts')).rows[0];
  assert.deepEqual(r,{policy:'not-json',created_at:'legacy date',latitude:36.752887,longitude:3.042048});
  await f.db.query("INSERT INTO public.alert_config_audit(created_at,actor,previous,current) VALUES('legacy date','actor','not-json','also not-json')");
});

test('PG23: notifications read_at remains mutable, audits do not change lifecycle tables',async t=>{
  const f=await fixture(t);await alert(f.db);
  await f.db.query("INSERT INTO public.alert_notifications(alert_id,user_id,created_at,message) VALUES('fixture-alert',777,'stamp','message')");
  await f.db.query("UPDATE public.alert_notifications SET read_at='read stamp'");
  assert.equal((await f.db.query('SELECT read_at FROM public.alert_notifications')).rows[0].read_at,'read stamp');
  await f.db.query("UPDATE public.security_alerts SET status='ACQUITTEE',acknowledged_at='ack stamp'");
  assert.equal((await f.db.query('SELECT status FROM public.security_alerts')).rows[0].status,'ACQUITTEE');
});

test('PG23: no PUBLIC table/sequence privileges and no RLS',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.db.query(`SELECT c.relname,a.privilege_type FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S') AND a.grantee=0`)).rows,[]);
  assert.deepEqual((await f.db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND (relrowsecurity OR relforcerowsecurity)")).rows,[]);
});

test('PG23: non-superuser owner/migrator applies complete catalogue without creating roles',async t=>{
  const f=await fixture(t,false),role=await f.role(true);
  await f.db.query('GRANT CREATE ON DATABASE "'+f.database+'" TO "'+role.name+'"');
  await f.db.query('GRANT USAGE,CREATE ON SCHEMA public TO "'+role.name+'"');
  const url=new URL(f.migrationEnv.DATABASE_URL);url.username=role.name;url.password=role.password;
  assert.deepEqual((await f.run({migrationEnv:{...f.migrationEnv,DATABASE_URL:url.href}})).applied,[1,2]);
  assert.deepEqual((await f.db.query("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname IN ('public','securisite_meta')")).rows,[{tableowner:role.name}]);
  assert.equal((await f.db.query("SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid='securisite_meta.reject_alert_audit_mutation()'::regprocedure")).rows[0].owner,role.name);
});

test('PG23: only one rule seeded, every other business table empty',async t=>{
  const f=await fixture(t);
  for(const table of allTables)assert.equal((await f.db.query('SELECT count(*)::int n FROM public.'+table)).rows[0].n,table==='alert_rules'?1:0,table);
});

test('PG23: exact checksums/metadata, restart preserves custom rule, audit data and sequence',async t=>{
  const f=await fixture(t);
  const history=await f.rows();assert.equal(history.length,2);
  history.forEach((r,i)=>{assert.equal(r.version,i+1);assert.equal(r.name,names[i]);assert.equal(r.checksum,hashes[i]);assert.ok(r.applied_at instanceof Date);assert.ok(BigInt(r.execution_ms)>=0n);});
  await alert(f.db);await f.db.query(auditInsert('alert_audit'));
  const config=JSON.stringify({...initialRule,badgeThreshold:4});
  await f.db.query('UPDATE public.alert_rules SET config=$1',[config]);
  const sequence=(await f.db.query('SELECT last_value,is_called FROM public.alert_audit_id_seq')).rows;
  assert.deepEqual(await f.run(),{applied:[],reconciled:false,pending:[]});
  assert.deepEqual(await f.rows(),history);
  assert.deepEqual((await f.db.query('SELECT * FROM public.alert_rules')).rows,[{id:1,config}]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.alert_audit')).rows[0].n,1);
  assert.deepEqual((await f.db.query('SELECT last_value,is_called FROM public.alert_audit_id_seq')).rows,sequence);
});

test('PG23: modified copy of 002 rejected after application, original sources unchanged',async t=>{
  const f=await fixture(t),history=await f.rows();
  const changed=f.catalogue(Buffer.concat([source[1],Buffer.from('\n-- fixture drift\n')]));
  await assert.rejects(f.run({directory:changed}),e=>e.code==='HISTORY_MISMATCH');
  assert.deepEqual(await f.rows(),history);assert.deepEqual(await tableNames(f.db),allTables);
  names.forEach((name,i)=>assert.deepEqual(fs.readFileSync(path.join(directory,name)),source[i]));
});

test('PG23: failed 002 rolls back seed/tables/sequences/functions/triggers; 001 survives; retry succeeds',async t=>{
  const f=await fixture(t,false);
  assert.deepEqual((await f.run({directory:f.catalogue(null)})).applied,[1]);
  const history=await f.rows();
  await f.db.query("INSERT INTO public.parametres VALUES('fixture-retained','yes')");
  const broken=f.catalogue(Buffer.concat([source[1],Buffer.from('\nSELECT 1/0;\n')]));
  await assert.rejects(f.run({directory:broken}),e=>e.code==='MIGRATION_FAILED'&&e.cause.code==='22012');
  assert.deepEqual(await tableNames(f.db),coreTables);assert.deepEqual(await f.rows(),history);
  assert.deepEqual((await f.db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S'")).rows,[{relname:'users_id_seq'}]);
  assert.deepEqual((await f.db.query("SELECT proname FROM pg_proc WHERE pronamespace='securisite_meta'::regnamespace")).rows,[]);
  assert.deepEqual((await f.db.query('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal')).rows,[]);
  assert.deepEqual((await f.db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'alert_%'")).rows,[]);
  assert.deepEqual((await f.db.query('SELECT * FROM public.parametres')).rows,[{cle:'fixture-retained',valeur:'yes'}]);
  assert.deepEqual((await f.run()).applied,[2]);assert.deepEqual(await tableNames(f.db),allTables);
  assert.deepEqual((await f.db.query('SELECT * FROM public.alert_rules')).rows,[{id:1,config:JSON.stringify(initialRule)}]);
  assert.deepEqual((await f.rows()).map(r=>r.checksum),hashes);
});


test('PG23: TRUNCATE parent CASCADE cannot erase audit or its alert',async t=>{
  const f=await auditFixture(t,'alert_audit');
  const original=(await f.db.query('SELECT * FROM public.alert_audit')).rows;
  await assert.rejects(f.db.query('TRUNCATE public.security_alerts CASCADE'),e=>e.code==='23514'&&e.message==='Audit immuable');
  assert.deepEqual((await f.db.query('SELECT * FROM public.alert_audit')).rows,original);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.security_alerts')).rows[0].n,1);
});
