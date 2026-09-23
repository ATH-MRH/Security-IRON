'use strict';
// PG-6 — référentiel tenants / sites / zones (migration 003), natif PostgreSQL.
// Schéma + contraintes + backfill. AUCUNE activation de visibilité multitenant.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady, SCOPE, PRIVILEGES } = require('../backend/db/postgresql/readiness');
const { testEnvironment } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const LOCAL_TENANT = '507486ba-d55e-5142-9ac2-196da97866df';
const MAIN_SITE = 'fa831124-0323-581e-993c-1f4332a36282';
const tag = () => randomBytes(5).toString('hex');

let root;
before(async () => { root = new Client(db.configuration(baseEnv)); await root.connect(); });
after(async () => { if (root) await root.end(); });

// Disposable database with migrations 001/002/003 applied.
async function scoped(t) {
  const n = 'securisite_test_scope_' + tag();
  await root.query('CREATE DATABASE "' + n + '"');
  t.after(() => root.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'));
  const env = { ...baseEnv, DATABASE_URL: (u => (u.pathname = '/' + n, u.href))(new URL(baseEnv.DATABASE_URL)) };
  await migrate({ directory: migrationsDir, migrationEnv: env });
  return { n, env };
}
async function withClient(env, fn) {
  const c = new Client({ connectionString: env.DATABASE_URL }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const rejects = (promise, code) => assert.rejects(promise, e => { assert.equal(e.code, code, e.message); return true; });

test('003 creates tenants / sites / zones with the expected columns and defaults', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    const cols = t => c.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
      [t]).then(r => r.rows);
    const tenants = await cols('tenants');
    // description/updated_at/archived_at ajoutés par la migration 018 (LOT
    // GROUPES : groupe = tenant réutilisé, jamais une table dupliquée) —
    // colonnes 003 d'origine jamais renommées.
    assert.deepEqual(tenants.map(x => x.column_name), ['id', 'code', 'name', 'status', 'created_at', 'description', 'updated_at', 'archived_at']);
    assert.equal(tenants.find(x => x.column_name === 'id').data_type, 'uuid');
    assert.match(tenants.find(x => x.column_name === 'id').column_default, /gen_random_uuid\(\)/);
    assert.equal(tenants.find(x => x.column_name === 'created_at').data_type, 'timestamp with time zone');
    const sites = (await cols('sites')).map(x => x.column_name);
    // client/phone/email/updated_at/archived_at ajoutés par la migration 015
    // (Administration Système) — colonnes 003 d'origine jamais renommées.
    assert.deepEqual(sites, ['id', 'tenant_id', 'code', 'name', 'address', 'timezone', 'latitude', 'longitude', 'external_ref', 'status', 'created_at', 'client', 'phone', 'email', 'updated_at', 'archived_at']);
    const zones = (await cols('zones')).map(x => x.column_name);
    // description/access_level/updated_at/archived_at ajoutés par la migration 015.
    assert.deepEqual(zones, ['id', 'site_id', 'tenant_id', 'code', 'name', 'kind', 'status', 'created_at', 'description', 'access_level', 'updated_at', 'archived_at']);
  });
});

test('backfill: exactly one local tenant and its main site (frozen ids), no zones', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    const tn = (await c.query('SELECT id, code, name, status FROM public.tenants')).rows;
    assert.deepEqual(tn, [{ id: LOCAL_TENANT, code: 'local', name: 'Client local', status: 'active' }]);
    const st = (await c.query('SELECT id, tenant_id, code, name, address, timezone, status FROM public.sites')).rows;
    assert.deepEqual(st, [{ id: MAIN_SITE, tenant_id: LOCAL_TENANT, code: 'main', name: 'Site principal', address: null, timezone: 'UTC', status: 'active' }]);
    assert.equal((await c.query('SELECT count(*)::int n FROM public.zones')).rows[0].n, 0);
  });
});

test('backfill: the site name/address expression derives from public.parametres', async t => {
  // The 003 backfill runs at migration time (parametres usually still empty then, hence the
  // 'Site principal' default). Here we replay the exact backfill statement with parametres
  // populated to prove the COALESCE/NULLIF/btrim logic itself is correct.
  const { env } = await scoped(t);
  await withClient(env, async c => {
    // Simulate the historical situation: parametres populated, main site re-derived.
    await c.query("INSERT INTO public.parametres(cle,valeur) VALUES('site','  Site Industriel Principal  '),('adresse','Zone Industrielle')");
    await c.query('DELETE FROM public.sites');
    await c.query(`
      INSERT INTO public.sites (id, tenant_id, code, name, address, timezone)
      SELECT $1, (SELECT id FROM public.tenants WHERE code='local'), 'main',
             COALESCE(NULLIF(btrim((SELECT valeur FROM public.parametres WHERE cle='site')), ''), 'Site principal'),
             NULLIF(btrim((SELECT valeur FROM public.parametres WHERE cle='adresse')), ''), 'UTC'
      ON CONFLICT (tenant_id, code) DO NOTHING`, [MAIN_SITE]);
    const st = (await c.query('SELECT name, address FROM public.sites')).rows[0];
    assert.equal(st.name, 'Site Industriel Principal');
    assert.equal(st.address, 'Zone Industrielle');
  });
});

