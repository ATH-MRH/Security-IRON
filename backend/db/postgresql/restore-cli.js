'use strict';
/**
 * Restauration PostgreSQL (pg_restore --clean). Voir
 * docs/postgresql-backup-restore.md — destructif, cible « …test… » ou
 * confirmée explicitement (SECURISITE_IMPORT_CONFIRM=<nom de base>).
 *
 * Usage :
 *   node backend/db/postgresql/restore-cli.js <fichier.dump>
 *
 * Connexion : DATABASE_URL (voir .env.example) — son nom de base est le
 * nom cible vérifié par la garde (même mécanisme que import-sqlite.js).
 */
const { restore } = require('./restore');

async function main() {
  const inFile = process.argv[2];
  if (!inFile) { console.error('[restore] usage : node backend/db/postgresql/restore-cli.js <fichier.dump>'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('[restore] DATABASE_URL requis'); process.exit(1); }
  const targetName = new URL(process.env.DATABASE_URL).pathname.slice(1);
  const result = await restore({ databaseUrl: process.env.DATABASE_URL, targetName, inFile });
  console.log('[restore] restauré depuis : ' + result.file);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[restore] échec' + (err && err.code ? ' [' + err.code + ']' : '') + ' : ' + (err && err.message || err));
    process.exit(1);
  });
}

module.exports = { main };
