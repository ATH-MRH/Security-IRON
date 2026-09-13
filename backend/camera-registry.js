'use strict';
/**
 * PG-30 (correctif de sécurité, revue RC) — configuration SERVEUR, explicite,
 * des caméras que le proxy (backend/camera.js) est autorisé à joindre.
 *
 * Avant ce correctif, GET /api/camera/proxy et /stream acceptaient une URL
 * ARBITRAIRE fournie par le client (?src=...), sans authentification ni
 * périmètre — une SSRF non authentifiée exploitable pour atteindre
 * n'importe quelle adresse réseau joignable par le serveur. Ce registre est
 * désormais la SEULE source de vérité des destinations que le proxy peut
 * jamais contacter : le client ne transmet plus qu'un camera_id opaque,
 * jamais une URL, jamais des identifiants (voir docs/camera-proxy.md).
 *
 * Source : un fichier JSON local (SECURISITE_CAMERAS_CONFIG_FILE), jamais
 * committé, édité par un opérateur humain sur le serveur — pas une interface
 * web d'administration : aucun modèle de persistance caméra n'existe encore
 * dans ce code base, et en construire un ici (migration, table, routes CRUD)
 * dépasserait la portée de ce correctif de sécurité (« ne crée pas une
 * grosse architecture improvisée »). Variable absente ou fichier absent ->
 * registre VIDE -> le proxy refuse tout (fail-closed), jamais « ouvert par
 * défaut » comme avant ce correctif.
 *
 * Test-injectable via configure()/reset(), même idiome que
 * backend/ai/provider.js#configureProvider (déjà établi dans ce code base).
 */
const fs = require('node:fs');
const { assertAllowedTarget } = require('./ssrf-guard');

const URL_PROTOCOLS = { http: ['http:', 'https:'], rtsp: ['rtsp:'] };
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateEntry(entry, index) {
  const where = `camera[${index}]`;
  if (!entry || typeof entry !== 'object') throw new Error(`${where} : entrée invalide`);
  const { id, name, url, type, tenantId, siteId = null, zoneId = null,
    authUser = null, authPass = null, insecureTls = false, streamMode = 'snapshot' } = entry;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`${where} : id invalide`);
  if (typeof name !== 'string' || !name.trim()) throw new Error(`${where} : name requis`);
  if (type !== 'http' && type !== 'rtsp') throw new Error(`${where} : type doit être 'http' ou 'rtsp'`);
  // streamMode ne distingue rien côté sécurité (même route /proxy, mêmes
  // vérifications) — seulement une indication pour le frontend : une image
  // rafraîchie périodiquement ('snapshot', défaut) ou un flux MJPEG
  // maintenu ouvert en continu ('mjpeg'). Sans effet pour type='rtsp'
  // (toujours un flux continu via ffmpeg, /stream).
  if (streamMode !== 'snapshot' && streamMode !== 'mjpeg') throw new Error(`${where} : streamMode doit être 'snapshot' ou 'mjpeg'`);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${where} : url invalide`); }
  if (!URL_PROTOCOLS[type].includes(parsed.protocol)) {
    throw new Error(`${where} : protocole ${parsed.protocol} incompatible avec type=${type}`);
  }
  // Échoue tôt (au chargement, pas seulement à la première requête) si
  // l'admin a configuré une IP littérale déjà sur la liste refusée
  // (loopback/link-local/multicast) — un hostname ne peut pas être validé
  // ici (DNS non résolu au chargement) : la vérification autoritaire reste
  // celle faite à chaque requête par ssrf-guard.js#guardedLookup.
  try { assertAllowedTarget(parsed.hostname.replace(/^\[|\]$/g, '')); } // IPv6 littérale : URL la rend avec crochets ([::1])
  catch (e) { throw new Error(`${where} : ${e.message}`); }
  if (typeof tenantId !== 'string' || !tenantId) throw new Error(`${where} : tenantId requis`);
  if (siteId !== null && typeof siteId !== 'string') throw new Error(`${where} : siteId doit être une chaîne ou null`);
  if (zoneId !== null && typeof zoneId !== 'string') throw new Error(`${where} : zoneId doit être une chaîne ou null`);
  return Object.freeze({
    id, name: name.trim(), url, type, tenantId, siteId, zoneId,
    authUser: authUser || null, authPass: authPass || null, insecureTls: insecureTls === true,
    streamMode,
  });
}

function parseList(list) {
  if (!Array.isArray(list)) throw new Error('la configuration caméras doit être un tableau');
  const seen = new Set();
  return list.map((entry, i) => {
    const clean = validateEntry(entry, i);
    if (seen.has(clean.id)) throw new Error(`camera id dupliqué : ${clean.id}`);
    seen.add(clean.id);
    return clean;
  });
}

let cameras = null; // null = pas encore chargé depuis le fichier ; tableau = chargé (vide ou non)

function loadFromFile() {
  const file = process.env.SECURISITE_CAMERAS_CONFIG_FILE;
  if (!file) return [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // Fichier absent (ENOENT) : traité comme "aucune configuration",
    // exactement comme la variable elle-même absente — un déploiement qui
    // monte le volume caméra sans y avoir encore déposé cameras.json (cas
    // normal au premier déploiement, docs/production-coolify.md §12) ne
    // doit jamais faire échouer une requête, seulement rester fail-closed
    // (registre vide). Toute AUTRE erreur (permissions, chemin invalide
    // pointant vers un répertoire, etc.) reste un échec bruyant : une
    // configuration réellement cassée ne doit jamais se faire passer pour
    // "aucune caméra" silencieusement.
    if (e && e.code === 'ENOENT') return [];
    throw new Error(`SECURISITE_CAMERAS_CONFIG_FILE illisible (${file}) : ${e.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`SECURISITE_CAMERAS_CONFIG_FILE JSON invalide (${file}) : ${e.message}`); }
  return parseList(parsed);
}

// Test-injection uniquement : configure une liste en mémoire, jamais lue
// depuis le fichier tant que reset() n'est pas rappelé.
function configure(list) { cameras = parseList(list); }
// Revient au comportement de production : rechargera depuis
// SECURISITE_CAMERAS_CONFIG_FILE au prochain appel de all()/resolve().
function reset() { cameras = null; }
function all() { if (cameras === null) cameras = loadFromFile(); return cameras; }
function resolve(id) {
  if (typeof id !== 'string' || !id) return null;
  return all().find(c => c.id === id) || null;
}

module.exports = { configure, reset, all, resolve };
