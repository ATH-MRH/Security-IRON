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

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', auth.router);
app.use('/api/sync', sync);                       // serveur-à-serveur, clé partagée uniquement
app.use('/api/camera', camera);                   // proxy caméras IP (avant JWT : les <img> n'envoient pas de token)
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
 * Démarre le serveur. Retourne une promesse résolue avec { server, port }.
 * @param {{ port?: number|string, host?: string }} opts
 */
function start(opts = {}) {
  const port = opts.port !== undefined ? opts.port : PORT;
  const host = opts.host; // undefined => toutes les interfaces
  return db.init().then(() => new Promise((resolve, reject) => {
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
      resolve({ server, port: actual });
    }
  }));
}

// Lancement direct en ligne de commande (node server.js)
if (require.main === module) {
  start().catch(err => {
    console.error('[FATAL] Initialisation de la base SQLite impossible :', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
