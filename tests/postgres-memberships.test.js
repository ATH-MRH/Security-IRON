'use strict';
// PG-7 — memberships + membership_audit (migration 004), natif PostgreSQL.
// Schéma + contraintes + backfill + provisioning. AUCUNE activation de visibilité.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, MEMBERSHIP, PRIVILEGES } = require('../backend/db/postgresql/readiness');
const { provisionLocalMembership } = require('../backend/db/postgresql/provision-membership');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const LOCAL_TENANT = '507486ba-d55e-5142-9ac2-196da97866df';
const MAIN_SITE = 'fa831124-0323-581e-993c-1f4332a36282';
const tag = () => randomBytes(5).toString('hex');
const rejects = (p, code) => assert.rejects(p, e => { assert.equal(e.code, code, e.message); return true; });

let root;
before(async () => { root = new Client(db.configuration(baseEnv)); await root.connect(); });
after(async () => { if (root) await root.end(); });

async function member(t, { users = [['admin'], ['agent']] } = {}) {
  const n = 'securisite_test_member_' + tag();
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(() => root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'));
  const env = { ...baseEnv, DATABASE_URL: (u => (u.pathname = '/' + n, u.href))(new URL(baseEnv.DATABASE_URL)) };
  await migrate({ directory: migrationsDir, migrationEnv: env });
  const c = new Client({ connectionString: env.DATABASE_URL }); await c.connect();
  let i = 0;
  for (const [role, name] of users.map(u => [u[0], u[1] || u[0] + '-' + (++i)])) {
    await c.query("INSERT INTO public.users (username, password_hash, role) VALUES ($1, 'h', $2)", [name, role]);
  }
  await c.end();
  return { n, env };
}
const withClient = async (env, fn) => {
  const c = new Client({ connectionString: env.DATABASE_URL }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

test('004 creates memberships and membership_audit with a generated scope column', async t => {
  const { env } = await member(t, { users: [] });
  await withClient(env, async c => {
    const m = (await c.query("SELECT column_name, is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name='memberships' ORDER BY ordinal_position")).rows;
    assert.deepEqual(m.map(x => x.column_name),
      ['id', 'user_id', 'tenant_id', 'site_id', 'zone_id', 'role', 'alert_access', 'status', 'scope', 'created_at', 'updated_at']);
    assert.equal(m.find(x => x.column_name === 'scope').is_generated, 'ALWAYS');
    const a = (await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='membership_audit'")).rows;
    assert.equal(a.find(x => x.column_name === 'detail').data_type, 'jsonb');
    assert.deepEqual(MEMBERSHIP, ['memberships', 'membership_audit']);
  });
});

test('the migration backfills one tenant-level membership per admin/agent user, none for other roles', async t => {
  // The migration ran before users existed here; replay the exact backfill statement.
  const { env } = await member(t, { users: [['admin', 'a1'], ['agent', 'a2'], ['viewer', 'v1']] });
  await withClient(env, async c => {
    await c.query(`
      INSERT INTO public.memberships (user_id, tenant_id, role, alert_access)
      SELECT u.id, (SELECT id FROM public.tenants WHERE code='local'),
             CASE u.role WHEN 'admin' THEN 'soc' ELSE 'agent' END,
             CASE u.role WHEN 'admin' THEN 'scope' ELSE 'own' END
      FROM public.users u WHERE u.role IN ('admin','agent')
      ON CONFLICT (user_id, tenant_id, role) WHERE site_id IS NULL AND zone_id IS NULL DO NOTHING`);
    const rows = (await c.query(`
      SELECT u.role AS user_role, m.role, m.alert_access, m.scope, m.status
      FROM public.memberships m JOIN public.users u ON u.id = m.user_id ORDER BY u.username`)).rows;
    assert.deepEqual(rows, [
      { user_role: 'admin', role: 'soc', alert_access: 'scope', scope: 'tenant', status: 'active' },
      { user_role: 'agent', role: 'agent', alert_access: 'own', scope: 'tenant', status: 'active' },
    ]);
  });
});

test('provisionLocalMembership: idempotent, role-mapped, audited, transaction-scoped', async t => {
  const { env } = await member(t, { users: [['admin', 'boss'], ['agent', 'guard'], ['viewer', 'obs']] });
  const pool = db.createDatabase(env);
  try {
    const ids = Object.fromEntries((await pool.all('SELECT username, id FROM public.users')).map(r => [r.username, r.id]));
    const first = await pool.transaction(c => provisionLocalMembership(c, ids.boss, { actorUserId: ids.boss }));
    assert.deepEqual(first, { provisioned: true, role: 'soc', alert_access: 'scope' });
    const again = await pool.transaction(c => provisionLocalMembership(c, ids.boss, { actorUserId: ids.boss }));
    assert.equal(again.provisioned, false);                       // never widened / reactivated
    const guard = await pool.transaction(c => provisionLocalMembership(c, ids.guard));
    assert.deepEqual(guard, { provisioned: true, role: 'agent', alert_access: 'own' });
    const obs = await pool.transaction(c => provisionLocalMembership(c, ids.obs));
    assert.deepEqual(obs, { provisioned: false, reason: 'role_hors_perimetre_local' });
    await rejects(pool.transaction(c => provisionLocalMembership(c, 999999)), 'MEMBERSHIP_USER_UNKNOWN');

    assert.equal((await pool.get('SELECT count(*)::int n FROM public.memberships')).n, 2);
    const audit = (await pool.all("SELECT action, actor_user_id, detail->>'origin' AS origin, detail->'before' AS before FROM public.membership_audit ORDER BY id"));
    assert.equal(audit.length, 2);
    assert.ok(audit.every(a => a.action === 'CREATE' && a.origin === 'provisioning' && a.before === null));
    assert.equal(audit[0].actor_user_id, ids.boss);
    assert.equal(audit[1].actor_user_id, null);                   // guard provisioned with no actor
  } finally { await pool.close(); }
});

test('foreign keys keep a membership coherent with the site and zone hierarchy', async t => {
  const { env } = await member(t, { users: [['agent', 'u']] });
  await withClient(env, async c => {
    const uid = (await c.query("SELECT id FROM public.users WHERE username='u'")).rows[0].id;
    await c.query("INSERT INTO public.tenants(id,code,name) VALUES('33333333-3333-3333-3333-333333333333','t2','T2')");
    const zoneId = (await c.query("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z') RETURNING id", [MAIN_SITE, LOCAL_TENANT])).rows[0].id;
    // MISSION — TRANSFERT INTER-GROUPES DES SITES (migration 019) : la
    // contrainte composite (site_id, tenant_id) → sites(id, tenant_id) a été
    // délibérément remplacée par une contrainte simple site_id → sites(id)
    // — elle supposait implicitement que sites.tenant_id ne changerait
    // jamais, ce qui n'est plus vrai (transfert de site). site_id doit
    // toujours pointer vers un site RÉEL (invariant conservé, vérifié
    // ci-dessous) ; la cohérence (site_id, tenant_id) au moment de la
    // création est désormais de la responsabilité de l'application
    // (backend/admin-groups.js#POST /groups/:id/users la vérifie déjà
    // explicitement avant tout INSERT — jamais recalculée après coup pour
    // les lignes historiques, voir backend/admin-sites.js#POST /transfer).
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,role) VALUES($1,'33333333-3333-3333-3333-333333333333',$2,'agent')", [uid, MAIN_SITE]);
    // site_id must still point to a REAL site
    await rejects(c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,role) VALUES($1,$2,gen_random_uuid(),'agent')", [uid, LOCAL_TENANT]), '23503');
    // zone_id must still point to a REAL zone
    await rejects(c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,zone_id,role) VALUES($1,$2,$3,gen_random_uuid(),'agent')", [uid, LOCAL_TENANT, MAIN_SITE]), '23503');
    // zone without a site (still a plain CHECK constraint, unaffected by migration 019)
    await rejects(c.query("INSERT INTO public.memberships(user_id,tenant_id,zone_id,role) VALUES($1,$2,$3,'agent')", [uid, LOCAL_TENANT, zoneId]), '23514');
    // a coherent site-level then zone-level membership are accepted
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,role) VALUES($1,$2,$3,'site_manager')", [uid, LOCAL_TENANT, MAIN_SITE]);
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,zone_id,role) VALUES($1,$2,$3,$4,'agent')", [uid, LOCAL_TENANT, MAIN_SITE, zoneId]);
    assert.deepEqual((await c.query('SELECT scope FROM public.memberships ORDER BY scope')).rows.map(r => r.scope), ['site', 'site', 'zone']);
  });
});

test('one membership per (user, tenant, role) and per scope level', async t => {
  const { env } = await member(t, { users: [['agent', 'u']] });
  await withClient(env, async c => {
    const uid = (await c.query("SELECT id FROM public.users WHERE username='u'")).rows[0].id;
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,role) VALUES($1,$2,'agent')", [uid, LOCAL_TENANT]);
    await rejects(c.query("INSERT INTO public.memberships(user_id,tenant_id,role) VALUES($1,$2,'agent')", [uid, LOCAL_TENANT]), '23505');
    // site-level with the same role is a different partial index -> allowed
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,role) VALUES($1,$2,$3,'agent')", [uid, LOCAL_TENANT, MAIN_SITE]);
    await rejects(c.query("INSERT INTO public.memberships(user_id,tenant_id,site_id,role) VALUES($1,$2,$3,'agent')", [uid, LOCAL_TENANT, MAIN_SITE]), '23505');
  });
});

