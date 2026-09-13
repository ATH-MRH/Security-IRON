/**
 * SécuriSite — Serveur Express
 * Sert l'API REST + l'interface frontend statique
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Charger .env si présent (sans dépendance supplémentaire)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const PORT = process.env.PORT || 3000;

const db         = require('./backend/database');
const readiness  = require('./backend/db/postgresql/readiness');
const httpErrors = require('./backend/http-errors');
const auth       = require('./backend/auth');
const routes     = require('./backend/routes');
const sync       = require('./backend/sync');
const camera     = require('./backend/camera');
const alerts     = require('./backend/alerts');
const map        = require('./backend/map');
const realtimeRoutes = require('./backend/realtime-routes');
const push       = require('./backend/push');
const health     = require('./backend/health');
const { requestContext } = require('./backend/request-context');
const { observability } = require('./backend/observability');

// Plafond d'arrêt gracieux : au-delà, on ferme le pool même si un cycle traîne.
const SHUTDOWN_GRACE_MS = 10000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestContext()); // PG-10 : req.requestId, en-tête X-Request-Id — avant toute route.
app.use(observability());  // PG-18 : une ligne de log JSON structurée par requête — avant toute route.

app.use('/api', health);   // PG-18 : /api/health (liveness), /api/ready (readiness) — non authentifiées.
app.use('/api/auth', auth.router);
app.use('/api/sync', sync);                       // serveur-à-serveur, clé partagée uniquement
app.use('/api/camera', camera);                   // proxy caméras IP (avant JWT : les <img> n'envoient pas de token)
app.use('/api/alerts', auth.authMiddleware, alerts.router);
app.use('/api/map', auth.authMiddleware, map);           // PG-17 : lecture sites/zones géolocalisés (own/scope, RLS)
// PG-12 : /stream s'authentifie lui-même (Bearer ou ticket — EventSource ne
// peut pas envoyer d'en-tête) ; pas de auth.authMiddleware ici, il gérerait
// mal l'absence de Bearer sur une connexion EventSource légitime.
app.use('/api/realtime', realtimeRoutes);
app.use('/api', auth.authMiddleware, routes);

app.use(express.static(path.join(__dirname, 'frontend')));
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// Gestionnaire global : erreurs métier verbatim, transitoires PostgreSQL -> 503,
// tout le reste -> 500 « Erreur serveur ». Aucun message brut, SQL, table,
// contrainte, hôte ni identifiant n'est renvoyé ni journalisé (code seul).
app.use((err, req, res, next) => { // signature à 4 arguments : gestionnaire d'erreurs Express
  httpErrors.sendError(res, err, 'HTTP');
});

/**
 * Démarre le serveur. Retourne une promesse résolue avec { server, port, stop }.
 * Ordre : connexion base → attestation readiness (lecture seule) → écoute HTTP → timer.
 * Toute dérive de readiness rejette sans jamais ouvrir l'écoute ni programmer le timer.
 * @param {{ port?: number|string, host?: string, graceMs?: number }} opts
 */
function start(opts = {}) {
  const port = opts.port !== undefined ? opts.port : PORT;
  const host = opts.host; // undefined => toutes les interfaces
  const graceMs = opts.graceMs !== undefined ? opts.graceMs : SHUTDOWN_GRACE_MS;
  return db.init()
    .then(() => readiness.assertReady(db)) // registre, versions 001/002, 18 tables, config,
                                           // fonction/triggers append-only, privilèges runtime
    .then(() => push.init()) // PG-13 : abonne le fournisseur push (fake par défaut) au bus temps réel (PG-12)
    .then(() => new Promise((resolve, reject) => {
      const server = host
        ? app.listen(port, host, done)
        : app.listen(port, done);
      server.on('error', reject);
      function done() {
        const actual = server.address().port;
        console.log(`SécuriSite SOC — écoute sur http://localhost:${actual}`);
        // Timer async sans chevauchement : un cycle en cours (ou un arrêt demandé)
        // fait ignorer le tic suivant ; une erreur n'interrompt pas le timer.
        let running = false, stopping = false, inflight = Promise.resolve();
        const escalationTimer = setInterval(() => {
          if (running || stopping) return;
          running = true;
          inflight = Promise.resolve()
            .then(() => alerts.escalateDue())
            .catch(e => console.error('[ALERTS] escalade', e && (e.code || e.name) || 'erreur'))
            .finally(() => { running = false; });
        }, 1000);
        escalationTimer.unref();
        server.on('close', () => clearInterval(escalationTimer));
        // Arrêt gracieux borné : plus de nouveau cycle ; on attend le cycle courant
        // puis la fermeture de l'écoute, chacun plafonné par la même échéance ;
        // au-delà de graceMs on ferme le pool quand même. Idempotent.
        let closing = null;
        const stop = () => (closing ||= (async () => {
          stopping = true;
          clearInterval(escalationTimer);
          push.stop();
          let fired;
          const deadline = new Promise(res => { fired = setTimeout(res, graceMs); fired.unref(); });
          await Promise.race([inflight.catch(() => {}), deadline]);   // laisse finir le cycle courant
          await Promise.race([new Promise(closed => server.close(closed)), deadline]); // ferme l'écoute
          clearTimeout(fired);
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          await db.close().catch(() => {});                           // pool fermé en dernier
        })());
        resolve({ server, port: actual, stop });
      }
    }));
}

// Lancement direct en ligne de commande (node server.js)
if (require.main === module) {
  start().then(({ stop }) => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => { stop().finally(() => process.exit(0)); });
    }
  }).catch(err => {
    console.error('[FATAL] Initialisation PostgreSQL impossible :', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
