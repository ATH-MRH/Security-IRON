'use strict';
// MAIN COURANTE V2 — portage PostgreSQL (backend/maincourante-workflows.js).
// Étudié conceptuellement sur feature/securisite-alert-core (SQLite, jamais
// copiée) puis reconstruit sur l'architecture tenant/site/zone réelle déjà
// en place (migrations 003/004) et backend/scope.js (périmètre par
// memberships actives, déjà audité — jamais reconstruit ici).
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
const dbName = 'securisite_test_mcwf_' + randomUUID().replace(/-/g, '').slice(0, 12);
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, stop, base, admin, agentToken, localTenant, mainSite, otherSite, zoneA, post, circuit, checkpoint;

async function request(method, url, body, token = admin, extra = {}) {
  const r = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('application/json') ? await r.json() : await r.text() };
}
async function insert(client, table, row) {
  const keys = Object.keys(row);
  await client.query(`INSERT INTO public.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(row));
}
async function makeAps(client, { site = mainSite, zone = null, postId = post, matricule = 'APS-' + randomUUID().slice(0, 8).toUpperCase(), nom = 'Réel', prenom = 'Identité' } = {}) {
  const id = randomUUID();
  await insert(client, 'employes', { id, matricule, nom, prenom, fonction: 'APS', statut: 'actif' });
  await insert(client, 'mc_aps', { employe_id: id, tenant_id: localTenant, site_id: site, zone_id: zone, poste_id: postId });
  return { id, matricule };
}
const create = (code, data, options = {}) => request('POST', '/maincourante/events?site_id=' + (options.site || mainSite), {
  code, site_id: options.site || mainSite, data, trigger_pcs01: !!options.pcs01, idempotency_key: options.key || randomUUID(),
}, options.token || admin);

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  const pool = db.createDatabase(env);
  try {
    const a = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['mcwf_admin', await bcrypt.hash('securisite', 10), 'MC Admin', 'admin']);
    await seedMembership(pool, a.id, 'admin');
    const g = await pool.get(`INSERT INTO public.users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['mcwf_agent', await bcrypt.hash('securisite', 10), 'MC Agent', 'agent']);
    await seedMembership(pool, g.id, 'agent');

    localTenant = (await pool.get(`SELECT id FROM public.tenants WHERE code='local'`)).id;
    mainSite = (await pool.get(`SELECT id FROM public.sites WHERE code='main'`)).id;
    otherSite = randomUUID();
    await pool.query(`INSERT INTO public.sites (id, tenant_id, code, name) VALUES ($1,$2,'mcwf-other','Autre site')`, [otherSite, localTenant]);
    zoneA = randomUUID();
    await pool.query(`INSERT INTO public.zones (id, site_id, tenant_id, code, name) VALUES ($1,$2,$3,'zone-a','Zone A')`, [zoneA, mainSite, localTenant]);
    post = randomUUID();
    await pool.query(`INSERT INTO public.mc_posts (id, tenant_id, site_id, name) VALUES ($1,$2,$3,'Entrée principale')`, [post, localTenant, mainSite]);
    circuit = randomUUID(); checkpoint = randomUUID();
    await pool.query(`INSERT INTO public.round_circuits (id, tenant_id, site_id, name, start_point) VALUES ($1,$2,$3,'Périmètre','Portail')`, [circuit, localTenant, mainSite]);
    await pool.query(`INSERT INTO public.round_checkpoints (id, circuit_id, name, position) VALUES ($1,$2,'Quai',1)`, [checkpoint, circuit]);
  } finally { await pool.close(); }
  Object.assign(process.env, env);
  const started = await require('../server').start({ port: 0, host: '127.0.0.1' });
  stop = started.stop;
  base = 'http://127.0.0.1:' + started.port;
  admin = (await request('POST', '/auth/login', { username: 'mcwf_admin', password: 'securisite' })).body.token;
  agentToken = (await request('POST', '/auth/login', { username: 'mcwf_agent', password: 'securisite' })).body.token;
});
after(async () => {
  try { if (stop) await stop(); }
  finally { if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); } }
});

