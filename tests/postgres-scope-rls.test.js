'use strict';
// PG-28 (revue déploiement) — régression critique : backend/scope.js#resolveScope
// interrogeait memberships/tenants (2 des 5 tables protégées par RLS,
// migration 005, PG-9) SANS jamais poser securisite.actor_user_id. Sous le
// rôle applicatif RÉEL (securisite_app, NOBYPASSRLS), RLS filtrait alors ces
// lignes à zéro pour tout acteur — hasAccess restait TOUJOURS faux, et
// absolument AUCUNE route gardée par scope.requireScope() (l'essentiel de la
// surface métier : alertes, incidents, piétons, véhicules, carte…) ne
// fonctionnait. Masqué depuis PG-8/PG-9 par le fait que toute la suite de
// tests se connecte en tant que superutilisateur local (BYPASSRLS
// implicite) — jamais exercé sous le rôle réellement documenté pour la
// production (docs/postgresql-deployment.md) avant ce fichier.
//
// Ce fichier boote le serveur RÉEL (server.js), avec DATABASE_URL pointé
// sur un rôle securisite_app RÉELLEMENT provisionné (backend/db/postgresql/
// provision-roles.js#apply — mêmes GRANT que la procédure de déploiement
// documentée, pas une approximation) — la preuve la plus réaliste possible
// sans toucher à un environnement réel.
//
// Deuxième régression trouvée par le même moyen : backend/security-audit.js
// #record() faisait un INSERT ... RETURNING id sur security_audit — RLS
// (active sur cette table, migration 006) exige que la ligne insérée
// satisfasse AUSSI une politique de LECTURE pour être renvoyée par
// RETURNING (`security_audit_soc_read`) ; un événement à tenant_id NULL
// (login, refus avant résolution de périmètre) ne peut jamais la
// satisfaire — sous le rôle réel, l'INSERT échouait entièrement (42501),
// pas seulement le RETURNING. Pour un événement à l'intérieur d'une
// transaction critique (alert.create, fail-closed), cela aurait fait
// échouer/rollback la mutation elle-même. Corrigé : plus de RETURNING
// (id n'était lu par aucun appelant).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { apply } = require('../backend/db/postgresql/provision-roles');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const tag = () => randomBytes(5).toString('hex');

let root, stop, base, migratorEnv;
const names = { owner: 'sec_test_scopeowner_' + tag(), migrator: 'sec_test_scopemig_' + tag(), app: 'sec_test_scopeapp_' + tag() };
const dbName = 'securisite_test_scopeRLS_'.toLowerCase() + tag();

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  migratorEnv = {
    ...baseEnv,
    DATABASE_URL: (u => (u.pathname = '/' + dbName, u.href))(new URL(baseEnv.DATABASE_URL)),
    SECURISITE_OWNER_ROLE: names.owner, SECURISITE_MIGRATOR_ROLE: names.migrator, SECURISITE_APP_ROLE: names.app,
    SECURISITE_MIGRATOR_PASSWORD: 'mig-' + tag(), SECURISITE_APP_PASSWORD: 'app-' + tag(),
  };
  await migrate({ directory: migrationsDir, migrationEnv: migratorEnv });
  // Mêmes GRANT que la procédure de déploiement documentée
  // (docs/postgresql-deployment.md §2) — pas une approximation locale.
  await apply(migratorEnv);

  // Seed via le superutilisateur (setup uniquement — jamais le chemin testé).
  const setupPool = db.createDatabase(migratorEnv);
  const row = await setupPool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_scope_agent',$1,'agent') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await seedMembership(setupPool, row.id, 'agent');
  await setupPool.close();

  // Le serveur RÉEL, connecté en tant que securisite_app RÉELLEMENT
  // provisionné (RLS pleinement appliquée, PAS de BYPASSRLS) — jamais le
  // superutilisateur qu'utilise le reste de la suite de tests.
  const appUrl = new URL(migratorEnv.DATABASE_URL); appUrl.username = names.app; appUrl.password = migratorEnv.SECURISITE_APP_PASSWORD;
  Object.assign(process.env, { ...migratorEnv, DATABASE_URL: appUrl.href, PGSSL: 'disable', JWT_SECRET: 'x'.repeat(32) });
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
});
after(async () => {
  try { if (stop) await stop(); }
  finally {
    if (root) {
      await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)').catch(() => {});
      for (const r of [names.app, names.migrator, names.owner]) {
        await root.query('DROP OWNED BY "' + r + '"').catch(() => {});
        await root.query('DROP ROLE IF EXISTS "' + r + '"').catch(() => {});
      }
      await root.end();
    }
  }
});

