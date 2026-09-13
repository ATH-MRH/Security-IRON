'use strict';
/**
 * Sauvegarde PostgreSQL (pg_dump -Fc). Voir docs/postgresql-backup-restore.md.
 *
 * Usage :
 *   node backend/db/postgresql/backup-cli.js <fichier-sortie.dump>
 *
 * Connexion : DATABASE_URL (voir .env.example).
 */
const { backup } = require('./backup');

async function main() {
  const outFile = process.argv[2];
  if (!outFile) { console.error('[backup] usage : node backend/db/postgresql/backup-cli.js <fichier-sortie.dump>'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('[backup] DATABASE_URL requis'); process.exit(1); }
  const result = await backup({ databaseUrl: process.env.DATABASE_URL, outFile });
  console.log('[backup] écrit : ' + result.file);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[backup] échec' + (err && err.code ? ' [' + err.code + ']' : '') + ' : ' + (err && err.message || err));
    process.exit(1);
  });
}

module.exports = { main };
