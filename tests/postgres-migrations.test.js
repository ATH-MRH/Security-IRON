'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { configuration } = require('../backend/database');
const { testEnvironment } = require('./helpers/postgres-test-config');
const { migrate, LOCK_KEY } = require('../backend/db/postgresql/migrate');
const baseEnv = testEnvironment(); // Explicit local test target; never runtime DATABASE_URL.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let root;
before(async () => { root = new Client(configuration(baseEnv)); await root.connect(); });
after(async () => { if (root) await root.end(); });

async function fixture(t, contents = {}) {
  const name = 'securisite_test_pg21_' + randomBytes(6).toString('hex');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-pg21-fixtures-'));
  const clients = [], children = [];
  let created = false;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(clients.map(c => c.end()));
    if (created) await root.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await root.query(`CREATE DATABASE "${name}"`); created = true;
  const url = new URL(baseEnv.DATABASE_URL); url.pathname = '/' + name;
  const env = { ...baseEnv, DATABASE_URL: url.href };
  const admin = new Client(configuration(env)); clients.push(admin); await admin.connect();
  const put = (file, sql) => fs.writeFileSync(path.join(directory, file), sql);
  Object.entries(contents).forEach(([file, sql]) => put(file, sql));
  const options = { directory, migrationEnv: env, lockTimeoutMs: 2000, retryDelayMs: 10 };
  return { directory, env, admin, put, clients, children, options, run: extra => migrate({ ...options, ...extra }),
    rows: async () => (await admin.query('SELECT * FROM securisite_meta.schema_migrations ORDER BY version')).rows };
}
const one = 'CREATE TABLE public.pg21_probe (id integer PRIMARY KEY); INSERT INTO public.pg21_probe VALUES(1);';
const two = 'ALTER TABLE public.pg21_probe ADD COLUMN label text;';
const catalog = { '001_probe.sql': one, '002_extend.sql': two };
const absent = async (f, table) => assert.equal((await f.admin.query('SELECT to_regclass($1) AS name', [table])).rows[0].name, null);
async function unlocked(f) {
  assert.equal((await f.admin.query('SELECT pg_try_advisory_lock($1,$2) AS yes', LOCK_KEY)).rows[0].yes, true);
  await f.admin.query('SELECT pg_advisory_unlock($1,$2)', LOCK_KEY);
}
async function waitForQuery(f, text) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await f.admin.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='securisite-migrator' AND state='active' AND position($1 in query)>0", [text]);
    if (rows.length) return rows[0].pid;
    await sleep(10);
  }
  throw Error('Runner did not reach expected SQL');
}
function childRunner(f) {
  const script = `const {migrate}=require('./backend/db/postgresql/migrate');migrate({directory:process.argv[1],migrationEnv:JSON.parse(process.env.PG21_MIGRATOR),lockTimeoutMs:3000,retryDelayMs:10}).then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.code);process.exitCode=1});`;
  const child = spawn(process.execPath, ['-e', script, f.directory], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PG21_MIGRATOR: JSON.stringify(f.env) }, stdio: ['ignore','pipe','pipe'],
  });
  f.children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