test('memberships are immutable in identity and never deleted; status changes touch updated_at and audit', async t => {
  const { env } = await member(t, { users: [['agent', 'u']] });
  await withClient(env, async c => {
    const uid = (await c.query("SELECT id FROM public.users WHERE username='u'")).rows[0].id;
    const mid = (await c.query("INSERT INTO public.memberships(user_id,tenant_id,role) VALUES($1,$2,'agent') RETURNING id, updated_at", [uid, LOCAL_TENANT])).rows[0];
    await rejects(c.query('DELETE FROM public.memberships WHERE id=$1', [mid.id]), '23514');
    await rejects(c.query('UPDATE public.memberships SET user_id=$1 WHERE id=$2', [uid + 100000, mid.id]), '23514');
    await rejects(c.query('UPDATE public.memberships SET tenant_id=gen_random_uuid() WHERE id=$1', [mid.id]), '23514');
    await rejects(c.query('UPDATE public.memberships SET id=gen_random_uuid() WHERE id=$1', [mid.id]), '23514');
    await rejects(c.query("UPDATE public.memberships SET created_at=now() - interval '1 day' WHERE id=$1", [mid.id]), '23514');
    await new Promise(r => setTimeout(r, 5));
    await c.query("SELECT set_config('securisite.audit_origin','test',false)");
    await c.query("UPDATE public.memberships SET status='archived', alert_access='scope' WHERE id=$1", [mid.id]);
    const after = (await c.query('SELECT status, updated_at FROM public.memberships WHERE id=$1', [mid.id])).rows[0];
    assert.equal(after.status, 'archived');
    assert.ok(new Date(after.updated_at) > new Date(mid.updated_at), 'updated_at bumped by trigger');
    const audit = (await c.query("SELECT action, detail->'before'->>'status' AS before_status FROM public.membership_audit WHERE membership_id=$1 ORDER BY id", [mid.id])).rows;
    assert.deepEqual(audit.map(a => a.action), ['CREATE', 'UPDATE']);
    assert.equal(audit[1].before_status, 'active');
  });
});

