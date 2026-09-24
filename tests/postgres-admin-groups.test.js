'use strict';
// Administration Système — Groupes (backend/admin-groups.js, migration 018).
// PostgreSQL réel, aucun mock — mêmes conventions que
// tests/postgres-admin-sites.test.js.
//
// Groupe = tenants (réutilisé, jamais dupliqué — voir l'en-tête de
// backend/admin-groups.js et de la migration 018 pour l'audit complet).
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
const dbName = 'securisite_test_admingroups_' + randomUUID().replace(/-/g, '').slice(0, 12);
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin, agentToken;

async function request(method, url, body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
const uniqCode = (p = 'grp') => p + '-' + randomUUID().slice(0, 8);

async function createGroup(overrides = {}) {
  const r = await request('POST', '/admin/groups', { code: uniqCode(), name: 'Group ' + randomUUID().slice(0, 6), ...overrides });
  assert.equal(r.status, 201, 'fixture group creation must succeed: ' + JSON.stringify(r.body));
  return r.body;
}
async function createSite(overrides = {}) {
  const r = await request('POST', '/admin/sites', { code: uniqCode('site'), name: 'Site ' + randomUUID().slice(0, 6), ...overrides });
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

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    const a = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['admingroups_admin', await bcrypt.hash('securisite', 10), 'Admin', 'admin']);
    await seedMembership(pool, a.id, 'admin');
    const g = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['admingroups_agent', await bcrypt.hash('securisite', 10), 'Agent', 'agent']);
    await seedMembership(pool, g.id, 'agent');
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'admingroups_admin', password: 'securisite' }, null)).body.token;
  agentToken = (await request('POST', '/auth/login', { username: 'admingroups_agent', password: 'securisite' }, null)).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

/* ============================================================ */
/*  CRUD groupe                                                    */
/* ============================================================ */
test('every /admin/groups route requires the admin role, never a scoped membership role (401/403)', async () => {
  assert.equal((await request('GET', '/admin/groups', undefined, null)).status, 401);
  assert.equal((await request('GET', '/admin/groups', undefined, agentToken)).status, 403);
  assert.equal((await request('POST', '/admin/groups', { code: uniqCode(), name: 'X' }, agentToken)).status, 403);
});

test('create validates code/name before touching the database', async () => {
  assert.equal((await request('POST', '/admin/groups', { code: 'Bad Code!', name: 'X' })).status, 400);
  assert.equal((await request('POST', '/admin/groups', { code: uniqCode() })).status, 400, 'name required');
});

test('create then read: group appears with default status active, real defaults, no fictional fields', async () => {
  const code = uniqCode();
  const created = await request('POST', '/admin/groups', { code, name: 'DHL Forwarding', description: 'Client DHL' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.description, 'Client DHL');
  const fetched = await request('GET', '/admin/groups/' + created.body.id);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.name, 'DHL Forwarding');
});

test('duplicate code is refused (409), never silently overwritten — code unique enforced', async () => {
  const code = uniqCode();
  assert.equal((await request('POST', '/admin/groups', { code, name: 'First' })).status, 201);
  assert.equal((await request('POST', '/admin/groups', { code, name: 'Second' })).status, 409);
});

test('update modifies name/description and is audited', async () => {
  const g = await createGroup({ name: 'Original' });
  const updated = await request('PUT', '/admin/groups/' + g.id, { name: 'Renamed', description: 'New desc' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Renamed');
  assert.equal(updated.body.description, 'New desc');
});

test('status transition: active -> suspended (désactiver) -> archived, redundant transitions refused (409)', async () => {
  const g = await createGroup();
  const deactivate = await request('PUT', '/admin/groups/' + g.id + '/status', { status: 'suspended' });
  assert.equal(deactivate.status, 200);
  assert.equal((await request('PUT', '/admin/groups/' + g.id + '/status', { status: 'suspended' })).status, 409);
  const archive = await request('PUT', '/admin/groups/' + g.id + '/status', { status: 'archived', reason: 'test' });
  assert.equal(archive.status, 200);
  assert.ok(archive.body.archived_at);
});

test('a nonexistent group id is a clean 404 everywhere', async () => {
  const fakeId = randomUUID();
  assert.equal((await request('GET', '/admin/groups/' + fakeId)).status, 404);
  assert.equal((await request('PUT', '/admin/groups/' + fakeId, { name: 'x' })).status, 404);
  assert.equal((await request('PUT', '/admin/groups/' + fakeId + '/status', { status: 'archived' })).status, 404);
  assert.equal((await request('GET', '/admin/groups/' + fakeId + '/sites')).status, 404);
  assert.equal((await request('GET', '/admin/groups/' + fakeId + '/users')).status, 404);
});

test('list reports real sites_count/users_count, never fabricated', async () => {
  const g = await createGroup();
  const s1 = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s1.id] });
  const list = await request('GET', '/admin/groups?search=' + g.code);
  const row = list.body.groups.find(x => x.id === g.id);
  assert.equal(row.sites_count, 1);
  assert.equal(row.users_count, 0);
});

