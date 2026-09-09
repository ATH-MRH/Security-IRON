const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {createDatabase}=require('../backend/database');
const {testEnvironment}=require('./helpers/postgres-test-config');
const env=testEnvironment(); // Fail before connecting if no safe, explicit test target.
let db;
before(async()=>{
  db=createDatabase({...env,PGPOOL_MAX:'1'});
  await db.init();
  const identity=await db.get('SELECT current_database() AS name');
  assert.equal(identity.name,decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)));
});
after(async()=>{if(db)await db.close();});

test('PG real: init connection and SELECT 1',async()=>{await db.init();assert.deepEqual(await db.get('SELECT 1 AS value'),{value:1});});
test('PG real: query returns PostgreSQL result with bound parameters',async()=>{const r=await db.query('SELECT $1::int + $2::int AS value',[2,3]);assert.equal(r.command,'SELECT');assert.equal(r.rowCount,1);assert.equal(r.rows[0].value,5);});
test('PG real: get returns only first row',async()=>{assert.deepEqual(await db.get('SELECT n FROM generate_series(1,3) n ORDER BY n'),{n:1});});
test('PG real: get without rows is null',async()=>{assert.equal(await db.get('SELECT 1 WHERE false'),null);});
test('PG real: all returns rows or empty array',async()=>{assert.deepEqual(await db.all('SELECT n FROM generate_series(1,3) n ORDER BY n'),[{n:1},{n:2},{n:3}]);assert.deepEqual(await db.all('SELECT 1 WHERE false'),[]);});
test('PG real: commit persists temporary test data and returns callback value',async()=>{
  const result=await db.transaction(async c=>{await c.query('CREATE TEMP TABLE pg1_commit_probe(value integer)');await c.query('INSERT INTO pg1_commit_probe VALUES($1)',[7]);return 'committed';});
  assert.equal(result,'committed');assert.deepEqual(await db.get('SELECT value FROM pg1_commit_probe'),{value:7});await db.query('DROP TABLE pg1_commit_probe');
});
test('PG real: rollback removes temporary DDL and data on callback error',async()=>{
  const error=new Error('controlled');await assert.rejects(db.transaction(async c=>{await c.query('CREATE TEMP TABLE pg1_rollback_probe(value integer)');await c.query('INSERT INTO pg1_rollback_probe VALUES(9)');throw error;}),e=>e===error);
  assert.equal((await db.get("SELECT to_regclass('pg_temp.pg1_rollback_probe')::text AS name")).name,null);
});
test('PG real: transaction helpers use one backend across await',async()=>{
  await db.transaction(async c=>{const first=await c.get('SELECT pg_backend_pid() AS pid');await new Promise(resolve=>setTimeout(resolve,5));const rows=await c.all('SELECT pg_backend_pid() AS pid');assert.equal(rows[0].pid,first.pid);assert.equal(await c.get('SELECT 1 WHERE false'),null);assert.deepEqual(await c.all('SELECT 1 WHERE false'),[]);});
});
test('PG real: release after successful transaction',async()=>{await db.transaction(c=>c.get('SELECT 1'));assert.deepEqual(db.stats(),{total:1,idle:1,waiting:0});});
test('PG real: release after SQL error and next query remains usable',async()=>{await assert.rejects(db.transaction(c=>c.query('SELECT 1/0')),e=>e.code==='22012');assert.deepEqual(db.stats(),{total:1,idle:1,waiting:0});assert.equal((await db.get('SELECT 2 AS n')).n,2);});
test('PG real: concurrent simple queries return their own parameters',async()=>{const results=await Promise.all(Array.from({length:12},(_,n)=>db.get('SELECT $1::integer AS n',[n])));assert.deepEqual(results.map(r=>r.n),Array.from({length:12},(_,n)=>n));});
test('PG real: SQL errors retain driver code',async()=>{await assert.rejects(db.query('SELEC invalid'),e=>e.code==='42601');});
test('PG real: repeated failures and successes do not leak connections',async()=>{
  for(let i=0;i<12;i++){await db.transaction(c=>c.get('SELECT 1'));await assert.rejects(db.transaction(c=>c.query('SELECT 1/0')));}
  assert.deepEqual(db.stats(),{total:1,idle:1,waiting:0});
});
test('PG real: nested transactions, pool escape and close inside transaction refused',async()=>{
  await db.transaction(async c=>{await assert.rejects(db.transaction(async()=>0),/imbriquées/);await assert.rejects(db.query('SELECT 1'),/client transactionnel/);await assert.rejects(db.close(),/interdite/);assert.equal((await c.get('SELECT 3 AS n')).n,3);});
});
test('PG real: escaped transaction client cannot run after release',async()=>{let escaped;await db.transaction(async c=>{escaped=c;});await assert.rejects(escaped.query('SELECT 1'),/durée de vie/);});
test('PG real: swallowed SQL error cannot report a successful commit',async()=>{await assert.rejects(db.transaction(async c=>{try{await c.query('SELECT 1/0');}catch{}return 'false success';}),/annulée après erreur SQL/);});
test('PG real: independent concurrent transactions are isolated',async()=>{
  const other=createDatabase({...env,PGPOOL_MAX:'2'});try{const results=await Promise.all([1,2].map(n=>other.transaction(async c=>{await c.query('SELECT pg_sleep(0.02)');return (await c.get('SELECT $1::integer AS n',[n])).n;})));assert.deepEqual(results,[1,2]);assert.equal(other.stats().waiting,0);}finally{await other.close();}
});
test('PG real: server statement timeout cancels query, rolls back and releases',async()=>{
  const timed=createDatabase({...env,PGSTATEMENT_TIMEOUT_MS:'30'});try{await assert.rejects(timed.transaction(c=>c.query('SELECT pg_sleep(1)')),e=>e.code==='57014');assert.equal(timed.stats().idle,1);assert.equal((await timed.get('SELECT 1 AS n')).n,1);}finally{await timed.close();}
});
test('PG real: close drains a separate pool and refuses new work',async()=>{const other=createDatabase(env);await other.init();await other.close();await other.close();await assert.rejects(other.query('SELECT 1'),/fermé/);});

for(const callbackFails of [false,true]) {
  test('PG real: idle client error during JS wait, callback failure='+callbackFails,async()=>{
    const primary=new Error('callback failure');let oldPid;
    await assert.rejects(db.transaction(async c=>{
      oldPid=(await c.get('SELECT pg_backend_pid() AS pid')).pid;
      await c.query('SET LOCAL idle_in_transaction_session_timeout=40');
      await new Promise(resolve=>setTimeout(resolve,200));
      if(callbackFails)throw primary;
      return 'must not commit';
    }),error=>{
      if(callbackFails){assert.equal(error,primary);assert.equal(error.clientError.code,'25P03');}
      else assert.equal(error.code,'25P03');
      return true;
    });
    assert.equal(db.stats().total,0);
    await db.transaction(async c=>{assert.notEqual((await c.get('SELECT pg_backend_pid() AS pid')).pid,oldPid);assert.equal((await c.get('SELECT 1 AS n')).n,1);});
    assert.deepEqual(db.stats(),{total:1,idle:1,waiting:0});
  });
}