test('a real user with a real membership gets real access under the actual securisite_app role (RLS enforced, no bypass)', async () => {
  const login = await request('POST', '/auth/login', { username: 'rls_scope_agent', password: 'x' }, null);
  assert.equal(login.status, 200);
  const token = login.body.token;

  // This is precisely the request that silently returned 403 "Accès au
  // périmètre refusé" for EVERY user under the real app role before the fix
  // — resolveScope() saw zero memberships due to unset RLS actor context.
  const r = await request('GET', '/alerts', undefined, token);
  assert.equal(r.status, 200, 'scope.requireScope() must resolve a real membership under real RLS enforcement');
  assert.ok(Array.isArray(r.body));
});

test('a user with genuinely no membership is still correctly refused under RLS (the fix does not widen access)', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  await setupPool.query(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_scope_nomember',$1,'agent')",
    [await bcrypt.hash('x', 10)]);
  await setupPool.close();

  const login = await request('POST', '/auth/login', { username: 'rls_scope_nomember', password: 'x' }, null);
  assert.equal(login.status, 200);
  const r = await request('GET', '/alerts', undefined, login.body.token);
  assert.equal(r.status, 403, 'no membership: still correctly refused, RLS is a second defense, not a widened first one');
});

test('a real mutation (alert creation) succeeds under RLS — its fail-closed security_audit write no longer blocks it', async () => {
  const login = await request('POST', '/auth/login', { username: 'rls_scope_agent', password: 'x' }, null);
  const token = login.body.token;
  // alert-core/service.js#create() writes to security_audit with
  // outcome:'success' INSIDE the same transaction, fail-closed (never
  // best-effort) — before the RETURNING fix, this INSERT would have
  // thrown 42501 and rolled the whole alert creation back.
  const r = await request('POST', '/alerts', { site: 'RLS Site', type: 'RLS Test', level: 2 }, token);
  assert.equal(r.status, 201, 'the alert is genuinely created, including its fail-closed security_audit event');
  assert.ok(r.body.id);
});

// PCS01 (Lot C) — régression du même type que PG-28 ci-dessus, trouvée en
// vérification live sur ce lot précisément : backend/alert-core/
// recipients.js interrogeait memberships/sites/zones (RLS, migration 005)
// SANS jamais poser securisite.actor_user_id — sous le rôle réel, chaque
// résolution de destinataire (site/zone/user/tenant_wide) revenait
// silencieusement VIDE (pas une erreur), déclenchant à tort "Aucun
// destinataire actif ne correspond à cette cible" (404) pour une cible
// pourtant valide. La suite dédiée (tests/postgres-alert-recipients.
// test.js) ne l'avait pas révélé, pour la même raison que PG-28 : connectée
// en superutilisateur. Corrigé par scope.withActorContext(...), même
// remède que PG-28 — verrouillé ici, sous le rôle réel, comme le reste de
// ce fichier.
test('PCS01: GET /alerts/recipients/candidates returns real members under the real app role (RLS enforced) — not silently empty', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  const soc = await setupPool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_pcs01_soc',$1,'admin') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await seedMembership(setupPool, soc.id, 'admin');
  await setupPool.close();

  const login = await request('POST', '/auth/login', { username: 'rls_pcs01_soc', password: 'x' }, null);
  assert.equal(login.status, 200);
  const r = await request('GET', '/alerts/recipients/candidates', undefined, login.body.token);
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 2, 'must see both the SOC account itself and the already-seeded agent — not an empty array');
  assert.ok(r.body.some(u => u.username === 'rls_scope_agent'));
});

test('PCS01: a tenant_wide broadcast resolves real recipients under the real app role (RLS enforced) — not a false "no recipient" 404', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  const soc = await setupPool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_pcs01_broadcaster',$1,'admin') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await seedMembership(setupPool, soc.id, 'admin');
  await setupPool.close();

  const login = await request('POST', '/auth/login', { username: 'rls_pcs01_broadcaster', password: 'x' }, null);
  const token = login.body.token;
  const alert = (await request('POST', '/alerts', { site: 'RLS Site', type: 'RLS Broadcast', level: 3 }, token)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/broadcast', { recipientType: 'tenant_wide' }, token);
  assert.equal(r.status, 201, 'a real, resolvable tenant_wide target must never come back as "no recipient found" under real RLS');
  assert.ok(r.body.recipientCount >= 1);
});