test('PG21: empty database creates only technical registry, empty catalogue is no-op', async t => {
  const f = await fixture(t); assert.deepEqual((await f.run()).applied, []);
  assert.deepEqual((await f.admin.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1")).rows, [{name:'securisite_meta.schema_migrations'}]);
  assert.deepEqual(await f.rows(), []); await unlocked(f);
});
test('PG21: 001 then 002, registry metadata, restart no-op, no business tables', async t => {
  const f = await fixture(t, catalog); assert.deepEqual((await f.run()).applied, [1,2]);
  const rows = await f.rows(); assert.equal(rows.length,2);
  for (const row of rows) { assert.match(row.checksum,/^[0-9a-f]{64}$/); assert.ok(row.applied_at instanceof Date); assert.ok(BigInt(row.execution_ms)>=0n); }
  assert.deepEqual((await f.run()).applied,[]); assert.deepEqual(await f.rows(),rows);
  assert.deepEqual((await f.admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows,[{tablename:'pg21_probe'}]);
  await unlocked(f);
});
for(const change of ['checksum','removed','renamed','db-ahead','db-gap','db-unknown']) {
  test('PG21: refuses divergent history '+change,async t=>{
    const f=await fixture(t,catalog);await f.run();
    if(change==='checksum')f.put('001_probe.sql',one+' -- changed');
    if(change==='removed')fs.unlinkSync(path.join(f.directory,'002_extend.sql'));
    if(change==='renamed')fs.renameSync(path.join(f.directory,'001_probe.sql'),path.join(f.directory,'001_renamed.sql'));
    if(change==='db-ahead')await f.admin.query("INSERT INTO securisite_meta.schema_migrations SELECT 3,'003_unknown.sql',repeat('a',64),clock_timestamp(),0");
    if(change==='db-gap')await f.admin.query('DELETE FROM securisite_meta.schema_migrations WHERE version=1');
    if(change==='db-unknown')await f.admin.query("UPDATE securisite_meta.schema_migrations SET name='001_other.sql' WHERE version=1");
    await assert.rejects(f.run(),e=>e.code==='HISTORY_MISMATCH');await unlocked(f);
  });
}
for(const names of [['001_a.sql','001_b.sql'],['001_a.sql','003_b.sql'],['000_a.sql'],['001_a.js'],['01_a.sql'],['001_A.sql'],['notes.txt']]) {
  test('PG21: invalid catalogue '+names.join(','),async t=>{
    const f=await fixture(t,Object.fromEntries(names.map(n=>[n,'SELECT 1;'])));
    await assert.rejects(f.run(),e=>['INVALID_CATALOG','INVALID_VERSIONS'].includes(e.code));await absent(f,'securisite_meta.schema_migrations');
  });
}
test('PG21: missing first applied file refused',async t=>{
  const f=await fixture(t,catalog);await f.run();fs.unlinkSync(path.join(f.directory,'001_probe.sql'));
  await assert.rejects(f.run(),e=>e.code==='INVALID_VERSIONS');
});
test('PG21: symlink catalogue entries refused',async t=>{
  const f=await fixture(t,{'001_a.sql':'SELECT 1;'});fs.symlinkSync(path.join(f.directory,'001_a.sql'),path.join(f.directory,'002_link.sql'));
  await assert.rejects(f.run(),e=>e.code==='INVALID_CATALOG');
});
test('PG21: invalid UTF8 and NUL refused before database writes',async t=>{
  const f=await fixture(t,{'001_a.sql':Buffer.from([0xff])});await assert.rejects(f.run(),e=>e.code==='INVALID_ENCODING');
  f.put('001_a.sql','SELECT 1;\0');await assert.rejects(f.run(),e=>e.code==='INVALID_ENCODING');await absent(f,'securisite_meta.schema_migrations');
});
test('PG21: explicit migrator configuration and bounded lock options required',async t=>{
  const f=await fixture(t);await assert.rejects(migrate({directory:f.directory}),e=>e.code==='MIGRATOR_REQUIRED');
  for(const n of [0,-1,Infinity,1.5])await assert.rejects(f.run({lockTimeoutMs:n}),e=>e.code==='INVALID_OPTION');
});
test('PG21: no adoption of unversioned objects',async t=>{
  const f=await fixture(t);await f.admin.query('CREATE TABLE public.pg21_existing(id integer)');
  await assert.rejects(f.run(),e=>e.code==='UNVERSIONED_DATABASE');await absent(f,'securisite_meta.schema_migrations');
});
test('PG21: SQL failure rolls back DDL and registry; 001 retained, 002 corrected and resumed',async t=>{
  const f=await fixture(t,{'001_probe.sql':one,'002_extend.sql':'CREATE TABLE public.pg21_rollback(id integer); SELEC invalid;'});
  await assert.rejects(f.run(),e=>e.code==='MIGRATION_FAILED'&&e.cause.code==='42601');
  assert.deepEqual((await f.rows()).map(r=>r.version),[1]);await absent(f,'public.pg21_rollback');await unlocked(f);
  f.put('002_extend.sql',two);assert.deepEqual((await f.run()).applied,[2]);assert.deepEqual((await f.rows()).map(r=>r.version),[1,2]);
});
test('PG21: failed registry INSERT rolls back fixture DDL',async t=>{
  const f=await fixture(t);await f.run();
  await f.admin.query("CREATE FUNCTION public.pg21_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test registry failure'; END $$; CREATE TRIGGER pg21_reject BEFORE INSERT ON securisite_meta.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.pg21_reject()");
  f.put('001_probe.sql',one);await assert.rejects(f.run(),e=>e.cause.code==='P0001');await absent(f,'public.pg21_probe');assert.deepEqual(await f.rows(),[]);
});
for(const control of ['BEGIN','COMMIT','ROLLBACK','END','ABORT','START /* nested /* x */ comment */ TRANSACTION','PREPARE TRANSACTION \'x\'','SAVEPOINT a','RELEASE a']) {
  test('PG21: forbidden transaction command '+control,async t=>{
    const f=await fixture(t,{'001_probe.sql':one+'\n-- separator\n'+control+';'});
    await assert.rejects(f.run(),e=>e.code==='TRANSACTION_CONTROL');await absent(f,'public.pg21_probe');await absent(f,'securisite_meta.schema_migrations');
  });
}
test('PG21: function/trigger bodies, quoted identifiers, strings, comments and semicolons stay intact',async t=>{
  const sql=`/* outer ; BEGIN /* nested COMMIT; */ */
    CREATE TABLE public.pg21_probe ("COMMIT;" integer, value text);
    CREATE FUNCTION public.pg21_trigger() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN NEW.value := 'BEGIN; COMMIT; ROLLBACK;'; RETURN NEW; END;
    $body$;
    CREATE TRIGGER pg21_t BEFORE INSERT ON public.pg21_probe FOR EACH ROW EXECUTE FUNCTION public.pg21_trigger();
    INSERT INTO public.pg21_probe VALUES(1,E'escaped\\\';semicolon'); -- COMMIT;
  `;
  const f=await fixture(t,{'001_probe.sql':sql});await f.run();assert.equal((await f.admin.query('SELECT value FROM public.pg21_probe')).rows[0].value,'BEGIN; COMMIT; ROLLBACK;');
});
test('PG21: standard string backslash does not hide following COMMIT',async t=>{
  const f=await fixture(t,{'001_probe.sql':"SELECT '\\'; COMMIT;"});await assert.rejects(f.run(),e=>e.code==='TRANSACTION_CONTROL');
});
test('PG21: session controls and unterminated literals refused',async t=>{
  const f=await fixture(t);
  for(const sql of ['SET search_path=evil;','RESET ALL;','DISCARD ALL;',"SELECT 'unclosed",'/* unclosed','DO $$ unclosed']){
    f.put('001_probe.sql',sql);await assert.rejects(f.run(),e=>['SESSION_CONTROL','INVALID_SQL'].includes(e.code));
  }
});
test('PG21: executed snapshot equals hashed bytes even if file changes while waiting for lock',async t=>{
  const original=one+'\r\n-- é exact bytes\r\n';const f=await fixture(t,{'001_probe.sql':original});
  await f.admin.query('SELECT pg_advisory_lock($1,$2)',LOCK_KEY);
  const running=f.run();f.put('001_probe.sql','CREATE TABLE public.pg21_wrong(id integer);');
  await sleep(50);await f.admin.query('SELECT pg_advisory_unlock($1,$2)',LOCK_KEY);await running;
  assert.equal((await f.rows())[0].checksum,createHash('sha256').update(Buffer.from(original)).digest('hex'));await absent(f,'public.pg21_wrong');
  assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.pg21_probe')).rows[0].n,1);
});
test('PG21: registry constraints reject bad checksum and negative duration',async t=>{
  const f=await fixture(t);await f.run();
  for(const [hash,ms] of [['bad',0],['a'.repeat(64),-1]])await assert.rejects(f.admin.query('INSERT INTO securisite_meta.schema_migrations VALUES(1,$1,$2,clock_timestamp(),$3)',['001_test.sql',hash,ms]),e=>e.code==='23514');
});
test('PG21: inaccessible registry stops rather than replacing/adopting it',async t=>{
  const f=await fixture(t);await f.run();await f.admin.query('REVOKE ALL ON SCHEMA securisite_meta FROM PUBLIC');
  class RestrictedClient extends Client {async connect(){await super.connect();await super.query('SET ROLE pg_read_all_stats');}}
  await assert.rejects(f.run({ClientClass:RestrictedClient}),e=>e.code==='42501');
});
test('PG21: malformed registry rejected',async t=>{
  const f=await fixture(t);await f.run();await f.admin.query('ALTER TABLE securisite_meta.schema_migrations ADD COLUMN unexpected text');
  await assert.rejects(f.run(),e=>e.code==='REGISTRY_MISMATCH');
});
test('PG21: lock timeout and release after success/error',async t=>{
  const f=await fixture(t);await f.admin.query('SELECT pg_advisory_lock($1,$2)',LOCK_KEY);
  await assert.rejects(f.run({lockTimeoutMs:60}),e=>e.code==='LOCK_TIMEOUT');
  await f.admin.query('SELECT pg_advisory_unlock($1,$2)',LOCK_KEY);await f.run();await unlocked(f);
  f.put('001_bad.sql','SELECT 1/0;');await assert.rejects(f.run());await unlocked(f);
});
test('PG21: TWO NODE PROCESSES — B waits, A commits both migrations, B is no-op',async t=>{
  const f=await fixture(t,{'001_probe.sql':one+' SELECT pg_sleep(0.4);','002_extend.sql':two+' SELECT pg_sleep(0.4);'});
  const a=childRunner(f);await waitForQuery(f,'pg_sleep');const start=Date.now();const b=childRunner(f);
  await sleep(80);assert.equal(b.child.exitCode,null);
  assert.equal((await f.admin.query('SELECT pg_try_advisory_lock($1,$2) AS yes',LOCK_KEY)).rows[0].yes,false);
  const [ar,br]=await Promise.all([a.done,b.done]);assert.equal(ar.code,0,ar.stderr);assert.equal(br.code,0,br.stderr);
  assert.deepEqual(JSON.parse(ar.stdout).applied,[1,2]);assert.deepEqual(JSON.parse(br.stdout).applied,[]);assert.ok(Date.now()-start>=300);await unlocked(f);
});
test('PG21: crashed Node process releases session lock, transaction rolls back',async t=>{
  const f=await fixture(t,{'001_probe.sql':one+' SELECT pg_sleep(0.5);'});const a=childRunner(f);await waitForQuery(f,'pg_sleep');a.child.kill('SIGKILL');await a.done;
  f.put('001_probe.sql',one);assert.deepEqual((await f.run()).applied,[1]);await unlocked(f);
});
test('PG21: lost PostgreSQL session during SQL never replays and frees lock',async t=>{
  const f=await fixture(t,{'001_probe.sql':one+' SELECT pg_sleep(10);'});
  const running=f.run();const rejected=assert.rejects(running,e=>e.code==='MIGRATION_FAILED');const pid=await waitForQuery(f,'pg_sleep');
  await f.admin.query('SELECT pg_terminate_backend($1)',[pid]);await rejected;await absent(f,'public.pg21_probe');assert.deepEqual(await f.rows(),[]);await unlocked(f);
});
for(const outcome of ['committed','not-committed','incoherent','unreachable']) {
  test('PG21: uncertain COMMIT reconciliation '+outcome+' — no blind replay',async t=>{
    const f=await fixture(t,catalog);let injected=false,connections=0;
    class UncertainClient extends Client {
      async connect(){connections++;if(outcome==='unreachable'&&connections>1)throw Error('recovery offline');return super.connect();}
      async query(sql,...args){
        if(typeof sql==='string'&&sql.startsWith('INSERT INTO securisite_meta.schema_migrations'))this.recorded=true;
        if(sql==='COMMIT'&&this.recorded&&!injected){
          injected=true;
          if(outcome==='not-committed'){await this.end();throw Error('connection lost before commit');}
          const result=await super.query(sql,...args);
          if(outcome==='incoherent')await f.admin.query("UPDATE securisite_meta.schema_migrations SET checksum=repeat('b',64)");
          const event=new Promise(resolve=>this.once('error',resolve));await f.admin.query('SELECT pg_terminate_backend($1)',[this.processID]);await event;
          return result;
        }
        return super.query(sql,...args);
      }
    }
    if(outcome==='committed'){
      const result=await f.run({ClientClass:UncertainClient});assert.equal(result.reconciled,true);assert.deepEqual(result.pending,[2]);
      assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM public.pg21_probe')).rows[0].n,1);
      assert.deepEqual((await f.run()).applied,[2]);
    }else{
      await assert.rejects(f.run({ClientClass:UncertainClient}),e=>e.code===(outcome==='not-committed'?'COMMIT_NOT_APPLIED':'COMMIT_INDETERMINATE')&&!!e.cause);
      if(outcome==='not-committed'){assert.deepEqual(await f.rows(),[]);await absent(f,'public.pg21_probe');}
      else assert.deepEqual((await f.rows()).map(r=>r.version),[1]);
    }
    await unlocked(f);
  });
}
test('PG21: SQL primary, rollback and async client secondary errors all retained',async t=>{
  const f=await fixture(t,{'001_bad.sql':'SELEC invalid;'});const secondary=Object.assign(new Error('async client'),{code:'08006'});
  class FaultClient extends Client {
    async query(sql,...args){try{return await super.query(sql,...args);}catch(error){if(sql==='SELEC invalid;')this.emit('error',secondary);throw error;}}
  }
  await assert.rejects(f.run({ClientClass:FaultClient}),e=>e.cause.code==='42601'&&e.clientError===secondary&&e.rollbackError===secondary);await unlocked(f);
});
test('PG21: search_path is explicit and all runner sessions closed',async t=>{
  const f=await fixture(t,{'001_probe.sql':"CREATE TABLE public.pg21_probe(value text); INSERT INTO public.pg21_probe VALUES(current_setting('search_path'));"});await f.run();
  assert.equal((await f.admin.query('SELECT value FROM public.pg21_probe')).rows[0].value,'pg_catalog, public, pg_temp');
  assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='securisite-migrator'")).rows[0].n,0);
});

test('PG21: registry missing integrity constraint is refused',async t=>{
  const f=await fixture(t);await f.run();await f.admin.query('ALTER TABLE securisite_meta.schema_migrations DROP CONSTRAINT schema_migrations_checksum_check');
  await assert.rejects(f.run(),e=>e.code==='REGISTRY_MISMATCH');
});
test('PG21: session lock remains held across COMMIT and ROLLBACK',async t=>{
  const f=await fixture(t,{'001_probe.sql':one,'002_bad.sql':'SELECT 1/0;'});let commits=0,rollbacks=0;
  class ObservedClient extends Client {
    async query(sql,...args){
      const result=await super.query(sql,...args);
      if(sql==='COMMIT'||sql==='ROLLBACK'){
        assert.equal((await f.admin.query('SELECT pg_try_advisory_lock($1,$2) AS locked',LOCK_KEY)).rows[0].locked,false);
        if(sql==='COMMIT')commits++;else rollbacks++;
      }
      return result;
    }
  }
  await assert.rejects(f.run({ClientClass:ObservedClient}),e=>e.cause.code==='22012');assert.equal(commits,2);assert.equal(rollbacks,1);await unlocked(f);
});
test('PG21: explicitly supplied non-superuser migrator can initialize and migrate',async t=>{
  const f=await fixture(t,{'001_probe.sql':one});const role='pg21_role_'+randomBytes(6).toString('hex');const password=randomBytes(24).toString('hex');
  await root.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  t.after(async()=>{await root.query(`DROP ROLE "${role}"`);});
  const url=new URL(f.env.DATABASE_URL);url.username=role;url.password=password;
  await f.admin.query(`GRANT CREATE ON DATABASE "${decodeURIComponent(url.pathname.slice(1))}" TO "${role}"; GRANT USAGE,CREATE ON SCHEMA public TO "${role}"`);
  const result=await f.run({migrationEnv:{...f.env,DATABASE_URL:url.href}});assert.deepEqual(result.applied,[1]);await unlocked(f);
});

for (const committed of [true,false]) {
  test('PG21: registry bootstrap COMMIT reconciliation committed='+committed,async t=>{
    const f=await fixture(t,{'001_probe.sql':one});let injected=false;
    class BootstrapClient extends Client {
      async query(sql,...args){
        if(sql==='COMMIT'&&!injected){
          injected=true;
          if(!committed){await this.end();throw Error('bootstrap response lost');}
          const result=await super.query(sql,...args);
          const event=new Promise(resolve=>this.once('error',resolve));await f.admin.query('SELECT pg_terminate_backend($1)',[this.processID]);await event;return result;
        }
        return super.query(sql,...args);
      }
    }
    if(committed){const result=await f.run({ClientClass:BootstrapClient});assert.equal(result.reconciled,true);assert.deepEqual(result.applied,[]);assert.deepEqual(result.pending,[1]);assert.deepEqual(await f.rows(),[]);}
    else{await assert.rejects(f.run({ClientClass:BootstrapClient}),e=>e.code==='COMMIT_NOT_APPLIED');await absent(f,'securisite_meta.schema_migrations');}
    await absent(f,'public.pg21_probe');assert.deepEqual((await f.run()).applied,[1]);await unlocked(f);
  });
}

// Correction regressions: substitutions occur only in temporary test fixtures.
function externalSQL(t, sql) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'securisite-pg21-external-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'outside.sql'); fs.writeFileSync(file, sql); return file;
}
test('PG21 FD: symlink substituted after inventory is refused; external SQL never executed', async t => {
  const f=await fixture(t,{'001_probe.sql':one});const target=path.join(f.directory,'001_probe.sql');
  const outside=externalSQL(t,'CREATE TABLE public.pg21_outside(id integer);');const original=fs.readdirSync;
  let pending;
  try {
    fs.readdirSync=function(dir,...args){const entries=original.call(fs,dir,...args);if(dir===f.directory){fs.unlinkSync(target);fs.symlinkSync(outside,target);}return entries;};
    pending=f.run();
  } finally {fs.readdirSync=original;}
  await assert.rejects(pending,e=>e.code==='UNSAFE_MIGRATION_FILE'&&e.cause.code==='ELOOP');
  await absent(f,'public.pg21_outside');await absent(f,'securisite_meta.schema_migrations');
});
test('PG21 FD: pathname replaced by external symlink after open cannot replace descriptor bytes',async t=>{
  const f=await fixture(t,{'001_probe.sql':one});const target=path.join(f.directory,'001_probe.sql');
  const outside=externalSQL(t,'CREATE TABLE public.pg21_outside(id integer);');const open=fs.openSync,close=fs.closeSync;let descriptor,pending,closed=false;
  try{
    fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(file===target){descriptor=fd;fs.renameSync(target,path.join(f.directory,'original-held.sql'));fs.symlinkSync(outside,target);}return fd;};
    fs.closeSync=function(fd){const result=close.call(fs,fd);if(fd===descriptor){closed=true;assert.throws(()=>fs.fstatSync(fd),e=>e.code==='EBADF');}return result;};
    pending=f.run();
  }finally{fs.openSync=open;fs.closeSync=close;}
  assert.equal(closed,true);
  await pending;assert.equal((await f.rows())[0].checksum,createHash('sha256').update(one).digest('hex'));
  assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.pg21_probe')).rows[0].n,1);await absent(f,'public.pg21_outside');
});
test('PG21 FD: inode replacement after catalogue preserves snapshot and checksum',async t=>{
  const f=await fixture(t,{'001_probe.sql':one});await f.admin.query('SELECT pg_advisory_lock($1,$2)',LOCK_KEY);
  const pending=f.run();const replacement=path.join(f.directory,'replacement.sql');fs.writeFileSync(replacement,'CREATE TABLE public.pg21_wrong(id integer);');
  fs.renameSync(replacement,path.join(f.directory,'001_probe.sql'));await f.admin.query('SELECT pg_advisory_unlock($1,$2)',LOCK_KEY);await pending;
  assert.equal((await f.rows())[0].checksum,createHash('sha256').update(one).digest('hex'));await absent(f,'public.pg21_wrong');
});
test('PG21 FD: external symlink chain refused',async t=>{
  const f=await fixture(t);const outside=externalSQL(t,'CREATE TABLE public.pg21_outside(id integer);');
  const middle=path.join(path.dirname(outside),'middle.sql');fs.symlinkSync(outside,middle);fs.symlinkSync(middle,path.join(f.directory,'001_probe.sql'));
  await assert.rejects(f.run(),e=>e.code==='INVALID_CATALOG');await absent(f,'public.pg21_outside');
});
test('PG21 FD: regular file replaced by directory refused by fstat and descriptor closed',async t=>{
  const f=await fixture(t,{'001_probe.sql':one});const target=path.join(f.directory,'001_probe.sql');const readdir=fs.readdirSync,open=fs.openSync;let descriptor,pending;
  try{
    fs.readdirSync=function(dir,...args){const entries=readdir.call(fs,dir,...args);if(dir===f.directory){fs.unlinkSync(target);fs.mkdirSync(target);}return entries;};
    fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(file===target)descriptor=fd;return fd;};
    pending=f.run();
  }finally{fs.readdirSync=readdir;fs.openSync=open;}
  await assert.rejects(pending,e=>e.code==='INVALID_CATALOG');assert.throws(()=>fs.fstatSync(descriptor),e=>e.code==='EBADF');
});
test('PG21 FD: read error still closes descriptor',async t=>{
  const f=await fixture(t,{'001_probe.sql':one});const target=path.join(f.directory,'001_probe.sql');const open=fs.openSync,read=fs.readFileSync;let descriptor,pending;
  try{
    fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(file===target)descriptor=fd;return fd;};
    fs.readFileSync=function(file,...args){if(typeof file==='number'&&file===descriptor)throw Object.assign(Error('read failed'),{code:'EIO'});return read.call(fs,file,...args);};
    pending=f.run();
  }finally{fs.openSync=open;fs.readFileSync=read;}
  await assert.rejects(pending,e=>e.code==='EIO');assert.throws(()=>fs.fstatSync(descriptor),e=>e.code==='EBADF');await absent(f,'securisite_meta.schema_migrations');
});
test('PG21 FD: platform without O_NOFOLLOW fails explicitly before filesystem access',()=>{
  const {spawnSync}=require('node:child_process');
  const script=`const Module=require('node:module'),fs=require('node:fs'),assert=require('node:assert/strict');const load=Module._load;Module._load=function(name,...args){if(name==='node:fs')return {...fs,constants:{...fs.constants,O_NOFOLLOW:undefined}};return load.call(this,name,...args)};const {discover}=require('./backend/db/postgresql/migrate');assert.throws(()=>discover('/not-accessed'),e=>e.code==='UNSUPPORTED_PLATFORM');`;
  const r=spawnSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});

