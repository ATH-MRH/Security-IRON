'use strict';
// PG-9 — PostgreSQL Row Level Security (migration 005) as a SECOND, independent
// defense on top of PG-8's application-layer enforcement. Granularity: tenant
// only (see migration 005's own comment) on the 5 tables that actually carry
// a tenant_id today (tenants/sites/zones/memberships/membership_audit) —
// historical tables still have none (PG-8 boundary, unchanged by PG-9).
// Critical property under test: the actor context (securisite.actor_user_id)
// is transaction-scoped (SET LOCAL) and must never survive a COMMIT/ROLLBACK
// nor leak across a pooled connection to a different user's transaction.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, RLS_FUNCTION, RLS_POLICIES } = require('../backend/db/postgresql/readiness');
const { withActorContext } = require('../backend/scope');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_rls_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };
const tag = () => randomBytes(5).toString('hex');
const rejects = (p, code) => assert.rejects(p, e => { assert.equal(e.code, code, e.message); return true; });

let root, pool;
const ids = {};
// PG-29 (revue adversariale, hygiène des tests) : chaque rôle restreint créé
// ci-dessous obtient ses GRANT DANS la base jetable (`pool`, connecté à
// `dbName`) — mais `root` (utilisé par les DROP OWNED/DROP ROLE de t.after,
// plus bas) reste connecté à la base de BASE (securisite_test), jamais à
// `dbName`. DROP OWNED BY ne porte que sur la base courante de la connexion :
// exécuté depuis `root`, il ne trouve donc rien de la base jetable, et le
// DROP ROLE qui suit échoue silencieusement (rôle encore titulaire de GRANT
// dans `dbName`, avalé par .catch). Le rôle survit alors indéfiniment,
// orphelin, une fois `dbName` détruit par le after() global — constaté
// empiriquement : des centaines de rôles `sec_test_rls_*` accumulés au fil
// des exécutions répétées de la suite. Corrigé : chaque rôle créé est
// consigné ici, et le after() global les DROP ROLE APRÈS avoir détruit
// `dbName` (la base disparue, le rôle ne porte plus aucun GRANT nulle part).
const createdRoles = [];

async function createUser(role = 'agent') {
  const username = 'rls_' + tag();
  return (await pool.get('INSERT INTO public.users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id',
    [username, 'fixture', role])).id;
}
async function grant(userId, tenantId, role = 'agent', alertAccess = 'own', status = 'active') {
  await pool.query('INSERT INTO public.memberships(user_id,tenant_id,role,alert_access,status) VALUES($1,$2,$3,$4,$5)',
    [userId, tenantId, role, alertAccess, status]);
}