// PCS01 (Lot E) — security_alerts porte désormais sa propre RLS (migration
// 012, backend/alert-core/service.js#withActor/setActorContext/
// setSystemJob) — même classe de régression que PG-28/Lot C ci-dessus,
// vérifiée ici au même titre, sous le même rôle réellement provisionné.
test('PCS01 (Lot E): a real state transition (POST /alerts/:id/actions) succeeds under RLS — act() poses its own actor context', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  const soc = await setupPool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_pcs01_actor',$1,'admin') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await seedMembership(setupPool, soc.id, 'admin');
  await setupPool.close();

  const login = await request('POST', '/auth/login', { username: 'rls_pcs01_actor', password: 'x' }, null);
  const token = login.body.token;
  const alert = (await request('POST', '/alerts', { site: 'RLS Site', type: 'RLS Act', level: 2 }, token)).body;
  const r = await request('POST', '/alerts/' + alert.id + '/actions', { action: 'ACQUITTEE' }, token);
  assert.equal(r.status, 200, 'act() must succeed under RLS — before Lot E its own atomic() transaction never posed an actor context');
  assert.equal(r.body.status, 'ACQUITTEE');
});

// Le risque le plus élevé de ce lot : le job d'escalade planifié
// (backend/alert-core/service.js#escalateDue, invoqué nu par server.js, sans
// requête HTTP ni acteur humain) doit continuer à voir/traiter les alertes de
// TOUS les tenants sous le rôle réellement restreint — c'est précisément ce
// que securisite.system_job='escalation' (migration 012) existe pour
// garantir. Deux tenants distincts, chacun avec sa propre alerte niveau 3,
// créée via la route HTTP réelle (donc déjà sous RLS) ; le job est ensuite
// invoqué exactement comme server.js le fait (aucun client transactionnel,
// aucun acteur) — un `time` très avancé rend les trois paliers de la
// politique par défaut ([30,60,120] s, migration 002) dus sans dépendre d'un
// délai réel.
test('PCS01 (Lot E): the escalation job (no HTTP request, no actor) still escalates real pending alerts across MULTIPLE tenants under the real app role (RLS enforced)', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  const tenant2 = await setupPool.get(
    "INSERT INTO public.tenants(code,name) VALUES('rls-pcs01-tenant2','Tenant RLS 2') RETURNING id");
  const soc2 = await setupPool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_pcs01_soc2',$1,'admin') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await setupPool.query(
    "INSERT INTO public.memberships(user_id,tenant_id,role,alert_access) VALUES($1,$2,'soc','scope')",
    [soc2.id, tenant2.id]);
  await setupPool.close();

  const login1 = await request('POST', '/auth/login', { username: 'rls_scope_agent', password: 'x' }, null);
  const a1 = (await request('POST', '/alerts', { site: 'T1', type: 'Escalade T1', level: 3 }, login1.body.token)).body;

  const login2 = await request('POST', '/auth/login', { username: 'rls_pcs01_soc2', password: 'x' }, null);
  const a2 = (await request('POST', '/alerts', { site: 'T2', type: 'Escalade T2', level: 3 }, login2.body.token)).body;

  // require() partagé avec server.js (cache module Node) : même pool, déjà
  // connecté en tant que securisite_app réellement provisionné — jamais le
  // superutilisateur.
  const { escalateDue } = require('../backend/alerts');
  await escalateDue(Date.now() + 365 * 24 * 3600 * 1000);

  const check1 = await request('GET', '/alerts/' + a1.id, undefined, login1.body.token);
  const check2 = await request('GET', '/alerts/' + a2.id, undefined, login2.body.token);
  assert.equal(check1.status, 200);
  assert.equal(check2.status, 200);
  assert.equal(check1.body.escalation_step, 3, 'tenant 1 alert must have escalated through all 3 tiers under the real app role, no actor context');
  assert.equal(check2.body.escalation_step, 3, 'tenant 2 alert must ALSO have escalated — proves the job is not scoped to a single tenant');
});