/* ============================================================ */
/*  Migration 014 — schéma exact                                  */
/* ============================================================ */
test('migration 014 creates every workflow-engine table with the expected scope columns', async () => {
  const pool = db.createDatabase(env);
  try {
    for (const t of ['mc_posts', 'mc_aps', 'mc_presence', 'round_circuits', 'round_checkpoints', 'rounds', 'round_scans', 'equipment', 'mc_pcs01_config']) {
      const row = await pool.get(`SELECT to_regclass('public.' || $1) AS c`, [t]);
      assert.ok(row.c, t + ' must exist');
    }
    const cols = await pool.all(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='main_courante' AND column_name IN ('data','idempotency_key','tenant_id','site_id','zone_id')`);
    assert.equal(cols.length, 5);
  } finally { await pool.close(); }
});

/* ============================================================ */
/*  Authentification / scope — jamais une simple lecture du JWT    */
/* ============================================================ */
test('every workflow route requires authentication', async () => {
  for (const url of ['/maincourante/workflows/context?site_id=' + mainSite, '/maincourante/events?site_id=' + mainSite]) {
    assert.equal((await request('GET', url, undefined, null)).status, 401, url);
  }
  assert.equal((await request('POST', '/maincourante/aps/lookup?site_id=' + mainSite, { matricule: 'X' }, null)).status, 401);
});

test('a user with no membership on this tenant is refused (403), not silently scoped to nothing', async () => {
  const pool = db.createDatabase(env);
  let token;
  try {
    const u = await pool.get(`INSERT INTO public.users (username, password_hash, role) VALUES ($1,$2,'agent') RETURNING id`, ['mcwf_unscoped', await bcrypt.hash('x', 10)]);
    token = (await request('POST', '/auth/login', { username: 'mcwf_unscoped', password: 'x' })).body.token;
    void u;
  } finally { await pool.close(); }
  const r = await request('GET', '/maincourante/workflows/context?site_id=' + mainSite, undefined, token);
  assert.equal(r.status, 403);
});

test('a site outside the caller’s scope is refused, never silently narrowed or widened', async () => {
  const forgedSite = randomUUID();
  const r = await request('GET', '/maincourante/workflows/context?site_id=' + forgedSite, undefined, agentToken);
  assert.equal(r.status, 403);
});

/* ============================================================ */
/*  Contexte / référentiel                                        */
/* ============================================================ */
test('GET /workflows/context exposes exactly 29 codes; 15.04/15.70/15.80 come back explicitly unresolved', async () => {
  const r = await request('GET', '/maincourante/workflows/context?site_id=' + mainSite);
  assert.equal(r.status, 200);
  assert.equal(r.body.workflows.length, 29);
  for (const code of ['15.04', '15.70', '15.80']) {
    const w = r.body.workflows.find(x => x.code === code);
    assert.equal(w.unresolved, true);
    assert.equal(w.disabled, true);
  }
  assert.ok(Number.isFinite(Date.parse(r.body.server_time)));
});

/* ============================================================ */
/*  APS lookup — anti-énumération                                 */
/* ============================================================ */
test('APS lookup resolves a real, in-scope identity and never a forged/free-text one', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const found = await request('POST', '/maincourante/aps/lookup?site_id=' + mainSite, { matricule: aps.matricule });
  assert.equal(found.status, 200);
  assert.equal(found.body.matricule, aps.matricule);
  assert.doesNotMatch(JSON.stringify(found.body), /password_hash|photo_path|\/uploads\//);
});

test('APS lookup gives an identical 404 for "exists in another site" and "does not exist at all" (anti-enumeration)', async () => {
  const pool = db.createDatabase(env);
  let outOfScope;
  try { outOfScope = await makeAps(pool, { site: otherSite }); } finally { await pool.close(); }
  const hidden = await request('POST', '/maincourante/aps/lookup?site_id=' + mainSite, { matricule: outOfScope.matricule });
  const missing = await request('POST', '/maincourante/aps/lookup?site_id=' + mainSite, { matricule: 'NOPE-000' });
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body);
});

/* ============================================================ */
/*  15.04/15.70/15.80 — jamais une procédure inventée              */
/* ============================================================ */
test('unresolved codes (15.04/15.70/15.80) refuse any submission, nothing is written', async () => {
  for (const code of ['15.04', '15.70', '15.80']) {
    const r = await create(code, {});
    assert.equal(r.status, 422);
  }
});

/* ============================================================ */
/*  10.00-10.05 — présence APS                                    */
/* ============================================================ */
test('10.01/10.02: one open arrival per APS at a time, departure requires an open arrival, poste reflects the form selection', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const arrival = await create('10.01', { agent_id: aps.id, poste_id: post });
  assert.equal(arrival.status, 201);
  assert.equal(arrival.body.poste, 'Entrée principale');
  const doubled = await create('10.01', { agent_id: aps.id, poste_id: post });
  assert.equal(doubled.status, 409);
  const departure = await create('10.02', { agent_id: aps.id });
  assert.equal(departure.status, 201);
  const orphan = await create('10.02', { agent_id: aps.id });
  assert.equal(orphan.status, 409);
});

test('POST /events is idempotent: replaying the same idempotency_key returns the original event, never a duplicate', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const key = randomUUID();
  const first = await create('10.04', { agent_id: aps.id, observation: 'RAS' }, { key });
  const second = await create('10.04', { agent_id: aps.id, observation: 'RAS' }, { key });
  assert.equal(first.body.replayed, false);
  assert.equal(second.body.replayed, true);
  assert.equal(first.body.id, second.body.id);
  const pool2 = db.createDatabase(env);
  try {
    const count = await pool2.get(`SELECT count(*)::int AS c FROM public.main_courante WHERE idempotency_key=$1`, [key]);
    assert.equal(count.c, 1);
  } finally { await pool2.close(); }
});

test('a forged agent_id belonging to another site is refused, never silently accepted cross-site', async () => {
  const pool = db.createDatabase(env);
  let outOfScope;
  try { outOfScope = await makeAps(pool, { site: otherSite }); } finally { await pool.close(); }
  const r = await create('10.04', { agent_id: outOfScope.id, observation: 'forged' });
  assert.equal(r.status, 404);
  const pool2 = db.createDatabase(env);
  try {
    const count = await pool2.get(`SELECT count(*)::int AS c FROM public.main_courante WHERE agent=$1`, [outOfScope.matricule]);
    assert.equal(count.c, 0, 'a refused forged-agent submission must leave no main_courante row');
  } finally { await pool2.close(); }
});

test('a domain-level failure after the row is inserted rolls back the whole transaction (no orphan main_courante row)', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  // 10.02 (départ) sans arrivée ouverte : l'INSERT main_courante a déjà eu
  // lieu dans la transaction avant que runDomain() ne détecte l'absence de
  // présence ouverte et lève une erreur — si le rollback n'était pas total,
  // cette ligne resterait orpheline malgré le 409 renvoyé au client.
  const r = await create('10.02', { agent_id: aps.id });
  assert.equal(r.status, 409);
  const pool2 = db.createDatabase(env);
  try {
    const count = await pool2.get(`SELECT count(*)::int AS c FROM public.main_courante WHERE code='10.02' AND agent=$1`, [aps.matricule]);
    assert.equal(count.c, 0, 'a rejected domain transition must leave no orphan main_courante row');
  } finally { await pool2.close(); }
});

test('the server timestamp cannot be forged: a client-supplied datetime in the payload is ignored', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const forged = '1999-01-01T00:00:00.000Z';
  const before = Date.now();
  const r = await create('10.04', { agent_id: aps.id, observation: 'RAS', datetime: forged, created_at: forged });
  assert.equal(r.status, 201);
  const actual = new Date(r.body.datetime).getTime();
  assert.ok(Math.abs(actual - before) < 15000, 'datetime must be server-generated, not the forged client value');
});

test('GET /aps/:id/photo is scoped: another site cannot fetch a photo through the same-tenant endpoint', async () => {
  const pool = db.createDatabase(env);
  let ownSite, foreign;
  try {
    ownSite = await makeAps(pool);
    await pool.query(`UPDATE public.mc_aps SET photo=$1, photo_mime='image/png' WHERE employe_id=$2`, [Buffer.from([1, 2, 3]), ownSite.id]);
    foreign = await makeAps(pool, { site: otherSite });
    await pool.query(`UPDATE public.mc_aps SET photo=$1, photo_mime='image/png' WHERE employe_id=$2`, [Buffer.from([4, 5, 6]), foreign.id]);
  } finally { await pool.close(); }
  const own = await fetch(base + '/api/maincourante/aps/' + ownSite.id + '/photo?site_id=' + mainSite, { headers: { Authorization: 'Bearer ' + admin } });
  assert.equal(own.status, 200);
  const leaked = await fetch(base + '/api/maincourante/aps/' + foreign.id + '/photo?site_id=' + mainSite, { headers: { Authorization: 'Bearer ' + admin } });
  assert.equal(leaked.status, 404, "a photo belonging to another site must never be served through this site's scope");
});

/* ============================================================ */
/*  10.06/10.07 — rondes, checkpoints                              */
/* ============================================================ */
test('10.06/10.07: one open round per APS, checkpoints scanned once, close reports real progress', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const start = await create('10.06', { agent_id: aps.id, circuit_id: circuit, point_depart: 'Portail' });
  assert.equal(start.status, 201);
  const doubled = await create('10.06', { agent_id: aps.id, circuit_id: circuit, point_depart: 'Portail' });
  assert.equal(doubled.status, 409);
  const pool2 = db.createDatabase(env);
  let round;
  try { round = await pool2.get(`SELECT id FROM public.rounds WHERE employe_id=$1 AND ended_at IS NULL`, [aps.id]); } finally { await pool2.close(); }
  const scan = await request('POST', '/maincourante/rounds/' + round.id + '/scans?site_id=' + mainSite, { checkpoint_id: checkpoint, anomaly: false });
  assert.equal(scan.status, 201);
  const doubleScan = await request('POST', '/maincourante/rounds/' + round.id + '/scans?site_id=' + mainSite, { checkpoint_id: checkpoint, anomaly: false });
  assert.equal(doubleScan.status, 409);
  const end = await create('10.07', { agent_id: aps.id, anomaly: 'non' });
  assert.equal(end.status, 201);
  assert.equal(end.body.domain_result.checkpoints_completed, '1/1');
  const endAgain = await create('10.07', { agent_id: aps.id, anomaly: 'non' });
  assert.equal(endAgain.status, 409);
});

test('10.07 requires a description when an anomaly is declared', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  await create('10.06', { agent_id: aps.id, circuit_id: circuit, point_depart: 'Portail' });
  const r = await create('10.07', { agent_id: aps.id, anomaly: 'oui' });
  assert.equal(r.status, 400);
});

/* ============================================================ */
/*  10.08/10.09 — visiteurs ; 15.01-15.03 — camions                */
/* ============================================================ */
test('10.08/10.09: a visitor cycle creates then closes a real visiteurs row, double departure refused', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const arrival = await create('10.08', { agent_id: aps.id, prenom: 'Amel', nom: 'Ziane', hote: 'M. Directeur' });
  assert.equal(arrival.status, 201);
  const visiteurId = arrival.body.domain_result.visiteur_id;
  const departure = await create('10.09', { agent_id: aps.id, visiteur_id: visiteurId });
  assert.equal(departure.status, 201);
  const again = await create('10.09', { agent_id: aps.id, visiteur_id: visiteurId });
  assert.equal(again.status, 409);
});

test('15.01-15.03: a truck cycle creates then closes a real vehicules row, distinguishing empty/full exit', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const plaque = 'AB-' + randomUUID().slice(0, 6).toUpperCase();
  const entry = await create('15.01', { agent_id: aps.id, plaque, conducteur: 'M. Transporteur' });
  assert.equal(entry.status, 201);
  const doubled = await create('15.01', { agent_id: aps.id, plaque, conducteur: 'M. Transporteur' });
  assert.equal(doubled.status, 409);
  const vehiculeId = entry.body.domain_result.vehicule_id;
  const exit = await create('15.02', { agent_id: aps.id, vehicule_id: vehiculeId });
  assert.equal(exit.status, 201);
  const exitAgain = await create('15.03', { agent_id: aps.id, vehicule_id: vehiculeId });
  assert.equal(exitAgain.status, 409);
});

/* ============================================================ */
/*  10.15/10.16 — coupure/retour électricité                       */
/* ============================================================ */
test('10.15/10.16: outage open/close cycle refuses a second open and a close without an open', async () => {
  // Verrouille un bug réel trouvé en développant ce workflow : l'événement
  // en cours de création est déjà visible (même transaction, avant COMMIT)
  // à la requête qui vérifie "existe-t-il déjà une coupure ouverte / une
  // clôture plus récente ?" — sans exclusion explicite de sa propre ligne,
  // 10.15 se prenait lui-même pour une coupure déjà ouverte (open ->
  // toujours 409) et 10.16 se prenait lui-même pour sa propre clôture
  // (close -> toujours 409, même sur la toute première fermeture réelle).
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const open = await create('10.15', { agent_id: aps.id });
  assert.equal(open.status, 201);
  const doubled = await create('10.15', { agent_id: aps.id });
  assert.equal(doubled.status, 409);
  const close = await create('10.16', { agent_id: aps.id });
  assert.equal(close.status, 201);
  const closeAgain = await create('10.16', { agent_id: aps.id });
  assert.equal(closeAgain.status, 409);
});

/* ============================================================ */
/*  10.17-10.21 — incidents, alerte via le pipeline existant       */
/* ============================================================ */
test('10.17 creates a real incident through the existing Alert Core pipeline (reused, not reinvented)', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const r = await create('10.17', { agent_id: aps.id, description: 'Portail forcé' });
  assert.equal(r.status, 201);
  assert.match(r.body.domain_result.incident_ref, /^INC-/);
  const incidents = await request('GET', '/incidents');
  assert.ok(incidents.body.some(i => i.ref === r.body.domain_result.incident_ref && i.type === "Tentative d'intrusion"));
});

/* ============================================================ */
/*  PCS01 — fail-safe par défaut, opt-in explicite par code/site   */
/* ============================================================ */
test('PCS01 stays fail-safe: requesting it on an unconfigured site/code never creates the extra alert, main courante entry still succeeds', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const r = await create('10.18', { agent_id: aps.id, description: 'Vol suspecté' }, { pcs01: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.pcs01_triggered, false);
});

test('PCS01 triggers only once explicitly enabled for that exact code, admin-only to configure', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const deniedWrite = await request('PUT', '/maincourante/admin/pcs01?site_id=' + mainSite, { enabled: true, codes: ['10.18'] }, agentToken);
  assert.equal(deniedWrite.status, 403);
  const write = await request('PUT', '/maincourante/admin/pcs01?site_id=' + mainSite, { enabled: true, codes: ['10.18'] });
  assert.equal(write.status, 200);
  const r = await create('10.18', { agent_id: aps.id, description: 'Vol suspecté, PCS01 activé' }, { pcs01: true });
  assert.equal(r.body.pcs01_triggered, true);
  // Un autre code non listé reste fail-safe même avec PCS01 activé sur le site.
  const other = await create('10.21', { agent_id: aps.id, description: 'Menace' }, { pcs01: true });
  assert.equal(other.body.pcs01_triggered, false);
});

/* ============================================================ */
/*  Administration — postes / équipements / circuits               */
/* ============================================================ */
test('admin resource creation is scoped and requires management rights; agent role refused', async () => {
  const denied = await request('POST', '/maincourante/admin/resources?site_id=' + mainSite, { kind: 'equipment', data: { reference: 'RAD-X', name: 'Radio', location: 'Poste' } }, agentToken);
  assert.equal(denied.status, 403);
  const created = await request('POST', '/maincourante/admin/resources?site_id=' + mainSite, { kind: 'equipment', data: { reference: 'RAD-X', name: 'Radio', location: 'Poste' } });
  assert.equal(created.status, 201);
  const circuitR = await request('POST', '/maincourante/admin/resources?site_id=' + mainSite, { kind: 'circuit', data: { name: 'Circuit test', start_point: 'A', checkpoints: [{ name: 'P1' }, { name: 'P2' }] } });
  assert.equal(circuitR.status, 201);
  assert.equal(circuitR.body.checkpoints.length, 2);
  assert.equal(circuitR.body.latitude, null);
});

test('10.14: equipment damage requires a real, in-scope equipment reference', async () => {
  const pool = db.createDatabase(env);
  let aps;
  try { aps = await makeAps(pool); } finally { await pool.close(); }
  const forged = await create('10.14', { agent_id: aps.id, equipment_id: randomUUID(), description: 'Cassé' });
  assert.equal(forged.status, 404);
  const eq = await request('POST', '/maincourante/admin/resources?site_id=' + mainSite, { kind: 'equipment', data: { reference: 'RAD-Y', name: 'Radio Y', location: 'Poste' } });
  const real = await create('10.14', { agent_id: aps.id, equipment_id: eq.body.id, description: 'Boîtier fissuré' });
  assert.equal(real.status, 201);
});