test('PG21 deadline: rapid FALSE responses time out near 20ms without bootstrap',async t=>{
  const f=await fixture(t);await f.admin.query('SELECT pg_advisory_lock($1,$2)',LOCK_KEY);const {performance}=require('node:perf_hooks');const start=performance.now();
  await assert.rejects(f.run({lockTimeoutMs:20,retryDelayMs:2}),e=>e.code==='LOCK_TIMEOUT');const elapsed=performance.now()-start;
  assert.ok(elapsed>=20&&elapsed<500,`elapsed ${elapsed}ms`);await absent(f,'securisite_meta.schema_migrations');
  await f.admin.query('SELECT pg_advisory_unlock($1,$2)',LOCK_KEY);await unlocked(f);
});
test('PG21 deadline: real TRUE response held past 20ms is explicitly unlocked on same session',async t=>{
  const f=await fixture(t,{'001_probe.sql':one});let pid,unlockPid,confirmed=false;
  class LateClient extends Client{
    async query(sql,...args){const text=typeof sql==='string'?sql:sql.text;const result=await super.query(sql,...args);
      if(text.startsWith('SELECT pg_try_advisory_lock')){assert.equal(result.rows[0].locked,true);pid=this.processID;await sleep(60);}
      if(text.startsWith('SELECT pg_advisory_unlock')){unlockPid=this.processID;confirmed=result.rows[0].unlocked;}
      return result;
    }
  }
  await assert.rejects(f.run({ClientClass:LateClient,lockTimeoutMs:20}),e=>e.code==='LOCK_TIMEOUT');assert.equal(confirmed,true);assert.equal(unlockPid,pid);
  await absent(f,'securisite_meta.schema_migrations');await absent(f,'public.pg21_probe');await unlocked(f);
  assert.deepEqual((await f.run()).applied,[1]);
});
for(const late of [false,true]){
  test('PG21 deadline: FALSE then TRUE '+(late?'after':'before')+' deadline',async t=>{
    const f=await fixture(t,{'001_probe.sql':one});await f.admin.query('SELECT pg_advisory_lock($1,$2)',LOCK_KEY);
    const {performance}=require('node:perf_hooks');let attempts=0,start;
    class BoundaryClient extends Client{
      async query(sql,...args){const text=typeof sql==='string'?sql:sql.text;
        if(text.startsWith('SELECT pg_try_advisory_lock')){attempts++;start??=performance.now();const result=await super.query(sql,...args);
          if(attempts===1){assert.equal(result.rows[0].locked,false);await f.admin.query('SELECT pg_advisory_unlock($1,$2)',LOCK_KEY);}
          else{assert.equal(result.rows[0].locked,true);await sleep(Math.max(0,start+(late?220:150)-performance.now()));}
          return result;
        }
        return super.query(sql,...args);
      }
    }
    if(late){await assert.rejects(f.run({ClientClass:BoundaryClient,lockTimeoutMs:200}),e=>e.code==='LOCK_TIMEOUT');await absent(f,'securisite_meta.schema_migrations');await absent(f,'public.pg21_probe');}
    else assert.deepEqual((await f.run({ClientClass:BoundaryClient,lockTimeoutMs:200})).applied,[1]);
    assert.equal(attempts,2);await unlocked(f);
  });
}
for(const mode of ['error','false']){
  test('PG21 deadline: late unlock '+mode+' preserves timeout and closes session',async t=>{
    const f=await fixture(t);let attempted=false;
    class UnlockClient extends Client{
      async query(sql,...args){const text=typeof sql==='string'?sql:sql.text;
        if(text.startsWith('SELECT pg_advisory_unlock')){attempted=true;if(mode==='error')return super.query('SELECT 1/0');const result=await super.query(sql,...args);result.rows[0].unlocked=false;return result;}
        const result=await super.query(sql,...args);if(text.startsWith('SELECT pg_try_advisory_lock'))await sleep(60);return result;
      }
    }
    await assert.rejects(f.run({ClientClass:UnlockClient,lockTimeoutMs:20}),e=>e.code==='LOCK_TIMEOUT'&&e.unlockError?.code===(mode==='error'?'22012':'LOCK_LOST'));
    assert.equal(attempted,true);await unlocked(f);await absent(f,'securisite_meta.schema_migrations');
  });
}
test('PG21 deadline: actual pending query is bounded by remaining read timeout',async t=>{
  const f=await fixture(t);const {performance}=require('node:perf_hooks');let budget;
  class SlowReadClient extends Client{
    async query(sql,...args){const text=typeof sql==='string'?sql:sql.text;
      if(text.startsWith('SELECT pg_try_advisory_lock')){budget=sql.query_timeout;return super.query({...sql,text:'SELECT pg_sleep(0.4)',values:[]});}
      return super.query(sql,...args);
    }
  }
  const start=performance.now();await assert.rejects(f.run({ClientClass:SlowReadClient,lockTimeoutMs:30}),e=>e.code==='LOCK_TIMEOUT'&&e.cause.message==='Query read timeout');
  const elapsed=performance.now()-start;assert.ok(budget>0&&budget<=30);assert.ok(elapsed<300,`elapsed ${elapsed}ms`);await absent(f,'securisite_meta.schema_migrations');await unlocked(f);
});
test('PG21: THREE NODE PROCESSES apply once; two wait and return no-op',async t=>{
  const f=await fixture(t,{'001_probe.sql':one+' SELECT pg_sleep(0.4);','002_extend.sql':two+' SELECT pg_sleep(0.4);'});
  const a=childRunner(f);await waitForQuery(f,'pg_sleep');const b=childRunner(f),c=childRunner(f);
  const results=await Promise.all([a.done,b.done,c.done]);for(const r of results)assert.equal(r.code,0,r.stderr);
  assert.deepEqual(results.map(r=>JSON.parse(r.stdout).applied),[[1,2],[],[]]);
  assert.deepEqual((await f.rows()).map(r=>r.version),[1,2]);assert.equal((await f.admin.query('SELECT count(*)::int n FROM public.pg21_probe')).rows[0].n,1);await unlocked(f);
});