test('membership_audit is append-only', async t => {
  const { env } = await member(t, { users: [['agent', 'u']] });
  await withClient(env, async c => {
    const uid = (await c.query("SELECT id FROM public.users WHERE username='u'")).rows[0].id;
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,role) VALUES($1,$2,'agent')", [uid, LOCAL_TENANT]);
    await rejects(c.query("UPDATE public.membership_audit SET action='UPDATE'"), '23514');
    await rejects(c.query('DELETE FROM public.membership_audit'), '23514');
    await rejects(c.query('TRUNCATE public.membership_audit'), '23514');
  });
});

test('readiness requires the membership schema, its guard function and triggers', async t => {
  const { env } = await member(t, { users: [] });
  const pool = db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: env.DATABASE_URL, PGSSL: 'disable' });
  try {
    assert.equal(await assertReady(pool, { directory: migrationsDir }), undefined);
    await pool.query('DROP TRIGGER memberships_no_delete ON public.memberships');
    await assert.rejects(assertReady(pool, { directory: migrationsDir }),
      e => e.code === 'READINESS_AUDIT_GUARD_MISSING' && /memberships_no_delete/.test(e.message));
  } finally { await pool.close(); }
});

test('readiness fails if the membership guard function is dropped', async t => {
  const { env } = await member(t, { users: [] });
  const pool = db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: env.DATABASE_URL, PGSSL: 'disable' });
  try {
    await pool.query('DROP TRIGGER memberships_no_delete ON public.memberships');
    await pool.query('DROP TRIGGER memberships_identity_lock ON public.memberships');
    await pool.query('DROP FUNCTION securisite_meta.reject_membership_mutation()');
    await assert.rejects(assertReady(pool, { directory: migrationsDir }),
      e => e.code === 'READINESS_AUDIT_GUARD_MISSING' && /reject_membership_mutation/.test(e.message));
  } finally { await pool.close(); }
});

