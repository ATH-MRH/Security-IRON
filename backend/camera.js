/**
 * Proxy caméras IP / réseau (sur site)
 * ------------------------------------
 * Le navigateur ne peut pas lire directement une caméra réseau (CORS, auth,
 * image « teintée » impossible à analyser en OCR). Le serveur local va donc
 * chercher l'image/le flux de la caméra et le retransmet à l'app, même origine.
 *
 * Supporté ici : snapshot JPEG et flux MJPEG en HTTP/HTTPS, avec auth Basic.
 * (RTSP + auth Digest : étape suivante via ffmpeg embarqué.)
 *
 * Monté AVANT le middleware JWT car une balise <img> ne peut pas envoyer de
 * token. L'app étant locale (LAN), le proxy ne sert qu'à joindre les caméras.
 */
const express = require('express');
const http  = require('http');
const https = require('https');
const { spawn } = require('child_process');

const router = express.Router();

/* Chemin du binaire ffmpeg (embarqué). En production Electron, il est
   « déballé » de l'asar → on remappe vers app.asar.unpacked. */
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch { /* ffmpeg non installé : RTSP indisponible */ }

// GET /api/camera/proxy?src=<url>&user=<u>&pass=<p>
router.get('/proxy', (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send('Paramètre "src" manquant');

  let target;
  try { target = new URL(src); } catch { return res.status(400).send('URL invalide'); }
  if (!/^https?:$/.test(target.protocol)) {
    return res.status(400).send('Seuls http/https sont supportés ici (RTSP à venir).');
  }

  const lib = target.protocol === 'https:' ? https : http;
  const headers = {};
  // Identifiants : soit dans l'URL (user:pass@host), soit en paramètres
  const user = req.query.user || target.username;
  const pass = req.query.pass || target.password;
  if (user) headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass || ''}`).toString('base64');

  const opts = {
    method: 'GET',
    headers,
    timeout: 8000,
    // Caméras à certificat auto-signé : ne pas rejeter
    rejectUnauthorized: false,
  };

  const preq = lib.request(target, opts, (pres) => {
    if (pres.statusCode && pres.statusCode >= 400) {
      // 401 = souvent auth Digest requise (non gérée ici pour l'instant)
      res.status(502);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const hint = pres.statusCode === 401
        ? "Caméra : authentification refusée (cette caméra utilise peut-être l'auth Digest, bientôt supportée)."
        : `Caméra : réponse HTTP ${pres.statusCode}.`;
      pres.resume();
      return res.end(hint);
    }
    if (pres.headers['content-type']) res.setHeader('Content-Type', pres.headers['content-type']);
    res.setHeader('Cache-Control', 'no-store');
    pres.pipe(res);
  });

  preq.on('timeout', () => { preq.destroy(); if (!res.headersSent) res.status(504).send('Délai dépassé (caméra injoignable).'); });
  preq.on('error', (e) => { if (!res.headersSent) res.status(502).send('Erreur caméra : ' + e.message); });
  preq.end();

  // Si le client ferme (changement de caméra), couper la requête amont
  req.on('close', () => preq.destroy());
});

// GET /api/camera/stream?src=rtsp://...&user=<u>&pass=<p>
// Convertit un flux RTSP en MJPEG (via ffmpeg) affichable par une <img>.
router.get('/stream', (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send('Paramètre "src" manquant');

  let target;
  try { target = new URL(src); } catch { return res.status(400).send('URL invalide'); }
  if (target.protocol !== 'rtsp:') return res.status(400).send('Cette route est réservée aux flux RTSP.');
  if (!ffmpegPath) return res.status(503).send('ffmpeg indisponible (RTSP non supporté sur cette installation).');

  // Identifiants : injectés dans l'URL RTSP si fournis et absents
  const user = req.query.user, pass = req.query.pass;
  if (user && !target.username) { target.username = encodeURIComponent(user); if (pass) target.password = encodeURIComponent(pass); }
  const url = target.toString();

  const args = [
    '-rtsp_transport', 'tcp',   // TCP = plus fiable que UDP sur un LAN chargé
    '-rw_timeout', '10000000',  // 10 s : échoue vite si la caméra est injoignable
    '-loglevel', 'error',
    '-i', url,
    '-an',                       // pas d'audio
    '-f', 'mpjpeg',
    '-q:v', '6',                 // qualité JPEG (2=meilleure … 31=pire)
    '-r', '10',                  // 10 images/s
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
      res.status(502).send('Flux RTSP illisible.\n' + (errbuf.trim() || 'Vérifiez l\'adresse, les identifiants et le réseau.'));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
});

module.exports = router;
