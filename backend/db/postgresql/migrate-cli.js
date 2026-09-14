'use strict';
/**
 * Exécute les migrations PostgreSQL versionnées, hors de server.js.
 * À lancer dans le job de migration du déploiement (rôle MIGRATOR), avant le
 * démarrage de l'application (qui, elle, ne fait qu'une attestation de readiness).
 *
 * Termine ensuite en restaurant les GRANT runtime d'APP sur tout ce que les
 * migrations viennent de (re)créer (`provision-roles.js#finalizeGrants`, même
 * connexion MIGRATOR — jamais de mot de passe APP ni de connexion superuser
 * nécessaires ici) : sans cette étape, USAGE sur securisite_meta, SELECT sur
 * securisite_meta.schema_migrations et EXECUTE sur les fonctions RLS restent
 * absents pour APP tant que quelqu'un ne relance pas `provision-roles.js` à la
 * main après coup — piège rencontré en production (42501 sur alerts/incidents/
 * visiteurs/notifications/realtime malgré un déploiement "réussi").
 *
 * Usage :
 *   node backend/db/postgresql/migrate-cli.js
 *
 * Connexion : DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.
 * SECURISITE_OWNER_ROLE / SECURISITE_APP_ROLE : noms de rôles pour les GRANT
 * (défauts securisite_owner/securisite_app — aucun mot de passe requis).
 * Sortie 0 = base à jour (avec ou sans migration appliquée) ; sortie 1 = échec.
 */
const path = require('node:path');
const { migrate } = require('./migrate');
const { finalizeGrants } = require('./provision-roles');

const directory = path.resolve(__dirname, 'migrations');

async function main() {
  const result = await migrate({ directory, migrationEnv: process.env });
  const applied = result.applied.length ? result.applied.join(', ') : 'aucune';
  console.log('[migrate] appliquées : ' + applied
    + (result.reconciled ? ' (réconciliation sous verrou, aucun SQL rejoué)' : '')
    + (result.pending && result.pending.length ? ' ; en attente : ' + result.pending.join(', ') : ''));

  const grants = await finalizeGrants(process.env);
  console.log('[migrate] droits runtime APP à jour (' + grants.app + ')'
    + (grants.deferred ? ' — schéma encore incomplet, à recompléter au prochain déploiement.' : '.'));
}

if (require.main === module) {
  main().catch(err => {
    // migrate() lève des erreurs typées ; on n'expose que le message rédigé, jamais le SQL.
    console.error('[migrate] échec' + (err && err.code ? ' [' + err.code + ']' : '') + ' : ' + (err && err.message || err));
    process.exit(1);
  });
}

module.exports = { main };