test('a zone whose tenant_id differs from its site is rejected by the composite foreign key', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    await c.query("INSERT INTO public.tenants(id,code,name) VALUES('11111111-1111-1111-1111-111111111111','other','Autre')");
    await rejects(
      c.query("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,'11111111-1111-1111-1111-111111111111','z1','Zone 1')", [MAIN_SITE]),
      '23503');
    // The correct tenant is accepted.
    await c.query("INSERT INTO public.zones(site_id,tenant_id,code,name,kind) VALUES($1,$2,'perimetre','Périmètre','perimeter')", [MAIN_SITE, LOCAL_TENANT]);
    assert.equal((await c.query('SELECT count(*)::int n FROM public.zones')).rows[0].n, 1);
  });
});

test('MISSION — TRANSFERT INTER-GROUPES : changing a site tenant now succeeds and cascades to its zones (migration 019)', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    await c.query("INSERT INTO public.tenants(id,code,name) VALUES('22222222-2222-2222-2222-222222222222','t2','T2')");
    const zoneId = (await c.query("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z') RETURNING id", [MAIN_SITE, LOCAL_TENANT])).rows[0].id;
    // Décision métier validée (rapport de mission "TRANSFERT INTER-GROUPES
    // DES SITES") : un site avec des zones réelles DOIT pouvoir changer de
    // groupe — la contrainte ON UPDATE RESTRICT d'origine (migration 003)
    // rendait cela définitivement impossible ; migration 019 la remplace
    // par ON UPDATE CASCADE (zones.tenant_id est une colonne purement
    // dénormalisée, sans signification de sécurité propre — elle suit
    // simplement son site parent). zones.id reste inchangé (même zone,
    // même historique), seul zones.tenant_id suit sites.tenant_id.
    await c.query("UPDATE public.sites SET tenant_id='22222222-2222-2222-2222-222222222222' WHERE id=$1", [MAIN_SITE]);
    const zone = await c.query('SELECT id, tenant_id FROM public.zones WHERE id=$1', [zoneId]);
    assert.equal(zone.rows[0].id, zoneId, 'la zone conserve exactement le même id');
    assert.equal(zone.rows[0].tenant_id, '22222222-2222-2222-2222-222222222222', 'zones.tenant_id suit sites.tenant_id via CASCADE');
  });
});

test('deleting a tenant or site that is still referenced is restricted', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    await rejects(c.query("DELETE FROM public.tenants WHERE code='local'"), '23503');
    await c.query("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z')", [MAIN_SITE, LOCAL_TENANT]);
    await rejects(c.query('DELETE FROM public.sites WHERE id=$1', [MAIN_SITE]), '23503');
  });
});

test('CHECK constraints: code slug, status, kind, GPS range and pairing', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    await rejects(c.query("INSERT INTO public.tenants(code,name) VALUES('Bad Code','x')"), '23514');
    await rejects(c.query("INSERT INTO public.tenants(code,name,status) VALUES('t','x','running')"), '23514');
    await rejects(c.query("INSERT INTO public.tenants(code,name) VALUES('t','   ')"), '23514');
    await rejects(c.query("INSERT INTO public.zones(site_id,tenant_id,code,name,kind) VALUES($1,$2,'z','Z','tower')", [MAIN_SITE, LOCAL_TENANT]), '23514');
    await rejects(c.query("INSERT INTO public.sites(tenant_id,code,name,latitude,longitude) VALUES($1,'s','S',200,0)", [LOCAL_TENANT]), '23514');
    await rejects(c.query("INSERT INTO public.sites(tenant_id,code,name,latitude) VALUES($1,'s','S',45)", [LOCAL_TENANT]), '23514'); // lat without lon
    await c.query("INSERT INTO public.sites(tenant_id,code,name,latitude,longitude) VALUES($1,'gps','S',35.7,-0.6)", [LOCAL_TENANT]);
  });
});

test('UNIQUE constraints: (tenant_id, code) on sites, (site_id, code) on zones, partial external_ref', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    await rejects(c.query("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'main','Doublon')", [LOCAL_TENANT]), '23505');
    await c.query("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z')", [MAIN_SITE, LOCAL_TENANT]);
    await rejects(c.query("INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z bis')", [MAIN_SITE, LOCAL_TENANT]), '23505');
    await c.query("INSERT INTO public.sites(tenant_id,code,name,external_ref) VALUES($1,'s1','S1','ATLAS-1')", [LOCAL_TENANT]);
    await rejects(c.query("INSERT INTO public.sites(tenant_id,code,name,external_ref) VALUES($1,'s2','S2','ATLAS-1')", [LOCAL_TENANT]), '23505');
    // NULL external_ref is not constrained.
    await c.query("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'s3','S3')", [LOCAL_TENANT]);
  });
});