// Administration Système (LOT 3) : backend/admin-sites.js et l'extension
// /admin/system (routes.js) interrogent tenants/sites — RLS-protégées
// (migration 005/017). Un bug réel a été trouvé en développement : un
// db.get()/db.all() nu y voyait silencieusement ZÉRO ligne sous le rôle
// applicatif restreint, jamais une erreur (même classe que les tests
// ci-dessus, seule cette suite l'aurait détecté — tests/postgres-
// admin-sites.test.js tourne sous SECURISITE_TEST_DATABASE_URL, presque
// toujours le superutilisateur, qui contourne RLS et n'aurait jamais vu
// le bug). Verrouillé ici, sous le rôle réellement restreint.
test('Administration Système : un compte admin sans AUCUNE appartenance voit et modifie quand même tenants/sites (migration 017, exception explicite)', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  const admin = await setupPool.get(
    "INSERT INTO public.users(username,password_hash,role) VALUES('rls_admin_no_membership',$1,'admin') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  // Délibérément AUCUNE ligne memberships pour ce compte — c'est exactement
  // l'état d'un compte créé via POST /admin/users (qui n'en provisionne
  // jamais) et le cas que la migration 017 doit couvrir.
  await setupPool.close();

  const login = await request('POST', '/auth/login', { username: 'rls_admin_no_membership', password: 'x' }, null);
  assert.equal(login.status, 200);
  const token = login.body.token;

  const created = await request('POST', '/admin/sites', { code: 'rls-admin-site', name: 'Site Admin Sans Appartenance' }, token);
  assert.equal(created.status, 201, 'creating a site must succeed even with zero memberships');

  const list = await request('GET', '/admin/sites', undefined, token);
  assert.equal(list.status, 200);
  assert.ok(list.body.sites.some(s => s.id === created.body.id), 'the created site must be visible in the list, not hidden by RLS');

  const updated = await request('PUT', '/admin/sites/' + created.body.id, { name: 'Renamed' }, token);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Renamed');

  const system = await request('GET', '/admin/system', undefined, token);
  assert.equal(system.status, 200);
  assert.ok(system.body.kpis.sites_total >= 1, 'the cockpit KPI must reflect the real site count, never a silent 0 from an unwrapped RLS query');

  // RECETTE VISUELLE ÉCRAN 1 : /admin/overview et /admin/zones interrogent
  // aussi sites (RLS) — même exception globale requise, sous le même rôle
  // applicatif restreint réel, pas le superutilisateur.
  const overview = await request('GET', '/admin/overview', undefined, token);
  assert.equal(overview.status, 200);
  assert.ok(overview.body.sites_by_status.active >= 1, 'overview sites_by_status must reflect real data under RLS, admin exception included');
  // security_audit reste intentionnellement restreint au rôle memberships
  // 'soc' (security_audit_soc_read, migration 006 — jamais étendu par la
  // migration 017, voir son commentaire) : un admin sans appartenance voit
  // une liste vide ici, PAS une erreur — fail-closed voulu, pas un bug.
  assert.deepEqual(overview.body.recent_activity, [], 'recent_activity must stay empty for a non-soc admin — security_audit read stays soc-gated by design, unlike sites');

  const zones = await request('GET', '/admin/zones?site_id=' + created.body.id, undefined, token);
  assert.equal(zones.status, 200, 'zones for a site owned by a membership-less admin must resolve, not 404 from an invisible site');

  // Suppression réelle (LOT 19 allégé) : même exception RLS requise, sous
  // le rôle applicatif restreint réel.
  const del = await request('DELETE', '/admin/sites/' + created.body.id, { reason: 'rls test cleanup' }, token);
  assert.equal(del.status, 200, 'a membership-less admin must be able to delete a real, dependency-free site under RLS');
});

