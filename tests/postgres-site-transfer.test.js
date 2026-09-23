'use strict';
// MISSION — TRANSFERT INTER-GROUPES DES SITES (backend/admin-sites.js
// #GET/POST /sites/:id/transfer-impact|transfer, migrations 019/020).
// PostgreSQL réel, aucun mock — mêmes conventions que
// tests/postgres-admin-groups.test.js. Couvre exhaustivement les CAS 1-12
// (§16 de la mission) plus les contrôles de permission (§10).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_sitetransfer_' + randomUUID().replace(/-/g, '').slice(0, 12);
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin, agentToken, pool;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
const uniqCode = (p = 'site') => p + '-' + randomUUID().slice(0, 8);

async function createGroup(overrides = {}) {
  const r = await request('POST', '/admin/groups', { code: uniqCode('grp'), name: 'Group ' + randomUUID().slice(0, 6), ...overrides });
  assert.equal(r.status, 201, 'fixture group creation must succeed: ' + JSON.stringify(r.body));
  return r.body;
}
async function createSite(overrides = {}) {
  const r = await request('POST', '/admin/sites', { code: uniqCode(), name: 'Site ' + randomUUID().slice(0, 6), ...overrides });
  assert.equal(r.status, 201, 'fixture site creation must succeed: ' + JSON.stringify(r.body));
  return r.body;
}
async function createUserAccount(username) {
  const r = await request('POST', '/admin/users', { username, password: 'x'.repeat(10), role: 'agent' });
  assert.equal(r.status, 200, 'fixture user creation must succeed: ' + JSON.stringify(r.body));
  return r.body;
}
async function login(username, password = 'x'.repeat(10)) {
  const r = await request('POST', '/auth/login', { username, password }, null);
  assert.equal(r.status, 200);
  return r.body.token;
}
async function assignSite(groupId, siteId) {
  const r = await request('PUT', '/admin/groups/' + groupId + '/sites', { add: [siteId] });
  assert.equal(r.status, 200, 'fixture site assignment must succeed: ' + JSON.stringify(r.body));
}
async function assignUser(groupId, userId, opts) {
  const r = await request('POST', '/admin/groups/' + groupId + '/users', { user_id: userId, role: 'agent', ...opts });
  assert.equal(r.status, 201, 'fixture user assignment must succeed: ' + JSON.stringify(r.body));
  return r.body;
}
async function transferImpact(siteId, targetGroupId) {
  return request('GET', '/admin/sites/' + siteId + '/transfer-impact?target_group_id=' + targetGroupId);
}
async function transfer(siteId, targetGroupId, reason = 'test automatisé transfert', extra = {}, token = admin) {
  return request('POST', '/admin/sites/' + siteId + '/transfer', { target_group_id: targetGroupId, reason, ...extra }, token);
}
async function membershipStatus(membershipId) {
  return (await pool.get('SELECT status FROM public.memberships WHERE id=$1', [membershipId])).status;
}

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  const a = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['sitetransfer_admin', await bcrypt.hash('securisite', 10), 'Admin', 'admin']);
  await seedMembership(pool, a.id, 'admin');
  const g = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['sitetransfer_agent', await bcrypt.hash('securisite', 10), 'Agent', 'agent']);
  await seedMembership(pool, g.id, 'agent');
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'sitetransfer_admin', password: 'securisite' }, null)).body.token;
  agentToken = (await request('POST', '/auth/login', { username: 'sitetransfer_agent', password: 'securisite' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally {
    if (pool) await pool.close();
    if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); }
  }
});

/* ============================================================ */
/*  CAS1 — site sans dépendance, transfert réussi                  */
/* ============================================================ */
test('CAS1 : un site sans dépendance transfère avec succès d\'un groupe à un autre', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.site.tenant_id, fiat.id);
  assert.equal(r.body.previous_group.id, dhl.id);
  assert.equal(r.body.new_group.id, fiat.id);
});