// A low-privilege role — never the test superuser, which bypasses RLS entirely.
async function restrictedRole() {
  const role = 'sec_test_rls_' + tag();
  createdRoles.push(role);
  await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'x'`);
  await pool.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await pool.query(`GRANT USAGE ON SCHEMA securisite_meta TO "${role}"`);
  await pool.query(`GRANT EXECUTE ON FUNCTION securisite_meta.${RLS_FUNCTION}() TO "${role}"`);
  for (const t of ['tenants', 'sites', 'zones', 'memberships']) await pool.query(`GRANT SELECT ON public.${t} TO "${role}"`);
  return role;
}
function clientAs(role) {
  const u = new URL(env.DATABASE_URL); u.username = role; u.password = 'x';
  return new Client({ connectionString: u.href });
}
// db.createDatabase(env) as-is would connect with the test superuser, which
// BYPASSES RLS entirely — every pool-reuse test below needs a real restricted
// role's own pool to exercise RLS at all.
function poolAs(role, overrides = {}) {
  const u = new URL(env.DATABASE_URL); u.username = role; u.password = 'x';
  return db.createDatabase({ ...env, DATABASE_URL: u.href, ...overrides });
}
async function setActor(client, userId) {
  await client.query("SELECT set_config('securisite.actor_user_id',$1,false)", [userId == null ? '' : String(userId)]);
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);

  ids.tenantA = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('rlsa','RLS Tenant A') RETURNING id")).id;
  ids.tenantB = (await pool.get("INSERT INTO public.tenants(code,name) VALUES('rlsb','RLS Tenant B') RETURNING id")).id;
  ids.siteA = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'sa','Site A') RETURNING id", [ids.tenantA])).id;
  ids.siteB = (await pool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'sb','Site B') RETURNING id", [ids.tenantB])).id;
});
after(async () => {
  try { await pool.close(); }
  finally {
    if (root) {
      await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)');
      // PG-29 : les DROP ROLE tentés plus haut (t.after, pendant que dbName
      // existait encore) ont échoué silencieusement — voir le commentaire sur
      // createdRoles. Maintenant que dbName est détruite, le rôle n'a plus
      // aucun GRANT nulle part : DROP ROLE réussit réellement.
      for (const role of createdRoles) await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
      await root.end();
    }
  }
});

/* ============================================================ */
/*  Readiness — fail-closed startup                              */
/* ============================================================ */

test('readiness requires RLS enabled with its policies and helper function on all 5 tables', async () => {
  assert.equal(await assertReady(pool, { directory }), undefined);
  // PG-10 adds security_audit (its own, stricter RLS function — see postgres-security-audit.test.js).
  assert.deepEqual(Object.keys(RLS_POLICIES).sort(), ['membership_audit', 'memberships', 'security_audit', 'sites', 'tenants', 'zones']);
});

test('readiness fails if RLS is disabled on one table', async t => {
  await pool.query('ALTER TABLE public.sites DISABLE ROW LEVEL SECURITY');
  t.after(() => pool.query('ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY'));
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_RLS_MISSING' && /sites/.test(e.message));
});

test('readiness fails if a policy is dropped', async t => {
  await pool.query('DROP POLICY zones_actor_tenant ON public.zones');
  t.after(() => pool.query(`
    CREATE POLICY zones_actor_tenant ON public.zones
      FOR ALL USING (tenant_id IN (SELECT securisite_meta.${RLS_FUNCTION}()))
      WITH CHECK (tenant_id IN (SELECT securisite_meta.${RLS_FUNCTION}()))`));
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_RLS_MISSING' && /zones_actor_tenant/.test(e.message));
});

test('readiness fails if the actor-resolution function is dropped', async t => {
  // Drop dependent policies first (their USING/CHECK reference the function).
  const column = table => (table === 'tenants' ? 'id' : 'tenant_id');
  for (const [table, policies] of Object.entries(RLS_POLICIES)) for (const p of policies) await pool.query(`DROP POLICY ${p} ON public.${table}`);
  await pool.query(`DROP FUNCTION securisite_meta.${RLS_FUNCTION}()`);
  t.after(async () => {
    await pool.query(`
      CREATE FUNCTION securisite_meta.${RLS_FUNCTION}()
      RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT DISTINCT m.tenant_id FROM public.memberships m
        JOIN public.tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE m.status = 'active' AND m.user_id = NULLIF(current_setting('securisite.actor_user_id', true), '')::integer;
      $$`);
    for (const [table, policies] of Object.entries(RLS_POLICIES)) for (const p of policies) await pool.query(`
      CREATE POLICY ${p} ON public.${table}
        FOR ALL USING (${column(table)} IN (SELECT securisite_meta.${RLS_FUNCTION}()))
        WITH CHECK (${column(table)} IN (SELECT securisite_meta.${RLS_FUNCTION}()))`);
  });
  await assert.rejects(assertReady(pool, { directory }), e => e.code === 'READINESS_RLS_MISSING' && new RegExp(RLS_FUNCTION).test(e.message));
});

/* ============================================================ */
/*  Fail-closed default and cross-tenant isolation                */
/* ============================================================ */

test('no actor context set: a restricted role sees nothing at all, even though it holds a valid table-level GRANT', async t => {
  const role = await restrictedRole();
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const c = clientAs(role); await c.connect();
  try {
    assert.equal((await c.query('SELECT count(*)::int n FROM public.tenants')).rows[0].n, 0);
    assert.equal((await c.query('SELECT count(*)::int n FROM public.sites')).rows[0].n, 0);
  } finally { await c.end(); }
});

test('an actor sees only their own tenant, never the other, even querying directly as the restricted role', async t => {
  const userA = await createUser(); await grant(userA, ids.tenantA, 'soc', 'scope');
  const role = await restrictedRole();
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const c = clientAs(role); await c.connect();
  try {
    await setActor(c, userA);
    const tenants = (await c.query('SELECT id FROM public.tenants ORDER BY id')).rows.map(r => r.id);
    assert.deepEqual(tenants.sort(), [ids.tenantA].sort());
    assert.ok(!tenants.includes(ids.tenantB), 'tenant B never visible to a tenant-A-only actor');
    const sites = (await c.query('SELECT id FROM public.sites')).rows.map(r => r.id);
    assert.deepEqual(sites, [ids.siteA]);
  } finally { await c.end(); }
});

test('suspended and archived memberships give RLS no visibility either, mirroring the application layer', async t => {
  for (const status of ['suspended', 'archived']) {
    const u = await createUser(); await grant(u, ids.tenantA, 'soc', 'scope', status);
    const role = await restrictedRole();
    const c = clientAs(role); await c.connect();
    try {
      await setActor(c, u);
      assert.equal((await c.query('SELECT count(*)::int n FROM public.tenants')).rows[0].n, 0, status);
    } finally { await c.end(); await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); }
  }
});

/* ============================================================ */
/*  Pool reuse: the transaction-scoped context must never survive */
/*  past COMMIT, and must never bleed into a different actor's    */
/*  transaction reusing the same physical connection.             */
/* ============================================================ */

test('SET LOCAL context does not survive past the transaction that set it, on the very same connection', async t => {
  const userA = await createUser(); await grant(userA, ids.tenantA, 'soc', 'scope');
  const role = await restrictedRole();
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const single = poolAs(role, { PGPOOL_MAX: '1' }); // force literal connection reuse
  try {
    const withinTx = await withActorContext(userA, async client => (await client.get('SELECT count(*)::int n FROM public.tenants')).n, single);
    assert.equal(withinTx, 1, 'tenant A visible inside the transaction that set the actor');
    // A brand-new transaction on the SAME single-connection pool, no actor set this time.
    const after = await single.transaction(async client => (await client.get('SELECT count(*)::int n FROM public.tenants')).n);
    assert.equal(after, 0, 'the next transaction on the reused connection starts with no actor context at all');
  } finally { await single.close(); }
});

test('pool reuse across two different actors never leaks one tenant into the other, sequentially on a 1-connection pool', async t => {
  const userA = await createUser(); await grant(userA, ids.tenantA, 'soc', 'scope');
  const userB = await createUser(); await grant(userB, ids.tenantB, 'soc', 'scope');
  const role = await restrictedRole();
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const single = poolAs(role, { PGPOOL_MAX: '1' });
  try {
    for (let i = 0; i < 5; i++) {
      const asA = await withActorContext(userA, c => c.all('SELECT id FROM public.tenants'), single);
      assert.deepEqual(asA.map(r => r.id), [ids.tenantA], 'pass ' + i + ' as A');
      const asB = await withActorContext(userB, c => c.all('SELECT id FROM public.tenants'), single);
      assert.deepEqual(asB.map(r => r.id), [ids.tenantB], 'pass ' + i + ' as B');
    }
  } finally { await single.close(); }
});

test('a rolled-back transaction still clears the actor context for the next one on the same connection', async t => {
  const userA = await createUser(); await grant(userA, ids.tenantA, 'soc', 'scope');
  const role = await restrictedRole();
  t.after(async () => { await root.query(`DROP OWNED BY "${role}"`).catch(() => {}); await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); });
  const single = poolAs(role, { PGPOOL_MAX: '1' });
  try {
    await assert.rejects(single.transaction(async client => {
      await client.query("SELECT set_config('securisite.actor_user_id',$1,true)", [String(userA)]);
      assert.equal((await client.get('SELECT count(*)::int n FROM public.tenants')).n, 1);
      throw Object.assign(new Error('deliberate rollback'), { code: 'TEST_ROLLBACK' });
    }), e => e.code === 'TEST_ROLLBACK');
    const after = await single.transaction(async client => (await client.get('SELECT count(*)::int n FROM public.tenants')).n);
    assert.equal(after, 0, 'rollback does not leave the actor context set for the next transaction');
  } finally { await single.close(); }
});

test('APP has no BYPASSRLS: RLS is a real second defense, not opt-in for the runtime role', async () => {
  // Documented contract (provision-roles.js): CREATE ROLE ... NOBYPASSRLS.
  const source = require('node:fs').readFileSync(
    path.resolve(__dirname, '../backend/db/postgresql/provision-roles.js'), 'utf8');
  assert.match(source, /CREATE ROLE \$\{q\(app\)\}[^;]*NOBYPASSRLS/);
});
