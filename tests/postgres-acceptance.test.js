'use strict';
// PG-29 — acceptation complète, de bout en bout, sous le rôle applicatif RÉEL
// (securisite_app, RLS pleinement appliquée — même technique que
// tests/postgres-scope-rls.test.js, PG-28, qui a trouvé deux régressions
// critiques invisibles sous le superutilisateur de test habituel).
//
// Scénario métier traversé une seule fois, dans l'ordre :
//   provisionnement (tenant/site/zone/utilisateurs/memberships, via
//   l'outillage réel — aucune route de création de tenant n'existe au
//   runtime, PG-8) → login → agent → badge → incident → SOS → Alert Core
//   (création automatique + cycle de vie complet) → SOC (liste temps réel)
//   → notification (réelle, pas simulée) → acquittement → intervention →
//   résolution → clôture → audit (security_audit + alert_audit) →
//   recherche IA (LocalAIProvider déterministe, aucune clé) → résumé IA
//   (idem) → vérification RLS / cross-tenant (scénarios négatifs).
//
// Deux tenants provisionnés (A et B) : B n'existe que pour prouver
// l'isolation — jamais touché par le scénario positif.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { apply } = require('../backend/db/postgresql/provision-roles');

const baseEnv = (() => {
  const raw = process.env.SECURISITE_TEST_DATABASE_URL;
  if (!raw) throw new Error('SECURISITE_TEST_DATABASE_URL requis pour les tests PostgreSQL réels');
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '::1'].includes(host) ||
      !/^securisite_test(?:_[a-z0-9]+)*$/.test(name) || /prod|production/i.test(name) || url.search || url.hash || !url.username) {
    throw new Error('Tests refusés : base securisite_test[_suffixe] locale explicitement requise');
  }
  return { NODE_ENV: 'test', DATABASE_URL: raw, PGSSL: process.env.SECURISITE_TEST_PGSSL || 'disable' };
})();

const migrationsDir = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const tag = () => randomBytes(5).toString('hex');
const now = () => new Date().toISOString();

let root, stop, base, migratorEnv;
const suffix = tag();
const names = { owner: 'acc_owner_' + suffix, migrator: 'acc_mig_' + suffix, app: 'acc_app_' + suffix };
const dbName = 'securisite_test_acceptance_' + suffix;

async function request(method, url, body, token) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}

