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
