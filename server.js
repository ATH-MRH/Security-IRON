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

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', auth.router);
app.use('/api/sync', sync);                       // serveur-à-serveur, clé partagée uniquement
app.use('/api', auth.authMiddleware, routes);

app.use(express.static(path.join(__dirname, 'frontend')));
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`╔═══════════════════════════════════════════╗`);
    console.log(`║  SécuriSite SOC                           ║`);
    console.log(`║  http://localhost:${PORT}                      ║`);
    console.log(`║  Identifiants démo : admin / securisite  ║`);
    console.log(`╚═══════════════════════════════════════════╝`);
  });
}).catch(err => {
  console.error('[FATAL] Connexion PostgreSQL impossible :', err.message);
  process.exit(1);
});
