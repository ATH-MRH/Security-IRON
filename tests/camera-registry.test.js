'use strict';
// PG-30 (correctif de sécurité, revue RC) — backend/camera-registry.js en
// isolation, sans base de données : validation stricte au chargement
// (aucune caméra malformée ou pointant vers une destination interdite
// n'entre jamais dans le registre), fail-closed par défaut, et le contrat
// de test-injection (configure/reset), même idiome que backend/ai/provider.js.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../backend/camera-registry');

afterEach(() => registry.reset()); // un registre de test ne doit jamais fuiter d'un test à l'autre

test('sans SECURISITE_CAMERAS_CONFIG_FILE : registre vide, jamais "ouvert par défaut"', () => {
  delete process.env.SECURISITE_CAMERAS_CONFIG_FILE;
  assert.deepEqual(registry.all(), []);
  assert.equal(registry.resolve('anything'), null);
});

test('SECURISITE_CAMERAS_CONFIG_FILE pointant vers un fichier absent (volume monté, jamais encore rempli) : registre vide, jamais une erreur (Coolify, premier déploiement)', () => {
  const path = require('node:path');
  const os = require('node:os');
  process.env.SECURISITE_CAMERAS_CONFIG_FILE = path.join(os.tmpdir(), 'securisite-cameras-absent-' + Date.now() + '.json');
  assert.doesNotThrow(() => registry.all());
  assert.deepEqual(registry.all(), []);
  delete process.env.SECURISITE_CAMERAS_CONFIG_FILE;
});

test('SECURISITE_CAMERAS_CONFIG_FILE pointant vers un chemin réellement cassé (répertoire, pas un fichier) : échec bruyant, jamais confondu avec "absent"', () => {
  const os = require('node:os');
  process.env.SECURISITE_CAMERAS_CONFIG_FILE = os.tmpdir(); // un répertoire existe, mais n'est pas lisible comme fichier JSON
  assert.throws(() => registry.all(), /illisible/);
  delete process.env.SECURISITE_CAMERAS_CONFIG_FILE;
});

test('configure/resolve : une caméra valide est acceptée et retrouvable par id', () => {
  registry.configure([{ id: 'cam1', name: 'Entrée', type: 'http', tenantId: 't1', url: 'http://192.168.1.50/snap.jpg' }]);
  const cam = registry.resolve('cam1');
  assert.equal(cam.id, 'cam1');
  assert.equal(cam.name, 'Entrée');
  assert.equal(cam.tenantId, 't1');
  assert.equal(cam.siteId, null);
  assert.equal(cam.insecureTls, false);
});

test('id dupliqué rejeté', () => {
  assert.throws(() => registry.configure([
    { id: 'dup', name: 'a', type: 'http', tenantId: 't1', url: 'http://10.0.0.1/' },
    { id: 'dup', name: 'b', type: 'http', tenantId: 't1', url: 'http://10.0.0.2/' },
  ]), /dupliqué/);
});

test('id invalide (caractères hors [a-zA-Z0-9_-]) rejeté', () => {
  assert.throws(() => registry.configure([{ id: 'a b', name: 'x', type: 'http', tenantId: 't1', url: 'http://10.0.0.1/' }]));
});

test('name vide rejeté', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: '  ', type: 'http', tenantId: 't1', url: 'http://10.0.0.1/' }]));
});

test('type doit être http ou rtsp, rien d\'autre', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'ftp', tenantId: 't1', url: 'http://10.0.0.1/' }]));
});

test('url invalide (non parseable) rejetée', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'pas une url' }]));
});

test('protocole incompatible avec le type déclaré rejeté (http déclaré avec une url rtsp:// et inversement)', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'rtsp://10.0.0.1/stream' }]));
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'rtsp', tenantId: 't1', url: 'http://10.0.0.1/' }]));
});

test('tenantId requis', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: '', url: 'http://10.0.0.1/' }]));
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', url: 'http://10.0.0.1/' }]));
});

test('siteId/zoneId doivent être une chaîne ou null, jamais un autre type', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', siteId: 42, url: 'http://10.0.0.1/' }]));
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', zoneId: {}, url: 'http://10.0.0.1/' }]));
});

test('une IP littérale loopback/link-local/multicast est rejetée AU CHARGEMENT, jamais laissée pour la requête', () => {
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'http://127.0.0.1/' }]), /refusée/);
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'http://169.254.169.254/' }]), /refusée/);
  assert.throws(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'http://[::1]/' }]), /refusée/);
});

test('un hostname (pas une IP littérale) est accepté au chargement : la décision réseau revient à ssrf-guard à chaque requête', () => {
  assert.doesNotThrow(() => registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'http://camera.example.invalid/snap.jpg' }]));
});

test('authUser/authPass/insecureTls jamais absents d\'un enregistrement résolu, mais jamais non plus dans la liste publique (voir GET /api/camera/list, testé séparément)', () => {
  registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'http://10.0.0.1/', authUser: 'u', authPass: 'p', insecureTls: true }]);
  const cam = registry.resolve('x');
  assert.equal(cam.authUser, 'u');
  assert.equal(cam.authPass, 'p');
  assert.equal(cam.insecureTls, true);
});

test('la configuration doit être un tableau', () => {
  assert.throws(() => registry.configure({ id: 'x' }));
});

test('reset() revient au comportement de production (rechargement depuis SECURISITE_CAMERAS_CONFIG_FILE, vide si absente)', () => {
  registry.configure([{ id: 'x', name: 'x', type: 'http', tenantId: 't1', url: 'http://10.0.0.1/' }]);
  assert.ok(registry.resolve('x'));
  registry.reset();
  delete process.env.SECURISITE_CAMERAS_CONFIG_FILE;
  assert.equal(registry.resolve('x'), null);
});