test('ids default to gen_random_uuid when not provided', async t => {
  const { env } = await scoped(t);
  await withClient(env, async c => {
    const id = (await c.query("INSERT INTO public.tenants(code,name) VALUES('auto','Auto') RETURNING id")).rows[0].id;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(id, LOCAL_TENANT);
  });
});

test('readiness now requires tenants/sites/zones and passes on a 003-migrated database', async t => {
  const { env } = await scoped(t);
  assert.deepEqual(SCOPE, ['tenants', 'sites', 'zones']);
  const pool = db.createDatabase({ NODE_ENV: 'test', DATABASE_URL: env.DATABASE_URL, PGSSL: 'disable' });
  try {
    assert.equal(await assertReady(pool, { directory: migrationsDir }), undefined);
    await pool.query('DROP TABLE public.zones CASCADE'); // 004 adds a memberships FK to zones
    await assert.rejects(assertReady(pool, { directory: migrationsDir }),
      e => e.code === 'READINESS_TABLE_MISSING' && /zones/.test(e.message));
  } finally { await pool.close(); }
});

test('PG-6 does not activate anything at the grant level; PG-9 row-level security requires a real actor context', async t => {
  // tenants gagne INSERT,UPDATE à la migration 018 (LOT Groupes — tenants
  // EST le référentiel Groupe canonique, jamais dupliqué ; pas de DELETE).
  assert.equal(PRIVILEGES.tenants, 'SELECT,INSERT,UPDATE');
  // sites gagne INSERT,UPDATE à la migration 015 (Administration Système,
  // backend/admin-sites.js — création/modification/statut de site) puis
  // DELETE (suppression refusée dès qu'une donnée réelle en dépend) ; zones
  // reste lecture seule tant que sa propre mutation (LOT 6) n'est pas livrée.
  assert.equal(PRIVILEGES.sites, 'SELECT,INSERT,UPDATE,DELETE');
  assert.equal(PRIVILEGES.zones, 'SELECT');
  const { env, n } = await scoped(t);
  const role = 'sec_test_scope_app_' + tag();
  let userId;
  await withClient(env, async c => {
    await c.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'x'`);
    await c.query(`GRANT CONNECT ON DATABASE "${n}" TO "${role}"`);
    await c.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await c.query(`GRANT USAGE ON SCHEMA securisite_meta TO "${role}"`);
    await c.query(`GRANT EXECUTE ON FUNCTION securisite_meta.current_actor_tenant_ids() TO "${role}"`);
    // Migration 017 : chaque politique RLS du référentiel de scope évalue
    // désormais aussi current_actor_is_global_admin() (exception
    // Administrateur global) — EXECUTE requis même pour ce rôle 'agent' non
    // admin, sinon l'évaluation de la politique échoue avant de pouvoir
    // même conclure "false".
    await c.query(`GRANT EXECUTE ON FUNCTION securisite_meta.current_actor_is_global_admin() TO "${role}"`);
    for (const s of SCOPE) await c.query(`GRANT SELECT ON public.${s} TO "${role}"`);
    userId = (await c.query(
      "INSERT INTO public.users(username,password_hash,role) VALUES('scope-rls','fixture','agent') RETURNING id")).rows[0].id;
    await c.query('INSERT INTO public.memberships(user_id,tenant_id,role,alert_access) VALUES($1,$2,$3,$4)',
      [userId, LOCAL_TENANT, 'agent', 'own']);
  });
  t.after(async () => {
    await root.query(`DROP OWNED BY "${role}"`).catch(() => {});
    await root.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  });
  const u = new URL(env.DATABASE_URL); u.username = role; u.password = 'x';
  const app = new Client({ connectionString: u.href }); await app.connect();
  try {
    // Grant level unchanged since PG-6: SELECT only, never a write, regardless of RLS.
    await rejects(app.query("INSERT INTO public.tenants(code,name) VALUES('x','X')"), '42501');
    await rejects(app.query("UPDATE public.sites SET name='x'"), '42501');
    await rejects(app.query('DELETE FROM public.zones'), '42501');
    // PG-9: a bare table-level GRANT is not enough to read anything without an
    // actor context — fail-closed by construction, never an implicit "everyone sees all".
    assert.equal((await app.query('SELECT count(*)::int n FROM public.tenants')).rows[0].n, 0, 'no actor context: RLS hides every row');
    await app.query("SELECT set_config('securisite.actor_user_id',$1,false)", [String(userId)]);
    assert.equal((await app.query('SELECT count(*)::int n FROM public.tenants')).rows[0].n, 1, 'own tenant becomes visible with a real, active membership');
  } finally { await app.end(); }
});