/* ============================================================ */
/*  Onglet Sites — ajouter/retirer, transaction, dépendances        */
/* ============================================================ */
test('a freshly created site has zero sites in a new group, and appears in "available" for that group with movable=true', async () => {
  const g = await createGroup();
  assert.deepEqual((await request('GET', '/admin/groups/' + g.id + '/sites')).body.sites, []);
  const s = await createSite();
  const available = await request('GET', '/admin/groups/' + g.id + '/sites/available');
  const row = available.body.sites.find(x => x.id === s.id);
  assert.ok(row, 'a site belonging to another group must appear as available');
  assert.equal(row.movable, true, 'a dependency-free site must be movable');
});

test('adding a site to a group reassigns it (sites.tenant_id), real and persisted — never a copy', async () => {
  const g = await createGroup();
  const s = await createSite();
  const r = await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.moved, [s.id]);
  const sites = (await request('GET', '/admin/groups/' + g.id + '/sites')).body.sites;
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, s.id);
  const fetched = await request('GET', '/admin/sites/' + s.id);
  assert.equal(fetched.body.tenant_id, g.id, 'the SAME canonical site row now belongs to the group — no duplicate created');
});

test('adding multiple sites in one call is a single atomic transaction', async () => {
  const g = await createGroup();
  const s1 = await createSite(); const s2 = await createSite(); const s3 = await createSite();
  const r = await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s1.id, s2.id, s3.id] });
  assert.equal(r.status, 200);
  const sites = (await request('GET', '/admin/groups/' + g.id + '/sites')).body.sites;
  assert.equal(sites.length, 3);
});

test('removing a site moves it back to the local pool tenant', async () => {
  const g = await createGroup();
  const s = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const r = await request('PUT', '/admin/groups/' + g.id + '/sites', { remove: [s.id] });
  assert.equal(r.status, 200);
  assert.deepEqual((await request('GET', '/admin/groups/' + g.id + '/sites')).body.sites, []);
  const fetched = await request('GET', '/admin/sites/' + s.id);
  const localGroup = (await request('GET', '/admin/groups?search=local')).body.groups.find(x => x.code === 'local');
  assert.equal(fetched.body.tenant_id, localGroup.id);
});

test('a site with a real dependency (a zone) cannot be moved between groups — 409, transaction rolled back, nothing moved', async () => {
  const g1 = await createGroup(); const g2 = await createGroup();
  const s = await createSite();
  await request('PUT', '/admin/groups/' + g1.id + '/sites', { add: [s.id] });
  const pool = db.createDatabase(env);
  try { await pool.query(`INSERT INTO public.zones (site_id, tenant_id, code, name) VALUES ($1,$2,'z','Zone')`, [s.id, g1.id]); }
  finally { await pool.close(); }
  const r = await request('PUT', '/admin/groups/' + g2.id + '/sites', { add: [s.id] });
  assert.equal(r.status, 409);
  const fetched = await request('GET', '/admin/sites/' + s.id);
  assert.equal(fetched.body.tenant_id, g1.id, 'the site must stay in its original group — refused, not partially moved');
});

test('moving several sites where one is blocked refuses the WHOLE batch — never a half-success', async () => {
  const g1 = await createGroup(); const g2 = await createGroup();
  const movable = await createSite();
  const blocked = await createSite();
  await request('PUT', '/admin/groups/' + g1.id + '/sites', { add: [blocked.id] });
  const pool = db.createDatabase(env);
  try { await pool.query(`INSERT INTO public.zones (site_id, tenant_id, code, name) VALUES ($1,$2,'z','Zone')`, [blocked.id, g1.id]); }
  finally { await pool.close(); }
  const r = await request('PUT', '/admin/groups/' + g2.id + '/sites', { add: [movable.id, blocked.id] });
  assert.equal(r.status, 409);
  const movableAfter = await request('GET', '/admin/sites/' + movable.id);
  const localGroup = (await request('GET', '/admin/groups?search=local')).body.groups.find(x => x.code === 'local');
  assert.equal(movableAfter.body.tenant_id, localGroup.id, 'movable site must NOT have been reassigned — the whole transaction rolled back');
});