/* ============================================================ */
/*  CAS2 — site avec zones/postes réels, transfert réussi,          */
/*  mêmes ids préservés                                             */
/* ============================================================ */
test('CAS2 : un site avec des zones et des postes réels transfère avec succès — mêmes ids préservés', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const zoneId = (await pool.get(
    `INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z1','Zone 1') RETURNING id`,
    [s.id, dhl.id])).id;
  const posteId = (await pool.get(
    `INSERT INTO public.mc_posts(tenant_id,site_id,zone_id,name) VALUES($1,$2,$3,'Poste 1') RETURNING id`,
    [dhl.id, s.id, zoneId])).id;
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.site.id, s.id, 'même site.id');
  const zone = await pool.get('SELECT id, tenant_id FROM public.zones WHERE id=$1', [zoneId]);
  assert.equal(zone.id, zoneId, 'la zone conserve exactement le même id');
  assert.equal(zone.tenant_id, fiat.id, 'zones.tenant_id suit sites.tenant_id');
  const poste = await pool.get('SELECT id, tenant_id, site_id FROM public.mc_posts WHERE id=$1', [posteId]);
  assert.equal(poste.id, posteId, 'le poste conserve exactement le même id');
  assert.equal(poste.site_id, s.id, 'le poste reste rattaché au même site');
  assert.equal(poste.tenant_id, fiat.id, 'mc_posts.tenant_id suit sites.tenant_id');
});

/* ============================================================ */
/*  CAS3 — site avec Main courante réel, transfert réussi,          */
/*  événements toujours présents sous le même site_id               */
/* ============================================================ */
test('CAS3 : un site avec des événements Main courante réels transfère avec succès — événements toujours présents sous le même site_id', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO public.main_courante(id, datetime, type, tenant_id, site_id) VALUES ($1, now()::text, 'evenement', $2, $3)`,
    [eventId, dhl.id, s.id]);
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ev = await pool.get('SELECT id, site_id, tenant_id FROM public.main_courante WHERE id=$1', [eventId]);
  assert.equal(ev.id, eventId, 'même événement, même id');
  assert.equal(ev.site_id, s.id, 'toujours rattaché au même site_id');
  assert.equal(ev.tenant_id, fiat.id, 'main_courante.tenant_id suit sites.tenant_id');
});

/* ============================================================ */
/*  CAS4 — utilisateur tenant-wide de l'ancien groupe perd l'accès   */
/* ============================================================ */
test('CAS4 : un utilisateur tenant-wide (all_sites) de l\'ancien groupe perd l\'accès au site après transfert', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const u = await createUserAccount('u_cas4_' + randomUUID().slice(0, 6));
  await assignUser(dhl.id, u.id, { all_sites: true });
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents?tenant_id=' + dhl.id + '&site_id=' + s.id, undefined, token)).status, 200);
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await request('GET', '/incidents?tenant_id=' + dhl.id + '&site_id=' + s.id, undefined, token)).status, 403,
    'un membership tenant-level de l\'ANCIEN groupe ne doit plus jamais couvrir le site transféré (scope.js#liveResourceTenant)');
});

/* ============================================================ */
/*  CAS5 — utilisateur explicitement site-scoped de l'ancien groupe  */
/*  voit son accès retiré/archivé selon le modèle                   */
/* ============================================================ */
test('CAS5 : un utilisateur explicitement site-scoped sous l\'ancien groupe voit son membership archivé (DENY BY DEFAULT)', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const u = await createUserAccount('u_cas5_' + randomUUID().slice(0, 6));
  const assigned = await assignUser(dhl.id, u.id, { site_ids: [s.id] });
  const membershipId = (await pool.get(
    `SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s.id])).id;
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents?tenant_id=' + dhl.id + '&site_id=' + s.id, undefined, token)).status, 200);
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await membershipStatus(membershipId), 'archived', 'le membership site-scoped doit être archivé, jamais conservé implicitement');
  assert.equal((await request('GET', '/incidents?tenant_id=' + dhl.id + '&site_id=' + s.id, undefined, token)).status, 403);
  assert.ok(r.body.memberships_archived.some(m => m.user_id === u.id), 'la réponse doit lister le membership archivé');
});