// LOT GROUPES : Groupe = tenants (réutilisé). Le test le plus important de
// tout le lot — l'isolation inter-groupes réelle — doit être vérifié sous
// le VRAI rôle applicatif restreint (RLS pleinement appliquée), pas
// seulement sous le superutilisateur des autres suites d'intégration.
test('LOT GROUPES : un utilisateur d\'un groupe ne voit jamais un autre groupe, sous le rôle applicatif restreint réel (RLS)', async () => {
  const setupPool = db.createDatabase(migratorEnv);
  let groupA, groupB, siteA, siteB, adminToken;
  try {
    groupA = await setupPool.get("INSERT INTO public.tenants(code,name) VALUES('rls-dhl','DHL RLS') RETURNING id");
    groupB = await setupPool.get("INSERT INTO public.tenants(code,name) VALUES('rls-fiat','FIAT RLS') RETURNING id");
    siteA = await setupPool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'rls-dhl-site','DHL Site') RETURNING id", [groupA.id]);
    siteB = await setupPool.get("INSERT INTO public.sites(tenant_id,code,name) VALUES($1,'rls-fiat-site','FIAT Site') RETURNING id", [groupB.id]);
    const admin = await setupPool.get(
      "INSERT INTO public.users(username,password_hash,role) VALUES('rls_groups_admin',$1,'admin') RETURNING id",
      [await bcrypt.hash('x', 10)]);
    const dhlUser = await setupPool.get(
      "INSERT INTO public.users(username,password_hash,role) VALUES('rls_groups_dhluser',$1,'agent') RETURNING id",
      [await bcrypt.hash('x', 10)]);
    // Appartenance de niveau TENANT = "tous les sites du groupe" (périmètre
    // maximal) — la même règle que backend/scope.js#visibleSiteIds.
    await setupPool.query(
      "INSERT INTO public.memberships(user_id,tenant_id,role,alert_access) VALUES($1,$2,'agent','own')",
      [dhlUser.id, groupA.id]);
  } finally { await setupPool.close(); }

  const adminLogin = await request('POST', '/auth/login', { username: 'rls_groups_admin', password: 'x' }, null);
  adminToken = adminLogin.body.token;
  const dhlLogin = await request('POST', '/auth/login', { username: 'rls_groups_dhluser', password: 'x' }, null);
  const dhlToken = dhlLogin.body.token;

  // Admin global (sans appartenance) : gère les deux groupes normalement.
  const groupsList = await request('GET', '/admin/groups', undefined, adminToken);
  assert.equal(groupsList.status, 200);
  assert.ok(groupsList.body.groups.some(g => g.id === groupA.id) && groupsList.body.groups.some(g => g.id === groupB.id));

  // Utilisateur DHL (memberships réelles, rôle applicatif restreint réel) :
  // son propre groupe passe, le groupe voisin est refusé — jamais une
  // liste vide qui masquerait un vrai 403, jamais une fuite inter-groupe.
  const ownGroup = await request('GET', '/incidents?tenant_id=' + groupA.id + '&site_id=' + siteA.id, undefined, dhlToken);
  assert.equal(ownGroup.status, 200, 'DHL user must reach their own group/site under real RLS');
  const siblingGroup = await request('GET', '/incidents?tenant_id=' + groupB.id + '&site_id=' + siteB.id, undefined, dhlToken);
  assert.equal(siblingGroup.status, 403, 'DHL user must NEVER reach FIAT — real RLS, real cross-group isolation, no leak');

  // dhlUser n'a qu'une appartenance de niveau TENANT (aucune ligne
  // site_id/zone_id) : countSiteDependencies ne compte que les dépendances
  // RATTACHÉES AU SITE (zones, postes, main courante, appartenances
  // SITE-level…), jamais les appartenances tenant-wide qui le couvrent
  // implicitement — siteA est donc réaffectable sous RLS réelle, sans 409.
  const reassign = await request('PUT', '/admin/groups/' + groupB.id + '/sites', { add: [siteA.id] }, adminToken);
  assert.equal(reassign.status, 200, 'a site covered only by a tenant-wide membership (no site-level dependency row) must remain movable');

  // Preuve de non-fuite après réaffectation : la portée n'est jamais mise en
  // cache — elle est relue en direct sur tenant_id à chaque requête. siteA
  // appartient désormais réellement à groupB (FIAT) ; dhlUser (toujours
  // seulement membre de DHL, aucune ligne memberships modifiée — elles sont
  // immuables) n'a aucune appartenance dans groupB et doit être refusé dès
  // la résolution du périmètre, sans qu'aucun code n'ait eu besoin d'être
  // touché pour "invalider un cache".
  const staleAccess = await request('GET', '/incidents?tenant_id=' + groupB.id + '&site_id=' + siteA.id, undefined, dhlToken);
  assert.equal(staleAccess.status, 403, 'after moving siteA out of DHL into FIAT, the DHL user must never reach it via FIAT\'s tenant_id — scope is resolved live, never stale/cached');
});