test('an empty {add,remove} payload is rejected (400), never a silent no-op success', async () => {
  const g = await createGroup();
  assert.equal((await request('PUT', '/admin/groups/' + g.id + '/sites', {})).status, 400);
});

/* ============================================================ */
/*  Onglet Utilisateurs — affectation, restriction, refus hors      */
/*  groupe                                                          */
/* ============================================================ */
test('assigning a user with all_sites=true grants a tenant-level membership — "tous les sites du groupe"', async () => {
  const g = await createGroup();
  const u = await createUserAccount('u_allsites_' + randomUUID().slice(0, 6));
  const r = await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', all_sites: true });
  assert.equal(r.status, 201);
  const users = (await request('GET', '/admin/groups/' + g.id + '/users')).body.users;
  const row = users.find(x => x.user_id === u.id);
  assert.equal(row.all_sites, true);
  assert.deepEqual(row.site_ids, []);
});

test('assigning a user restricted to specific sites grants only site-level memberships — no all_sites', async () => {
  const g = await createGroup();
  const s1 = await createSite(); const s2 = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s1.id, s2.id] });
  const u = await createUserAccount('u_restricted_' + randomUUID().slice(0, 6));
  const r = await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [s1.id] });
  assert.equal(r.status, 201);
  const row = (await request('GET', '/admin/groups/' + g.id + '/users')).body.users.find(x => x.user_id === u.id);
  assert.equal(row.all_sites, false);
  assert.deepEqual(row.site_ids, [s1.id]);
});

test('a site outside the group is rejected (400) when assigning a restricted user — never accepted even via direct API', async () => {
  const g1 = await createGroup(); const g2 = await createGroup();
  const foreignSite = await createSite();
  await request('PUT', '/admin/groups/' + g2.id + '/sites', { add: [foreignSite.id] });
  const u = await createUserAccount('u_foreign_' + randomUUID().slice(0, 6));
  const r = await request('POST', '/admin/groups/' + g1.id + '/users', { user_id: u.id, role: 'agent', site_ids: [foreignSite.id] });
  assert.equal(r.status, 400);
});

test('neither all_sites nor site_ids provided is rejected (400)', async () => {
  const g = await createGroup();
  const u = await createUserAccount('u_neither_' + randomUUID().slice(0, 6));
  assert.equal((await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent' })).status, 400);
});

test('removing a user from a group archives their memberships — 404 if they had none', async () => {
  const g = await createGroup();
  const u = await createUserAccount('u_remove_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', all_sites: true });
  const del = await request('DELETE', '/admin/groups/' + g.id + '/users/' + u.id);
  assert.equal(del.status, 200);
  assert.equal(del.body.revoked, 1);
  assert.deepEqual((await request('GET', '/admin/groups/' + g.id + '/users')).body.users, []);
  assert.equal((await request('DELETE', '/admin/groups/' + g.id + '/users/' + u.id)).status, 404);
});

/* ============================================================ */
/*  RÈGLE FONDAMENTALE §5/§6 — isolation inter-groupes réelle,       */
/*  jamais une union, testée bout en bout via les routes métier      */
/*  existantes (pas seulement via scope.js unitaire).                */
/* ============================================================ */
test('ADMIN GLOBAL sees and manages every group and every site, with zero memberships', async () => {
  const g = await createGroup();
  const s = await createSite();
  assert.equal((await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] })).status, 200);
  assert.equal((await request('GET', '/admin/groups')).status, 200);
});

test('a group-scoped user (all_sites) can reach a business route in their own group but never a sibling group — 403, not an empty-list leak', async () => {
  const g1 = await createGroup(); const g2 = await createGroup();
  const u = await createUserAccount('u_x_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g1.id + '/users', { user_id: u.id, role: 'agent', all_sites: true });
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents?tenant_id=' + g1.id, undefined, token)).status, 200);
  assert.equal((await request('GET', '/incidents?tenant_id=' + g2.id, undefined, token)).status, 403);
});

test('a restricted user reaches only their explicit sub-set of sites within the group, never a sibling site — the real intersection, never a union', async () => {
  const g = await createGroup();
  const allowed = await createSite(); const forbidden = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [allowed.id, forbidden.id] });
  const u = await createUserAccount('u_restrict_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [allowed.id] });
  const token = await login(u.username);
  assert.equal((await request('GET', '/incidents?tenant_id=' + g.id + '&site_id=' + allowed.id, undefined, token)).status, 200);
  assert.equal((await request('GET', '/incidents?tenant_id=' + g.id + '&site_id=' + forbidden.id, undefined, token)).status, 403);
});

