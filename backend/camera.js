'use strict';
/**
 * Proxy caméras IP / réseau (sur site) — PG-30 (correctif de sécurité,
 * revue RC) : réécriture complète après découverte d'une SSRF non
 * authentifiée.
 *
 * AVANT ce correctif : GET /api/camera/proxy?src=<url arbitraire> était
 * monté AVANT le middleware JWT (une balise <img> ne peut pas envoyer de
 * token), acceptait N'IMPORTE QUELLE URL http/https fournie par le client,
 * transmettait des identifiants Basic fournis par le client, désactivait la
 * vérification TLS (rejectUnauthorized:false) et reflétait la réponse
 * distante — une primitive SSRF non authentifiée exploitable pour atteindre
 * n'importe quelle adresse réseau joignable par le serveur (réseau interne,
 * métadonnées cloud). GET /api/camera/stream (RTSP via ffmpeg) partageait le
 * même défaut : une URL arbitraire non authentifiée.
 *
 * APRÈS : le client ne transmet plus jamais qu'un camera_id opaque —
 * jamais une URL, jamais des identifiants. Voir docs/camera-proxy.md pour
 * le modèle complet.
 *   1. Authentification : un ticket à usage unique (même mécanisme que
 *      backend/realtime.js, PG-12 — EventSource/<img> ne peuvent pas
 *      envoyer d'en-tête Authorization) obtenu via POST /ticket
 *      (authentifié normalement), ou un Bearer direct pour un client qui le
 *      peut. Un ticket est lié à un camera_id précis : impossible à
 *      rejouer sur une autre caméra.
 *   2. Autorisation : camera_id -> backend/camera-registry.js (config
 *      SERVEUR, jamais le client) -> tenant/site/zone de la caméra vérifié
 *      contre le périmètre réel de l'utilisateur (backend/scope.js) —
 *      exactement comme n'importe quelle autre ressource de ce code base.
 *      Caméra inconnue OU hors périmètre : même 404 (non-divulgation,
 *      cohérent avec le reste du code base).
 *   3. Destination réseau : jamais une valeur du client — l'URL, les
 *      identifiants et le choix TLS viennent uniquement de la
 *      configuration serveur. Défense en profondeur au niveau réseau
 *      (backend/ssrf-guard.js) même pour cette destination déjà
 *      allowlistée : loopback/link-local (métadonnées cloud
 *      incluses)/multicast/broadcast toujours refusés, RFC1918 toujours
 *      autorisé (une caméra vit légitimement sur un LAN privé).
 */
const express = require('express');
const http  = require('node:http');
const https = require('node:https');
const net   = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const auth = require('./auth');
const db = require('./database');
const scope = require('./scope');
const securityAudit = require('./security-audit');
const cameraRegistry = require('./camera-registry');
const ssrfGuard = require('./ssrf-guard');

const router = express.Router();

// Test-injectable (même idiome que backend/ssrf-guard.js#configureLookup) :
// permet à la suite SSRF de vérifier le plafond de taille sans transférer
// réellement 50 Mo à chaque exécution.
let MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // borne un flux MJPEG/snapshot runaway, généreux pour un usage normal
function configureMaxResponseBytes(n) { MAX_RESPONSE_BYTES = n; }
function resetMaxResponseBytes() { MAX_RESPONSE_BYTES = 50 * 1024 * 1024; }

/* Chemin du binaire ffmpeg (embarqué). En production Electron, il est
   « déballé » de l'asar → on remappe vers app.asar.unpacked. */
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch { /* ffmpeg non installé : RTSP indisponible */ }

// ── Tickets à usage unique, courte durée de vie, LIÉS à une caméra précise ──
// (même mécanisme que backend/realtime.js#issueTicket/consumeTicket, PG-12 —
// non réutilisé tel quel : un ticket caméra porte en plus le camera_id pour
// lequel il a été émis, pour qu'il ne puisse jamais être rejoué sur une
// autre caméra même par le même utilisateur.)
const TICKET_TTL_MS = 30000;
const tickets = new Map(); // ticket -> { userId, cameraId, expiresAt }
function issueTicket(userId, cameraId) {
  const ticket = randomUUID();
  tickets.set(ticket, { userId, cameraId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, expiresInMs: TICKET_TTL_MS };
}
function consumeTicket(ticket) {
  const entry = tickets.get(ticket);
  tickets.delete(ticket); // toujours retiré : usage unique par construction
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, entry] of tickets) if (entry.expiresAt < now) tickets.delete(t);
}, TICKET_TTL_MS).unref();