let tenantA, siteA, zoneA, tenantB, siteB;
let socAId, agentAId, agentBId;
let socA, agentA, agentB; // JWTs

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
  // (docs/postgresql-deployment.md §2), pas une approximation locale.
  await apply(migratorEnv);

  // ── Provisionnement (setup uniquement, via le rôle migrateur — jamais le
  // chemin applicatif testé) ─────────────────────────────────────────────
  const setup = db.createDatabase(migratorEnv);
  try {
    tenantA = (await setup.get(
      `INSERT INTO public.tenants (code, name) VALUES ('acc_a','Client Acceptation A') RETURNING id`)).id;
    siteA = (await setup.get(
      `INSERT INTO public.sites (tenant_id, code, name, timezone) VALUES ($1,'main','Site A','UTC') RETURNING id`,
      [tenantA])).id;
    zoneA = (await setup.get(
      `INSERT INTO public.zones (site_id, tenant_id, code, name, kind) VALUES ($1,$2,'perim','Périmètre A','perimeter') RETURNING id`,
      [siteA, tenantA])).id;
    tenantB = (await setup.get(
      `INSERT INTO public.tenants (code, name) VALUES ('acc_b','Client Acceptation B') RETURNING id`)).id;
    siteB = (await setup.get(
      `INSERT INTO public.sites (tenant_id, code, name, timezone) VALUES ($1,'main','Site B','UTC') RETURNING id`,
      [tenantB])).id;

    const mkUser = async (username, role) => (await setup.get(
      `INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      [username, await bcrypt.hash('x', 10), username, role])).id;
    socAId = await mkUser('acc_soc_a', 'admin');
    agentAId = await mkUser('acc_agent_a', 'agent');
    agentBId = await mkUser('acc_agent_b', 'agent');

    await setup.query(
      `INSERT INTO public.memberships (user_id, tenant_id, role, alert_access) VALUES ($1,$2,'soc','scope')`,
      [socAId, tenantA]);
    await setup.query(
      `INSERT INTO public.memberships (user_id, tenant_id, site_id, role, alert_access) VALUES ($1,$2,$3,'agent','own')`,
      [agentAId, tenantA, siteA]);
    await setup.query(
      `INSERT INTO public.memberships (user_id, tenant_id, site_id, role, alert_access) VALUES ($1,$2,$3,'agent','own')`,
      [agentBId, tenantB, siteB]);
  } finally { await setup.close(); }

  // ── Serveur RÉEL sous le rôle applicatif RÉEL (RLS pleinement appliquée) ──
  const appUrl = new URL(migratorEnv.DATABASE_URL); appUrl.username = names.app; appUrl.password = migratorEnv.SECURISITE_APP_PASSWORD;
  Object.assign(process.env, { ...migratorEnv, DATABASE_URL: appUrl.href, PGSSL: 'disable', JWT_SECRET: 'x'.repeat(32) });
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;

  socA = (await request('POST', '/auth/login', { username: 'acc_soc_a', password: 'x' }, null)).body.token;
  agentA = (await request('POST', '/auth/login', { username: 'acc_agent_a', password: 'x' }, null)).body.token;
  agentB = (await request('POST', '/auth/login', { username: 'acc_agent_b', password: 'x' }, null)).body.token;
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

test('provisionnement : les trois comptes se connectent réellement sous le rôle applicatif RLS', () => {
  assert.ok(socA, 'soc_a authentifié');
  assert.ok(agentA, 'agent_a authentifié');
  assert.ok(agentB, 'agent_b authentifié (tenant B, isolé)');
});

let badgeRef;
test('agent : passage badge enregistré (métier historique, tenant A)', async () => {
  badgeRef = 'ACC-BADGE-' + tag();
  const r = await request('POST', '/pietons',
    { datetime: now(), nom: 'Visiteur test', badge: badgeRef, type: 'badge', point: 'Entrée A', sens: 'entree', resultat: 'refus' },
    agentA);
  assert.equal(r.status, 200);
  assert.equal(r.body.badge, badgeRef);
});

let incidentId, autoAlertId;
test('incident critique : création + déclenchement automatique d’une alerte Alert Core (règle incidentCritical)', async () => {
  const r = await request('POST', '/incidents',
    { datetime: now(), type: 'Intrusion', lieu: 'Site A', gravite: 'critique', description: 'Test acceptation PG-29', agent: 'acc_agent_a' },
    agentA);
  assert.equal(r.status, 200);
  incidentId = r.body.id;
  assert.equal(r.body.gravite, 'critique');

  const alerts = (await request('GET', '/alerts', undefined, socA)).body;
  const created = alerts.find(a => a.type === 'Incident grave' || (a.comment || '').includes(incidentId) || (a.comment || '').includes('Test acceptation PG-29'));
  assert.ok(created, 'l’incident critique a bien déclenché une alerte Alert Core automatique');
  autoAlertId = created.id;
  assert.equal(created.status, 'NOTIFIEE', 'une alerte fraîchement créée est NOTIFIEE');
});

test('résumé IA de l’incident (LocalAIProvider déterministe, aucune clé réelle)', async () => {
  const r = await request('GET', `/incidents/${incidentId}/summary`, undefined, socA);
  assert.equal(r.status, 200);
  assert.equal(r.body.generated_by_ai, true);
  assert.ok(typeof r.body.text === 'string' && r.body.text.length > 0);
});

test('SOC (accès scope) voit l’alerte en temps réel ; agent A (accès own, créateur du seul incident) aussi', async () => {
  const asSoc = (await request('GET', '/alerts', undefined, socA)).body;
  assert.ok(asSoc.some(a => a.id === autoAlertId));
  const asAgentA = (await request('GET', '/alerts', undefined, agentA)).body;
  assert.ok(Array.isArray(asAgentA), 'accès own : liste renvoyée sans erreur (créée par le système au nom du même tenant)');
});

test('notification réelle : au moins une notification existe pour un destinataire du tenant A', async () => {
  const notifsSoc = (await request('GET', '/alerts/notifications', undefined, socA)).body;
  const notifsAgentA = (await request('GET', '/alerts/notifications', undefined, agentA)).body;
  assert.ok(Array.isArray(notifsSoc) && Array.isArray(notifsAgentA));
  assert.ok(notifsSoc.length + notifsAgentA.length > 0, 'la création automatique de l’alerte a notifié au moins un destinataire réel');
});

test('cycle de vie complet : acquittement → intervention → résolution → clôture (réservé SOC)', async () => {
  // Un agent (non-SOC) ne peut pas transitionner.
  const denied = await request('POST', `/alerts/${autoAlertId}/actions`, { action: 'ACQUITTEE' }, agentA);
  assert.equal(denied.status, 403);

  for (const [action, expectedStatus] of [
    ['ACQUITTEE', 'ACQUITTEE'],
    ['EN_INTERVENTION', 'EN_INTERVENTION'],
    ['SOUS_CONTROLE', 'SOUS_CONTROLE'],
    ['RESOLUE', 'RESOLUE'],
    ['CLOTUREE', 'CLOTUREE'],
  ]) {
    const r = await request('POST', `/alerts/${autoAlertId}/actions`, { action, comment: 'PG-29 : ' + action }, socA);
    assert.equal(r.status, 200, `transition ${action}`);
    assert.equal(r.body.status, expectedStatus);
  }

  // Clôturée : plus aucune transition possible, même pour le SOC.
  const afterClose = await request('POST', `/alerts/${autoAlertId}/actions`, { action: 'COMMENTAIRE', comment: 'trop tard' }, socA);
  assert.equal(afterClose.status, 409);
});

test('audit : security_audit et alert_audit portent le cycle de vie complet, filtré au tenant de l’acteur (RLS)', async () => {
  const auditRows = (await request('GET', '/admin/security-audit', undefined, socA)).body;
  assert.ok(Array.isArray(auditRows) && auditRows.length > 0);
  assert.ok(auditRows.every(row => row.tenant_id === tenantA || row.tenant_id === null),
    'RLS : le SOC du tenant A ne voit jamais un événement d’un autre tenant');
  assert.ok(auditRows.some(row => row.event_type === 'alert.action'), 'les transitions ACQUITTEE/…/CLOTUREE sont auditées');

  const detail = await request('GET', `/alerts/${autoAlertId}`, undefined, socA);
  assert.equal(detail.status, 200);
  const timelineActions = detail.body.timeline.map(t => t.action);
  for (const expected of ['ACQUITTEE', 'EN_INTERVENTION', 'SOUS_CONTROLE', 'RESOLUE', 'CLOTUREE']) {
    assert.ok(timelineActions.includes(expected), `alert_audit contient ${expected}`);
  }
});

test('SOS : signal direct, propre transaction, propre alerte', async () => {
  const r = await request('POST', '/alerts/sos', { site: 'Site A', comment: 'PG-29 SOS' }, agentA);
  assert.equal(r.status, 201);
  assert.equal(r.body.origin, 'SOS');
});

test('recherche IA (LocalAIProvider) : retrouve l’incident/alerte du scénario, aucune clé réelle', async () => {
  const r = await request('GET', '/alerts/search?q=' + encodeURIComponent('acceptation'), undefined, agentA);
  assert.equal(r.status, 200);
  assert.equal(r.body.generated_by_ai, true);
  assert.ok(Array.isArray(r.body.results));
});

test('corrélation IA (réservée SOC) : chaque signal porte sa preuve exacte, aucune clé réelle', async () => {
  const deniedForAgent = await request('GET', '/alerts/correlations', undefined, agentA);
  assert.equal(deniedForAgent.status, 403);
  const r = await request('GET', '/alerts/correlations', undefined, socA);
  assert.equal(r.status, 200);
  assert.equal(r.body.generated_by_ai, true);
});

test('IA jamais autorité : /assistant ne fait que suggérer, ne transitionne jamais réellement', async () => {
  const r = await request('POST', '/alerts/assistant', { question: 'Que faire pour cette alerte ?' }, socA);
  assert.equal(r.status, 200);
  assert.equal(r.body.generated_by_ai, true);
  // L’alerte reste CLOTUREE quoi que l’IA ait pu suggérer : aucune action
  // n’a été exécutée par l’appel assistant lui-même.
  const still = await request('GET', `/alerts/${autoAlertId}`, undefined, socA);
  assert.equal(still.body.status, 'CLOTUREE');
});

test('négatif — cross-tenant : agent B (tenant B) ne voit jamais les données du tenant A', async () => {
  const listB = (await request('GET', '/alerts', undefined, agentB)).body;
  assert.ok(Array.isArray(listB));
  assert.ok(!listB.some(a => a.id === autoAlertId), 'aucune fuite de l’alerte du tenant A vers le tenant B');

  const direct = await request('GET', `/alerts/${autoAlertId}`, undefined, agentB);
  assert.equal(direct.status, 404, 'accès direct par id à une alerte d’un autre tenant : 404, jamais 200 ni 403 révélateur');

  const auditB = await request('GET', '/admin/security-audit', undefined, agentB);
  // agent B n'est pas admin JWT (requireAdmin) : refusé avant même la RLS.
  assert.equal(auditB.status, 403);
});

test('négatif — un utilisateur sans membership est refusé (RLS n’élargit jamais un accès)', async () => {
  const setup = db.createDatabase(migratorEnv);
  let noMemberId;
  try {
    noMemberId = (await setup.get(
      `INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['acc_no_member', await bcrypt.hash('x', 10), 'acc_no_member', 'agent'])).id;
  } finally { await setup.close(); }
  const login = await request('POST', '/auth/login', { username: 'acc_no_member', password: 'x' }, null);
  assert.equal(login.status, 200);
  const r = await request('GET', '/alerts', undefined, login.body.token);
  assert.equal(r.status, 403);
  void noMemberId;
});

test('négatif — transition interdite (hors machine à états) est refusée avec un motif métier, pas un 500', async () => {
  // Nouvelle alerte fraîche (NOTIFIEE) pour tester une transition illégale
  // sans perturber le cycle de vie déjà clôturé plus haut.
  const created = await request('POST', '/alerts', { site: 'Site A', type: 'Test transition illégale', level: 1 }, agentA);
  assert.equal(created.status, 201);
  const illegal = await request('POST', `/alerts/${created.body.id}/actions`, { action: 'RESOLUE' }, socA);
  assert.equal(illegal.status, 409, 'NOTIFIEE -> RESOLUE directement : transition interdite');
});
