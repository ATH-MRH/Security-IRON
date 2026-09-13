'use strict';
// PG-30 (correctif de sécurité, revue RC) — frontend/js/app.js portait la
// cause racine, côté produit, de la SSRF de backend/camera.js : n'importe
// quel utilisateur pouvait saisir une URL/des identifiants de caméra
// arbitraires (ajouterCameraIp(), stockés en localStorage via getIpCams/
// setIpCams), transmis tels quels au proxy serveur (?src=<url>) — un vrai
// canal d'exploitation, pas seulement un défaut backend isolé.
//
// app.js est un monolithe DOM de 1000+ lignes sans harnais de sandbox
// existant (voir tests/frontend-xss-hardening.test.js, même limite) — une
// garde de régression au niveau source est le bon outil ici : elle échoue
// bruyamment si le motif dangereux réapparaît, et ne passe que si le
// remplacement sûr (camera_id + ticket, jamais d'URL/identifiant côté
// client) est réellement en place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');

test('the client-side arbitrary camera URL feature is entirely gone, not just hidden', () => {
  assert.doesNotMatch(source, /ajouterCameraIp/, 'the "add an IP camera by typing any URL" flow was the SSRF\'s product-level root cause');
  assert.doesNotMatch(source, /supprimerCameraIp/);
  assert.doesNotMatch(source, /getIpCams|setIpCams/, 'cameras must never again be a client-local, self-service, arbitrary-URL list');
  assert.doesNotMatch(source, /__addip__/);
  assert.doesNotMatch(source, /securisite_ipcams/, 'no leftover localStorage key for the removed feature');
});

test('the proxy/stream URL is built only from a server-issued camera_id + ticket, never src/user/pass', () => {
  assert.match(source, /camera_id.*ticket|ticket.*camera_id/s);
  assert.doesNotMatch(source, /URLSearchParams\(\{\s*src:/, 'no more client-supplied src= built for the proxy');
  assert.doesNotMatch(source, /p\.set\(['"]user['"]/);
  assert.doesNotMatch(source, /p\.set\(['"]pass['"]/);
});

test('camera list and ticket are fetched from the server, never invented client-side', () => {
  assert.match(source, /API\.get\(['"]\/camera\/list['"]\)/);
  assert.match(source, /API\.post\(['"]\/camera\/ticket['"]/);
});

test('the camera picker renders id/name from ipCamsCache (server data), always escaped', () => {
  assert.match(source, /escapeHtml\(c\.id\)/);
  assert.match(source, /escapeHtml\(c\.name\)/);
});

test('activerCameraIp resolves the camera by server-issued id, never re-reads a client-supplied url/user/pass', () => {
  assert.match(source, /function activerCameraIp\(camId\)/);
  assert.doesNotMatch(source, /cam\.url|cam\.user|cam\.pass/);
});