test('PG-7 activates nothing at the grant level; PG-9 row-level security requires a real actor context', async t => {
  // memberships gagne INSERT,UPDATE à la migration 018 (LOT Groupes —
  // affectation utilisateur↔groupe/site et révocation par statut ; les
  // lignes restent immuables en identité, imposé par trigger, migration 004).
  assert.equal(PRIVILEGES.memberships, 'SELECT,INSERT,UPDATE');
  assert.equal(PRIVILEGES.membership_audit, 'SELECT,INSERT');
  const { env, n } = await member(t, { users: [['agent', 'u']] });
  const role = 'sec_test_member_app_' + tag();
  let uid;
  await withClient(env, async c => {
    uid = (await c.query("SELECT id FROM public.users WHERE username='u'")).rows[0].id;
    await c.query("INSERT INTO public.memberships(user_id,tenant_id,role) VALUES($1,$2,'agent')", [uid, LOCAL_TENANT]);
    await c.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'x'`);
    await c.query(`GRANT CONNECT ON DATABASE "${n}" TO "${role}"`);
    await c.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await c.query(`GRANT USAGE ON SCHEMA securisite_meta TO "${role}"`);
    await c.query(`GRANT EXECUTE ON FUNCTION securisite_meta.current_actor_tenant_ids() TO "${role}"`);
    // Migration 017 : la politique memberships_actor_tenant évalue aussi
    // current_actor_is_global_admin() désormais — EXECUTE requis même pour
    // conclure "false" (rôle 'agent' non admin ici).
    await c.query(`GRANT EXECUTE ON FUNCTION securisite_meta.current_actor_is_global_admin() TO "${role}"`);
    await c.query(`GRANT SELECT ON public.memberships TO "${role}"`);
    await c.query(`GRANT SELECT, INSERT ON public.membership_audit TO "${role}"`);
  });
  t.after(async () => {
    await root.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  });
  const u = new URL(env.DATABASE_URL); u.username = role; u.password = 'x';
  const app = new Client({ connectionString: u.href }); await app.connect();
  try {
    // Grant level unchanged since PG-7: SELECT only, never a write, regardless of RLS.
    await rejects(app.query("INSERT INTO public.memberships(user_id,tenant_id,role) VALUES(1,$1,'agent')", [LOCAL_TENANT]), '42501');
    await rejects(app.query("UPDATE public.memberships SET status='archived'"), '42501');
    await rejects(app.query('DELETE FROM public.memberships'), '42501');
    // PG-9: a bare table-level GRANT is not enough to read anything without an
    // actor context — fail-closed by construction.
    assert.equal((await app.query('SELECT count(*)::int n FROM public.memberships')).rows[0].n, 0, 'no actor context: RLS hides every row');
    await app.query("SELECT set_config('securisite.actor_user_id',$1,false)", [String(uid)]);
    assert.equal((await app.query('SELECT count(*)::int n FROM public.memberships')).rows[0].n, 1, 'own membership becomes visible with a real actor context');
  } finally { await app.end(); }
});
