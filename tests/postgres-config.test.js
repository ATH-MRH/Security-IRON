const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {configuration,createDatabase}=require('../backend/database');
const {testEnvironment}=require('./helpers/postgres-test-config');
const env=()=>({NODE_ENV:'test',PGHOST:'127.0.0.1',PGDATABASE:'securisite_test_unit',PGUSER:'unit',PGPASSWORD:randomUUID()});

test('PG config: no implicit database or OS identity fallback',()=>{
  assert.throws(()=>configuration({}),/Configuration PostgreSQL requise/);
  assert.throws(()=>configuration({PGHOST:'localhost'}),/Configuration PostgreSQL requise/);
});
test('PG config: explicit fields, pool bounds and timeouts',()=>{
  const config=configuration({...env(),PGPORT:'55432',PGPOOL_MAX:'3'});
  assert.equal(config.port,55432);assert.equal(config.max,3);assert.equal(config.connectionTimeoutMillis,5000);
  assert.equal(config.idleTimeoutMillis,30000);assert.equal(config.statement_timeout,15000);
  assert.equal(config.idle_in_transaction_session_timeout,60000);
  for(const name of ['PGPORT','PGPOOL_MAX','PGCONNECT_TIMEOUT_MS','PGIDLE_TIMEOUT_MS','PGSTATEMENT_TIMEOUT_MS','PGTRANSACTION_IDLE_TIMEOUT_MS'])assert.throws(()=>configuration({...env(),[name]:'-1'}),/invalide/);
});
test('PG config: verified TLS default in every mode',()=>{
  for(const NODE_ENV of ['production','development','test']) assert.equal(configuration({...env(),NODE_ENV}).ssl.rejectUnauthorized,true);
  assert.equal(configuration({...env(),PGSSL:'verify-full'}).ssl.rejectUnauthorized,true);
  assert.equal(configuration({...env(),PGSSL:'disable'}).ssl,false);
  assert.throws(()=>configuration({...env(),PGSSL:'no-verify'}),/PGSSL/);
  assert.throws(()=>configuration({...env(),NODE_ENV:'production',PGPASSWORD:''}),/Authentification/);
});
test('PG config: URL decoded, never handed to pg SSL parser, rejects query overrides without leaking secrets',()=>{
  const secret=randomUUID();const url=`postgresql://unit:${secret}@127.0.0.1:55432/securisite_test`;
  const config=configuration({DATABASE_URL:url});assert.equal(config.password,secret);assert.equal(config.database,'securisite_test');assert.equal(config.connectionString,undefined);
  for(const suffix of ['?sslmode=no-verify','?host=elsewhere','#fragment']){
    assert.throws(()=>configuration({DATABASE_URL:url+suffix}),error=>!error.message.includes(secret)&&!error.message.includes(url));
  }
  assert.throws(()=>configuration({DATABASE_URL:'malformed'}),/DATABASE_URL invalide/);
});
test('PG config: certificate errors sanitized',()=>{
  assert.throws(()=>configuration({...env(),PGSSL:'verify-full',PGSSLROOTCERT:'/nonexistent/pg1-ca.pem'}),/Certificat PostgreSQL/);
});
test('PG safeguards: explicit test URL only; remote, production and ambiguous names refused',()=>{
  assert.throws(()=>testEnvironment({DATABASE_URL:'postgresql://user@127.0.0.1/securisite_test'}),/SECURISITE_TEST_DATABASE_URL requis/);
  for(const url of ['postgresql://user@remote.example/securisite_test','postgresql://user@127.0.0.1/securisite','postgresql://user@localhost/securisite_test_prod','postgresql://user@localhost/securisite_test?host=remote'])assert.throws(()=>testEnvironment({SECURISITE_TEST_DATABASE_URL:url}),/refusés/);
  assert.equal(testEnvironment({SECURISITE_TEST_DATABASE_URL:'postgresql://user@127.0.0.1/securisite_test_pg1'}).NODE_ENV,'test');
});
// Fault injection complements the real PostgreSQL tests; it does not replace them.
function harness(failures={}){
  const calls=[],releases=[];let closed=0;
  const connection=Object.assign(new EventEmitter(),{query:async(sql)=>{calls.push(sql);if(failures[sql])throw failures[sql];return {rows:[],command:sql};},release:destroy=>releases.push(destroy)});
  class FakePool {on(){}async connect(){if(failures.connect)throw failures.connect;return connection;}async query(){throw Error('pool.query forbidden in transaction');}async end(){closed++;}}
  return {db:createDatabase(env(),{PoolClass:FakePool}),calls,releases,get closed(){return closed;}};
}
test('PG fault: rollback error preserves original identity and destroys connection',async()=>{
  const primary=new Error('primary'),rollback=new Error('rollback'),h=harness({ROLLBACK:rollback});
  await assert.rejects(h.db.transaction(async()=>{throw primary;}),error=>error===primary&&error.rollbackError===rollback);
  assert.deepEqual(h.calls,['BEGIN','ROLLBACK']);assert.deepEqual(h.releases,[true]);await h.db.close();
});
test('PG fault: frozen original error still wins over rollback failure',async()=>{
  const primary=Object.freeze(new Error('primary')),h=harness({ROLLBACK:new Error('rollback')});
  await assert.rejects(h.db.transaction(async()=>{throw primary;}),error=>error.cause===primary&&error.rollbackError.message==='rollback');assert.deepEqual(h.releases,[true]);await h.db.close();
});
test('PG fault: nonconfigurable rollbackError does not replace primary failure',async()=>{
  const primary=new Error('primary');Object.defineProperty(primary,'rollbackError',{value:'existing'});const h=harness({ROLLBACK:new Error('rollback')});
  await assert.rejects(h.db.transaction(async()=>{throw primary;}),error=>error.cause===primary&&error.rollbackError.message==='rollback');await h.db.close();
});
test('PG fault: BEGIN failure releases unusable connection without callback',async()=>{
  const failure=new Error('begin'),h=harness({BEGIN:failure});let entered=false;
  await assert.rejects(h.db.transaction(async()=>{entered=true;}),error=>error===failure);
  assert.equal(entered,false);assert.deepEqual(h.calls,['BEGIN']);assert.deepEqual(h.releases,[true]);await h.db.close();
});
test('PG fault: COMMIT failure rolls back and preserves initial error',async()=>{
  const failure=new Error('commit'),h=harness({COMMIT:failure});await assert.rejects(h.db.transaction(async()=>42),error=>error===failure);
  assert.deepEqual(h.calls,['BEGIN','COMMIT','ROLLBACK']);assert.deepEqual(h.releases,[false]);await h.db.close();
});
test('PG fault: acquisition failure has no client to release',async()=>{
  const h=harness({connect:new Error('connect')});await assert.rejects(h.db.transaction(async()=>0),/connect/);assert.deepEqual(h.releases,[]);await h.db.close();
});
test('PG fault: release once after success and close is idempotent',async()=>{
  const h=harness();assert.equal(await h.db.transaction(async client=>{await client.query('SELECT 1');return 42;}),42);
  assert.deepEqual(h.calls,['BEGIN','SELECT 1','COMMIT']);assert.deepEqual(h.releases,[false]);await h.db.close();await h.db.close();assert.equal(h.closed,1);
});