// ── Rate limit (même idiome que le SOS, backend/alerts.js) ──────────────────
const CAMERA_WINDOW_MS = 60 * 1000;
const CAMERA_MAX_PER_WINDOW = 120; // généreux pour un snapshot rafraîchi ~1 Hz + reconnexions MJPEG/RTSP
const cameraCounts = new Map(); // userId -> { count, windowStart }
function cameraLimited(userId) {
  const now = Date.now();
  const entry = cameraCounts.get(userId);
  if (!entry || now - entry.windowStart > CAMERA_WINDOW_MS) { cameraCounts.set(userId, { count: 1, windowStart: now }); return false; }
  entry.count++;
  return entry.count > CAMERA_MAX_PER_WINDOW;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cameraCounts) if (now - entry.windowStart > CAMERA_WINDOW_MS) cameraCounts.delete(key);
}, CAMERA_WINDOW_MS).unref();

function auditDenied(req, actorUserId, cameraId, reasonCode) {
  return securityAudit.recordBestEffort({
    requestId: req.requestId || null, origin: 'http', actorUserId: actorUserId ?? null,
    eventType: 'auth.access.denied', resourceType: 'camera', resourceId: cameraId || null, action: 'access', outcome: 'denied',
    ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
    detail: { reason_code: reasonCode },
  });
}

// Bearer direct (client qui peut envoyer un en-tête) OU ticket (image/vidéo,
// qui ne le peuvent pas) — même dualité que backend/realtime-routes.js.
async function resolveRequester(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { return { userId: auth.verifyToken(h.slice(7)).id, cameraId: null, ticketBound: false }; }
    catch { return null; }
  }
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
  if (!ticket) return null;
  const consumed = consumeTicket(ticket);
  if (!consumed) return null;
  return { userId: consumed.userId, cameraId: consumed.cameraId, ticketBound: true };
}

// Vérifie session (utilisateur toujours existant — même garde que
// backend/routes.js/backend/alerts.js) + périmètre réel pour cette caméra
// précise. Retourne la caméra si tout est en ordre, sinon null (l'appelant
// répond alors 404 — jamais 403 : ne pas confirmer qu'une caméra existe à
// quelqu'un hors périmètre, même convention que le reste du code base).
async function authorizeCamera(req, requester, cameraId) {
  if (requester.ticketBound && requester.cameraId !== cameraId) {
    await auditDenied(req, requester.userId, cameraId, 'ticket_camera_mismatch');
    return null;
  }
  const user = await db.get('SELECT id FROM users WHERE id=$1', [requester.userId]);
  if (!user) { await auditDenied(req, requester.userId, cameraId, 'session_revoked'); return null; }
  const camera = cameraRegistry.resolve(cameraId);
  if (!camera) { await auditDenied(req, requester.userId, cameraId, 'unknown_camera'); return null; }
  const userScope = await scope.resolveScope(requester.userId);
  if (!userScope.allows(camera.tenantId, camera.siteId, camera.zoneId)) {
    await auditDenied(req, requester.userId, cameraId, 'camera_not_covered');
    return null;
  }
  return camera;
}

// POST /api/camera/ticket  { camera_id }  — authentifié normalement (Bearer).
router.post('/ticket', auth.authMiddleware, async (req, res, next) => {
  try {
    const cameraId = typeof req.body?.camera_id === 'string' ? req.body.camera_id : null;
    if (!cameraId) return res.status(400).json({ error: 'camera_id requis' });
    const camera = await authorizeCamera(req, { userId: req.user.id, cameraId, ticketBound: false }, cameraId);
    if (!camera) return res.status(404).json({ error: 'Caméra introuvable' });
    const { ticket, expiresInMs } = issueTicket(req.user.id, cameraId);
    res.json({ ticket, expiresIn: Math.round(expiresInMs / 1000) });
  } catch (e) { next(e); }
});

// GET /api/camera/list — caméras visibles dans le périmètre de l'appelant.
// Jamais url/authUser/authPass : seulement de quoi peupler un sélecteur.
router.get('/list', auth.authMiddleware, async (req, res, next) => {
  try {
    const userScope = await scope.resolveScope(req.user.id);
    const visible = cameraRegistry.all()
      .filter(c => userScope.allows(c.tenantId, c.siteId, c.zoneId))
      .map(c => ({ id: c.id, name: c.name, type: c.type, streamMode: c.streamMode }));
    res.json(visible);
  } catch (e) { next(e); }
});