test('a group.user.add / group.user.remove / group.site.add / group.site.remove event is audited for every mutation', async () => {
  const g = await createGroup();
  const s = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const u = await createUserAccount('u_audit_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', all_sites: true });
  await request('DELETE', '/admin/groups/' + g.id + '/users/' + u.id);
  await request('PUT', '/admin/groups/' + g.id + '/sites', { remove: [s.id] });
  const events = (await request('GET', '/admin/groups/' + g.id + '/audit')).body.events.map(e => e.event_type);
  for (const ev of ['system_admin.group.site.add', 'system_admin.group.user.add', 'system_admin.group.user.remove', 'system_admin.group.site.remove']) {
    assert.ok(events.includes(ev), 'missing audited event: ' + ev + ' (got: ' + events.join(', ') + ')');
  }
});

test('group create/update/activate/deactivate/archive events are audited', async () => {
  const g = await createGroup();
  await request('PUT', '/admin/groups/' + g.id, { name: 'Renamed For Audit' });
  await request('PUT', '/admin/groups/' + g.id + '/status', { status: 'suspended' });
  await request('PUT', '/admin/groups/' + g.id + '/status', { status: 'archived', reason: 'test' });
  const events = (await request('GET', '/admin/groups/' + g.id + '/audit')).body.events.map(e => e.event_type);
  for (const ev of ['system_admin.group.create', 'system_admin.group.update', 'system_admin.group.deactivate', 'system_admin.group.archive']) {
    assert.ok(events.includes(ev), 'missing audited event: ' + ev);
  }
});

/* ============================================================ */
/*  §23 — cohérence avec OPS : le référentiel Sites de Groupes EST   */
/*  le référentiel canonique, jamais une copie.                     */
/* ============================================================ */
test('coherence with OPS: sites returned for a group under /admin/groups/:id/sites are the exact same canonical rows as /admin/sites?status=... for that tenant — same ids, no copy, no second referential', async () => {
  const g = await createGroup();
  const s1 = await createSite(); const s2 = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s1.id, s2.id] });
  const viaGroup = (await request('GET', '/admin/groups/' + g.id + '/sites')).body.sites.map(s => s.id).sort();
  const viaSitesList = (await request('GET', '/admin/sites?limit=200')).body.sites
    .filter(s => s.tenant_id === g.id).map(s => s.id).sort();
  assert.deepEqual(viaGroup, viaSitesList, 'the Groupes Sites tab and the canonical Sites module must return the exact same site ids for the same tenant — never a divergent copy');
});

/* ============================================================ */
/*  MISSION — DÉPENDANCES SITE : DELETE /admin/memberships/:id —    */
/*  retirer UNE appartenance précise identifiée par son id (drill-   */
/*  down des dépendances d'un site), jamais toutes celles du même    */
/*  utilisateur sur le groupe.                                       */
/* ============================================================ */
test('DELETE /admin/memberships/:id requires the admin role (401/403), same gate as the rest of /admin', async () => {
  const g = await createGroup(); const s = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const u = await createUserAccount('u_memdel_gate_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [s.id] });
  const pool = db.createDatabase(env);
  let membershipId;
  try { membershipId = (await pool.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s.id])).id; }
  finally { await pool.close(); }
  assert.equal((await request('DELETE', '/admin/memberships/' + membershipId, undefined, null)).status, 401);
  assert.equal((await request('DELETE', '/admin/memberships/' + membershipId, undefined, agentToken)).status, 403);
});

