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

const db     = require('./backend/database');
const auth   = require('./backend/auth');
const routes = require('./backend/routes');
const sync   = require('./backend/sync');
const camera = require('./backend/camera');
const alerts = require('./backend/alerts');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', auth.router);
app.use('/api/sync', sync);                       // serveur-à-serveur, clé partagée uniquement
app.use('/api/camera', camera);                   // proxy caméras IP (avant JWT : les <img> n'envoient pas de token)
app.use('/api/alerts', auth.authMiddleware, alerts.router);
app.use('/api', auth.authMiddleware, routes);

app.use(express.static(path.join(__dirname, 'frontend')));
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

/**
 * Démarre le serveur. Retourne une promesse résolue avec { server, port, stop }.
 * Ordre : readiness base → readiness schéma Alert Core → écoute HTTP → timer d'escalade.
 * Un échec de readiness rejette sans jamais ouvrir l'écoute ni programmer le timer.
 * @param {{ port?: number|string, host?: string }} opts
 */
function start(opts = {}) {
  const port = opts.port !== undefined ? opts.port : PORT;
  const host = opts.host; // undefined => toutes les interfaces
  return db.init()
    .then(() => alerts.init())            // lecture seule : catalogues + configuration id=1
    .then(() => new Promise((resolve, reject) => {
      const server = host
        ? app.listen(port, host, done)
        : app.listen(port, done);
      server.on('error', reject);
      function done() {
        const actual = server.address().port;
        console.log(`╔═══════════════════════════════════════════╗`);
        console.log(`║  SécuriSite SOC                           ║`);
        console.log(`║  http://localhost:${actual}                     ║`);
        console.log(`║  Identifiants démo : admin / securisite  ║`);
        console.log(`╚═══════════════════════════════════════════╝`);
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
        // Arrêt gracieux minimal : plus de nouveau cycle, on laisse finir le cycle
        // courant, on ferme l'écoute puis le pool. Idempotent.
        let closing = null;
        const stop = () => (closing ||= (stopping = true, clearInterval(escalationTimer), inflight
          .catch(() => {})
          .then(() => new Promise(closed => server.close(closed)))
          .then(() => db.close())
          .catch(() => {})));
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