/* ============================================================ */
/*  CAS6 — le périmètre de l'utilisateur du nouveau groupe est       */
/*  correctement calculé après transfert                            */
/* ============================================================ */
test('CAS6 : un utilisateur du nouveau groupe (all_sites) obtient correctement accès au site après transfert', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const u = await createUserAccount('u_cas6_' + randomUUID().slice(0, 6));
  await assignUser(fiat.id, u.id, { all_sites: true });
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents?tenant_id=' + fiat.id + '&site_id=' + s.id, undefined, token)).status, 403,
    'avant transfert, le nouveau groupe ne couvre pas encore ce site');
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await request('GET', '/incidents?tenant_id=' + fiat.id + '&site_id=' + s.id, undefined, token)).status, 200,
    'après transfert, le périmètre tenant-wide du nouveau groupe couvre bien le site');
});

/* ============================================================ */
/*  CAS7 — l'Administrateur global conserve son accès               */
/* ============================================================ */
test('CAS7 : l\'Administrateur global conserve son accès complet avant et après transfert', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  assert.equal((await request('GET', '/admin/sites/' + s.id)).status, 200);
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await request('GET', '/admin/sites/' + s.id)).status, 200, 'admin global toujours en mesure de lire le site après transfert');
});

/* ============================================================ */
/*  CAS8 — utilisateur non autorisé → 403 (§10, deny by default)    */
/* ============================================================ */
test('CAS8 : un utilisateur non-administrateur ne peut jamais initier un transfert — 401 sans token, 403 avec un rôle non-admin', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  assert.equal((await transfer(s.id, fiat.id, 'x', {}, null)).status, 401);
  assert.equal((await transfer(s.id, fiat.id, 'x', {}, agentToken)).status, 403);
  assert.equal((await transferImpact(s.id, fiat.id)).status, 200, 'sanity: admin peut toujours lire l\'aperçu');
  const impactAsAgent = await request('GET', '/admin/sites/' + s.id + '/transfer-impact?target_group_id=' + fiat.id, undefined, agentToken);
  assert.equal(impactAsAgent.status, 403);
  const fetched = await request('GET', '/admin/sites/' + s.id);
  assert.equal(fetched.body.tenant_id, dhl.id, 'aucun transfert ne doit avoir eu lieu suite à ces tentatives refusées');
});

/* ============================================================ */
/*  CAS9 — deux transferts concurrents du même site : un seul        */
/*  gagne, l'autre reçoit un 409 propre (§8, expected_source_group_id) */
/* ============================================================ */
test('CAS9 : deux transferts concurrents du même site — un seul aboutit, l\'autre reçoit 409 et doit recharger l\'analyse', async () => {
  const dhl = await createGroup(); const fiat = await createGroup(); const local3 = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const impact = await transferImpact(s.id, fiat.id);
  assert.equal(impact.status, 200);
  const expectedSource = impact.body.source_group.id;
  assert.equal(expectedSource, dhl.id);
  const [r1, r2] = await Promise.all([
    transfer(s.id, fiat.id, 'concurrent A', { expected_source_group_id: expectedSource }),
    transfer(s.id, local3.id, 'concurrent B', { expected_source_group_id: expectedSource }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactement un des deux transferts doit réussir, l\'autre doit être refusé proprement: ' + JSON.stringify([r1.body, r2.body]));
  const loser = r1.status === 409 ? r1 : r2;
  assert.match(loser.body.error, /changé de groupe|recharg/i, 'le message doit inviter à recharger l\'analyse d\'impact');
  const fetched = await request('GET', '/admin/sites/' + s.id);
  assert.ok([fiat.id, local3.id].includes(fetched.body.tenant_id), 'le site doit avoir bien changé de groupe exactement une fois');
});

/* ============================================================ */
/*  CAS10 — erreur en cours de transaction → rollback complet,       */
/*  jamais un transfert partiel                                     */
/* ============================================================ */
test('CAS10 : un rejet en cours de traitement (collision de code dans le groupe cible) annule la transaction en entier — rien n\'est modifié', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite({ code: 'collision-code' });
  await assignSite(dhl.id, s.id);
  const colliding = await request('POST', '/admin/sites', { code: 'collision-code', name: 'Site en collision', tenant_id: fiat.id });
  assert.equal(colliding.status, 201, JSON.stringify(colliding.body));
  const u = await createUserAccount('u_cas10_' + randomUUID().slice(0, 6));
  const assigned = await assignUser(dhl.id, u.id, { site_ids: [s.id] });
  const membershipId = (await pool.get(
    `SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s.id])).id;
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /code/i);
  const fetched = await request('GET', '/admin/sites/' + s.id);
  assert.equal(fetched.body.tenant_id, dhl.id, 'le site ne doit PAS avoir changé de groupe — rollback complet');
  assert.equal(await membershipStatus(membershipId), 'active', 'le membership ne doit PAS avoir été archivé — rollback complet, jamais une écriture partielle');
});

/* ============================================================ */
/*  CAS11 — l'audit contient bien un événement site.transfer        */
/* ============================================================ */
test('CAS11 : le transfert écrit un événement d\'audit dédié avec les détails attendus', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const r = await transfer(s.id, fiat.id, 'motif précis pour audit');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const audit = await pool.get(
    `SELECT event_type, resource_type, resource_id, detail FROM public.security_audit
     WHERE event_type='system_admin.site.transfer' AND resource_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.id]);
  assert.ok(audit, 'un événement audit site.transfer doit exister');
  assert.equal(audit.resource_type, 'site');
  assert.equal(audit.detail.source_group_id, dhl.id);
  assert.equal(audit.detail.target_group_id, fiat.id);
  assert.equal(audit.detail.reason, 'motif précis pour audit');
});

/* ============================================================ */
/*  CAS12 — site.id avant == site.id après                          */
/* ============================================================ */
test('CAS12 : site.id est rigoureusement identique avant et après transfert', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  const before_ = (await request('GET', '/admin/sites/' + s.id)).body.id;
  const r = await transfer(s.id, fiat.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.site.id, before_);
  const after_ = (await request('GET', '/admin/sites/' + s.id)).body.id;
  assert.equal(after_, before_);
});