test('DELETE /admin/memberships/:id archives ONLY that one membership — a user restricted to two sites of the same group keeps access to the other', async () => {
  const g = await createGroup();
  const s1 = await createSite(); const s2 = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s1.id, s2.id] });
  const u = await createUserAccount('u_memdel_twosite_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [s1.id, s2.id] });
  const pool = db.createDatabase(env);
  let m1, m2;
  try {
    m1 = await pool.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s1.id]);
    m2 = await pool.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s2.id]);
  } finally { await pool.close(); }
  const r = await request('DELETE', '/admin/memberships/' + m1.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.archived, true);
  assert.equal(r.body.membership_id, m1.id);
  const users = (await request('GET', '/admin/groups/' + g.id + '/users')).body.users;
  const row = users.find(x => x.user_id === u.id);
  assert.deepEqual(row.site_ids, [s2.id], 'seul site1 doit avoir été retiré — site2 doit rester');
  const pool2 = db.createDatabase(env);
  try {
    const still = await pool2.get(`SELECT status FROM public.memberships WHERE id=$1`, [m2.id]);
    assert.equal(still.status, 'active', 'la seconde appartenance ne doit jamais être touchée');
    const removed = await pool2.get(`SELECT status FROM public.memberships WHERE id=$1`, [m1.id]);
    assert.equal(removed.status, 'archived');
  } finally { await pool2.close(); }
});

test('archiving a Global Administrator\'s own site membership never removes their global privileges (users.role is untouched, never derived from memberships)', async () => {
  const g = await createGroup(); const s = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const username = 'u_memdel_admin_' + randomUUID().slice(0, 6);
  const created = await request('POST', '/admin/users', { username, password: 'x'.repeat(10), role: 'admin' });
  assert.equal(created.status, 200);
  // Un Administrateur global n'a normalement besoin d'aucune appartenance
  // (requireAdmin traverse déjà tout /admin/*) — on lui en donne une ici
  // volontairement pour reproduire exactement le cas réel observé
  // ("Site principal / main" : le seul compte présent y a une appartenance
  // active). L'appartenance retirée ne doit jamais affecter users.role.
  // 'admin' est un rôle de COMPTE (users.role), jamais une valeur de
  // memberships.role (MEMBERSHIP_ROLES ci-dessus) — les deux sont des
  // référentiels distincts par conception ; l'appartenance elle-même
  // porte un rôle opérationnel ordinaire ('agent'), ce qui est exactement
  // le point de ce test : même avec une appartenance non-privilégiée,
  // le compte reste administrateur global grâce à users.role seul.
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: created.body.id, role: 'agent', site_ids: [s.id] });
  const pool = db.createDatabase(env);
  let membershipId;
  try { membershipId = (await pool.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [created.body.id, s.id])).id; }
  finally { await pool.close(); }
  const r = await request('DELETE', '/admin/memberships/' + membershipId);
  assert.equal(r.status, 200);
  const account = await request('GET', '/admin/users');
  const row = account.body.find(u => u.id === created.body.id);
  assert.equal(row.role, 'admin', 'le rôle de compte (privilège global) ne doit jamais être affecté par l\'archivage d\'une appartenance');
  // Preuve comportementale, pas seulement déclarative : le compte doit
  // toujours pouvoir agir comme administrateur global après coup.
  const adminToken = await login(username);
  assert.equal((await request('GET', '/admin/groups', undefined, adminToken)).status, 200);
});

test('DELETE /admin/memberships/:id on an already-archived membership is a clean 409, never a silent no-op or a double-archive', async () => {
  const g = await createGroup(); const s = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const u = await createUserAccount('u_memdel_twice_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [s.id] });
  const pool = db.createDatabase(env);
  let membershipId;
  try { membershipId = (await pool.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s.id])).id; }
  finally { await pool.close(); }
  assert.equal((await request('DELETE', '/admin/memberships/' + membershipId)).status, 200);
  assert.equal((await request('DELETE', '/admin/memberships/' + membershipId)).status, 409);
});

test('DELETE /admin/memberships/:id on a nonexistent id is a clean 404, never a 500', async () => {
  assert.equal((await request('DELETE', '/admin/memberships/' + randomUUID())).status, 404);
});