for (const phase of ['query','js-wait','before-commit','commit','rollback','rollback-failure','callback-error']) {
  test('PG client event: '+phase,async()=>{
    const clientError=Object.assign(new Error('connection lost'),{code:'25P03'});
    const primary=new Error('callback or SQL error'), rollback=new Error('rollback failed');
    const calls=[],releases=[];let connection;
    class TestPool {
      on(){} async end(){}
      async connect(){
        connection=Object.assign(new EventEmitter(),{
          async query(sql){
            calls.push(sql);
            if(sql==='SELECT 1'&&phase==='query'){await Promise.resolve();this.emit('error',clientError);throw primary;}
            if(sql==='COMMIT'&&phase==='commit'){await Promise.resolve();this.emit('error',clientError);}
            if(sql==='ROLLBACK'&&phase.startsWith('rollback')){await Promise.resolve();this.emit('error',clientError);if(phase==='rollback-failure')throw rollback;}
            return {command:sql,rows:[]};
          },
          release(destroy){assert.equal(this.listenerCount('error'),0);releases.push(destroy);}
        });return connection;
      }
    }
    const db=createDatabase(env(),{PoolClass:TestPool});
    try {
      await assert.rejects(db.transaction(async c=>{
        if(phase==='query')await c.query('SELECT 1');
        if(phase==='js-wait')await new Promise(resolve=>setImmediate(()=>{connection.emit('error',clientError);resolve();}));
        if(phase==='before-commit'||phase==='callback-error')connection.emit('error',clientError);
        if(phase.startsWith('rollback')||phase==='callback-error')throw primary;
        return 'must not succeed';
      }),error=>{
        if(['query','rollback','rollback-failure','callback-error'].includes(phase)){
          assert.equal(error,primary);assert.equal(error.clientError,clientError);
          if(phase==='rollback-failure')assert.equal(error.rollbackError,rollback);
        } else assert.equal(error,clientError);
        return true;
      });
      assert.deepEqual(releases,[true]);
      assert.equal(calls.includes('COMMIT'),phase==='commit');
      assert.equal(calls.at(-1),'ROLLBACK');
    } finally {await db.close();}
  });
}

for(const kind of ['singleton','factory']) for(const state of ['unused','initialized','failed']) {
  test(`PG close: ${kind} permanently closed after ${state}`,()=>{
    // A fresh process avoids reloading or resetting the production singleton.
    const script=`
      const assert=require('node:assert/strict');const pg=require('pg');let pools=0,ends=0;
      pg.Pool=class {constructor(){pools++;}on(){}async query(){if(${JSON.stringify(state)}==='failed')throw Error('offline');return {rows:[{ok:1}]};}async end(){ends++;}};
      const moduleDB=require('./backend/database');
      const db=${JSON.stringify(kind)}==='singleton'?moduleDB:moduleDB.createDatabase();
      (async()=>{
        if(${JSON.stringify(state)}==='initialized')await db.init();
        if(${JSON.stringify(state)}==='failed')await assert.rejects(db.init());
        await db.close();await db.close();
        for(const name of ['query','get','all'])await assert.rejects(db[name]('SELECT 1'));
        await assert.rejects(db.init());await assert.rejects(db.transaction(async()=>0));
        assert.equal(pools,${kind==='singleton'&&state==='unused'?0:1});assert.equal(ends,pools);
      })().catch(e=>{console.error(e);process.exitCode=1});`;
    const result=spawnSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,DATABASE_URL:'postgresql://unit@localhost/securisite_test_unit',NODE_ENV:'test'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  });
}