// GET /api/camera/proxy?camera_id=<id>&ticket=<ticket>  — snapshot JPEG /
// flux MJPEG en HTTP/HTTPS. Jamais de src/user/pass venant du client.
router.get('/proxy', async (req, res) => {
  const cameraId = typeof req.query.camera_id === 'string' ? req.query.camera_id : null;
  if (!cameraId) return res.status(400).send('camera_id requis');
  const requester = await resolveRequester(req);
  if (!requester) return res.status(401).send('Authentification requise');
  if (cameraLimited(requester.userId)) return res.status(429).send('Trop de requêtes caméra, réessayez plus tard.');
  const camera = await authorizeCamera(req, requester, cameraId);
  if (!camera || camera.type !== 'http') return res.status(404).send('Caméra introuvable');

  const target = new URL(camera.url); // config serveur uniquement, jamais le client
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  try { ssrfGuard.assertAllowedTarget(hostname); }
  catch { return res.status(502).send('Caméra injoignable.'); }

  const lib = target.protocol === 'https:' ? https : http;
  const headers = {};
  if (camera.authUser) headers['Authorization'] = 'Basic ' + Buffer.from(`${camera.authUser}:${camera.authPass || ''}`).toString('base64');

  const ALLOWED_CONTENT_TYPE = /^(image\/|multipart\/x-mixed-replace|video\/)/i;

  const opts = {
    method: 'GET',
    headers,
    timeout: 8000,
    lookup: ssrfGuard.guardedLookup, // pin la résolution réellement utilisée par la connexion (anti DNS rebinding)
    // TLS : vérifié par défaut ; seule une caméra explicitement marquée
    // insecureTls=true dans la configuration SERVEUR (jamais un paramètre
    // client) désactive la vérification, pour les certificats auto-signés
    // connus et acceptés par l'opérateur.
    rejectUnauthorized: !camera.insecureTls,
  };

  let total = 0, responded = false;
  const preq = lib.request(target, opts, (pres) => {
    if (pres.statusCode && pres.statusCode >= 400) {
      pres.resume();
      res.status(502);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(pres.statusCode === 401
        ? "Caméra : authentification refusée (cette caméra utilise peut-être l'auth Digest, bientôt supportée)."
        : `Caméra : réponse HTTP ${pres.statusCode}.`);
    }
    const contentType = pres.headers['content-type'] || '';
    if (!ALLOWED_CONTENT_TYPE.test(contentType)) {
      pres.resume();
      return res.status(502).send('Caméra : type de contenu inattendu.');
    }
    // Jamais d'en-têtes reflétés au-delà de Content-Type : pas de
    // Set-Cookie, pas de Location, rien d'autre de la réponse distante.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    responded = true;
    pres.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) { pres.destroy(); if (!res.writableEnded) res.end(); return; }
      if (!res.write(chunk)) pres.pause();
    });
    res.on('drain', () => pres.resume());
    pres.on('end', () => { if (!res.writableEnded) res.end(); });
    pres.on('error', () => { if (!res.writableEnded) res.end(); });
  });

  preq.on('timeout', () => { preq.destroy(); if (!res.headersSent) res.status(504).send('Délai dépassé (caméra injoignable).'); });
  preq.on('error', () => {
    if (res.headersSent || responded) return;
    // Jamais l'URL/IP interne/le message brut du système réseau : un message générique.
    res.status(502).send('Caméra injoignable.');
  });
  preq.end();

  req.on('close', () => preq.destroy());
});

// GET /api/camera/stream?camera_id=<id>&ticket=<ticket> — RTSP -> MJPEG (ffmpeg).
router.get('/stream', async (req, res) => {
  const cameraId = typeof req.query.camera_id === 'string' ? req.query.camera_id : null;
  if (!cameraId) return res.status(400).send('camera_id requis');
  const requester = await resolveRequester(req);
  if (!requester) return res.status(401).send('Authentification requise');
  if (cameraLimited(requester.userId)) return res.status(429).send('Trop de requêtes caméra, réessayez plus tard.');
  const camera = await authorizeCamera(req, requester, cameraId);
  if (!camera || camera.type !== 'rtsp') return res.status(404).send('Caméra introuvable');
  if (!ffmpegPath) return res.status(503).send('ffmpeg indisponible (RTSP non supporté sur cette installation).');

  const target = new URL(camera.url); // config serveur uniquement
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  try {
    if (net.isIP(hostname)) {
      ssrfGuard.assertAllowedTarget(hostname);
    } else {
      await new Promise((resolve, reject) => ssrfGuard.guardedLookup(hostname, {}, (err) => err ? reject(err) : resolve()));
    }
  } catch { return res.status(502).send('Caméra injoignable.'); }

  if (camera.authUser && !target.username) { target.username = encodeURIComponent(camera.authUser); if (camera.authPass) target.password = encodeURIComponent(camera.authPass); }
  const url = target.toString();

  const args = [
    '-rtsp_transport', 'tcp',
    '-rw_timeout', '10000000',
    '-loglevel', 'error',
    '-i', url,
    '-an',
    '-f', 'mpjpeg',
    '-q:v', '6',
    '-r', '10',
    'pipe:1',
  ];

  const ff = spawn(ffmpegPath, args);
  let started = false, errbuf = '';

  ff.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=ffmpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'close');
    }
    res.write(chunk);
  });
  ff.stderr.on('data', (d) => { errbuf += d.toString(); if (errbuf.length > 4000) errbuf = errbuf.slice(-2000); });

  ff.on('error', (e) => { if (!res.headersSent) res.status(500).send('ffmpeg : ' + e.message); });
  ff.on('close', () => {
    if (!started && !res.headersSent) {
      res.status(502).send('Flux RTSP illisible.\n' + (errbuf.trim() || 'Vérifiez le réseau.'));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
});

router.configureMaxResponseBytes = configureMaxResponseBytes;
router.resetMaxResponseBytes = resetMaxResponseBytes;
module.exports = router;