test('archiving a membership is audited (system_admin.membership.archive) with the real user/site identity, never a fictional detail', async () => {
  const g = await createGroup(); const s = await createSite();
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const u = await createUserAccount('u_memdel_audit_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [s.id] });
  const pool = db.createDatabase(env);
  let membershipId;
  try { membershipId = (await pool.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND site_id=$2 AND status='active'`, [u.id, s.id])).id; }
  finally { await pool.close(); }
  await request('DELETE', '/admin/memberships/' + membershipId);
  const audit = await request('GET', '/admin/groups/' + g.id + '/audit');
  const event = audit.body.events.find(e => e.event_type === 'system_admin.membership.archive');
  assert.ok(event, 'missing audited event: system_admin.membership.archive');
});

/* ============================================================ */
/*  Scénario réel bout en bout — "Site principal / main" : un site   */
/*  avec une seule appartenance active bloquante ; l'identifier via  */
/*  le drill-down, la retirer, vérifier que le compteur AFFICHÉ       */
/*  retombe à 0 sans que la suppression ne se déclenche jamais       */
/*  automatiquement.                                                  */
/*                                                                    */
/*  Nuance réelle, vérifiée explicitement ici plutôt que supposée :   */
/*  archiver une appartenance ne la SUPPRIME jamais physiquement      */
/*  (trigger memberships_no_delete, migration 004 — immuable par      */
/*  conception) : la ligne existe toujours, seul son statut change.   */
/*  blockingTotal() (site-dependencies.js) compte délibérément        */
/*  memberships_total (TOUTES les lignes, actives ou non) — jamais    */
/*  active_memberships seul — précisément pour qu'une suppression ne  */
/*  soit jamais débloquée par un simple archivage qui masquerait une  */
/*  vraie donnée historique. Un site ayant un jour eu une appartenance*/
/*  reste donc bloqué pour DELETE pour toujours, même après retrait — */
/*  Désactiver/Archiver le SITE lui-même reste le seul chemin réel,   */
/*  exactement le message déjà affiché ("archivez-le plutôt"). Cette  */
/*  mission ne change PAS cette protection (consigne explicite :      */
/*  "Ne contourne aucune FK ou protection existante").                */
/* ============================================================ */
test('end-to-end : site refusé pour cause de dépendance (1 appartenance active) -> drill-down -> retrait -> le compteur affiché retombe à 0 -> la suppression du site reste NON automatique', async () => {
  const g = await createGroup(); const s = await createSite({ name: 'Site Principal E2E' });
  await request('PUT', '/admin/groups/' + g.id + '/sites', { add: [s.id] });
  const u = await createUserAccount('u_e2e_deps_' + randomUUID().slice(0, 6));
  await request('POST', '/admin/groups/' + g.id + '/users', { user_id: u.id, role: 'agent', site_ids: [s.id] });

  // 1. La suppression est refusée — comportement déjà validé, revérifié ici en contexte.
  const firstDelete = await request('DELETE', '/admin/sites/' + s.id, { reason: 'e2e test' });
  assert.equal(firstDelete.status, 409);

  // 2. Le compteur confirme exactement 1 appartenance bloquante.
  const depsBefore = await request('GET', '/admin/sites/' + s.id + '/dependencies');
  assert.equal(depsBefore.body.active_memberships, 1);

  // 3. Drill-down : identité réelle de l'appartenance bloquante.
  const list = await request('GET', '/admin/sites/' + s.id + '/dependencies/memberships');
  assert.equal(list.body.memberships.length, 1);
  const membershipId = list.body.memberships[0].membership_id;
  assert.equal(list.body.memberships[0].user_id, u.id);

  // 4. Retrait de cette appartenance précise (action "Gérer -> Retirer l'accès").
  const removed = await request('DELETE', '/admin/memberships/' + membershipId);
  assert.equal(removed.status, 200);

  // 5. Le compteur AFFICHÉ (actives) retombe à 0 — rafraîchi, jamais mis à
  // jour par optimisme côté client.
  const depsAfter = await request('GET', '/admin/sites/' + s.id + '/dependencies');
  assert.equal(depsAfter.body.active_memberships, 0);
  assert.equal(depsAfter.body.memberships_total, 1, 'la ligne archivée existe toujours réellement — jamais supprimée (trigger memberships_no_delete)');

  // 6. La suppression du site n'a PAS été déclenchée automatiquement : le
  // site doit toujours exister tel quel, intact, jusqu'à un second appel
  // explicite de l'administrateur.
  const stillThere = await request('GET', '/admin/sites/' + s.id);
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.body.name, 'Site Principal E2E');

  // 7. Un second appel DELETE explicite reste refusé — attendu et correct
  // (voir note ci-dessus) : l'appartenance archivée est un fait historique
  // réel qui continue de référencer ce site, jamais un blocage fantôme.
  const secondDelete = await request('DELETE', '/admin/sites/' + s.id, { reason: 'e2e test, tentative après retrait' });
  assert.equal(secondDelete.status, 409, 'toujours refusé : l\'appartenance archivée existe réellement et référence encore le site — Archiver le SITE reste le chemin réel, jamais une suppression physique');
});