/* ============================================================ */
/*  Contrôles complémentaires — §1/§9/§14/§15 mission               */
/* ============================================================ */
test('§1 : un site avec des dépendances réelles reste bloqué pour la SUPPRESSION mais autorisé pour le TRANSFERT', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  await pool.query(`INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z')`, [s.id, dhl.id]);
  const del = await request('DELETE', '/admin/sites/' + s.id, { reason: 'test suppression' });
  assert.equal(del.status, 409, 'DELETE doit rester bloqué — comportement inchangé');
  const tr = await transfer(s.id, fiat.id);
  assert.equal(tr.status, 200, 'TRANSFERT doit réussir malgré la même dépendance — c\'est le cœur de la mission: ' + JSON.stringify(tr.body));
});

test('§9 : le motif est obligatoire ; groupe cible manquant ou identique au groupe actuel est refusé (400/409)', async () => {
  const dhl = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  assert.equal((await request('POST', '/admin/sites/' + s.id + '/transfer', { target_group_id: dhl.id })).status, 400, 'motif requis');
  assert.equal((await request('POST', '/admin/sites/' + s.id + '/transfer', { reason: 'x' })).status, 400, 'groupe cible requis');
  assert.equal((await transfer(s.id, dhl.id)).status, 409, 'transfert vers le même groupe refusé');
});

test('§9 : un groupe cible archivé est refusé (409) ; un site introuvable est un 404 propre', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  await request('PUT', '/admin/groups/' + fiat.id + '/status', { status: 'archived', reason: 'test' });
  assert.equal((await transfer(s.id, fiat.id)).status, 409);
  assert.equal((await transfer(randomUUID(), dhl.id)).status, 404);
});

test('§14 : GET /transfer-impact ne modifie rien (lecture seule) et reflète les compteurs réels', async () => {
  const dhl = await createGroup(); const fiat = await createGroup();
  const s = await createSite();
  await assignSite(dhl.id, s.id);
  await pool.query(`INSERT INTO public.zones(site_id,tenant_id,code,name) VALUES($1,$2,'z','Z')`, [s.id, dhl.id]);
  const before_ = await request('GET', '/admin/sites/' + s.id);
  const impact = await transferImpact(s.id, fiat.id);
  assert.equal(impact.status, 200);
  assert.equal(impact.body.zones_count, 1);
  assert.equal(impact.body.already_in_target, false);
  const after_ = await request('GET', '/admin/sites/' + s.id);
  assert.deepEqual(after_.body, before_.body, 'transfer-impact ne doit avoir aucun effet de bord');
});
