'use strict';
/**
 * Exécute les migrations PostgreSQL versionnées, hors de server.js.
 * À lancer dans le job de migration du déploiement (rôle MIGRATOR), avant le
 * démarrage de l'application (qui, elle, ne fait qu'une attestation de readiness).
 *
 * Usage :
 *   node backend/db/postgresql/migrate-cli.js
 *
 * Connexion : DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.
 * Sortie 0 = base à jour (avec ou sans migration appliquée) ; sortie 1 = échec.
 */
const path = require('node:path');
const { migrate } = require('./migrate');

const directory = path.resolve(__dirname, 'migrations');

async function main() {
  const result = await migrate({ directory, migrationEnv: process.env });
  const applied = result.applied.length ? result.applied.join(', ') : 'aucune';
  console.log('[migrate] appliquées : ' + applied
    + (result.reconciled ? ' (réconciliation sous verrou, aucun SQL rejoué)' : '')
    + (result.pending && result.pending.length ? ' ; en attente : ' + result.pending.join(', ') : ''));
}

if (require.main === module) {
  main().catch(err => {
    // migrate() lève des erreurs typées ; on n'expose que le message rédigé, jamais le SQL.
    console.error('[migrate] échec' + (err && err.code ? ' [' + err.code + ']' : '') + ' : ' + (err && err.message || err));
    process.exit(1);
  });
}

module.exports = { main };
