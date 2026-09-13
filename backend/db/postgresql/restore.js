'use strict';
/**
 * PG-27 — restauration PostgreSQL via `pg_restore` (déjà installé avec
 * PostgreSQL — aucune nouvelle dépendance, aucun service externe).
 *
 * Destructif par construction (`--clean` supprime les objets existants de
 * la cible avant de restaurer) : réutilise exactement la même garde que
 * `backend/db/postgresql/import-sqlite.js#assertTargetAllowed` (PG-5) —
 * jamais une cible réelle sans confirmation explicite. Même classe de
 * danger (écrasement massif d'une cible), même garde éprouvée plutôt
 * qu'une copie qui pourrait diverger silencieusement dans le temps.
 *
 * Aucune opération de production : voir
 * docs/postgresql-backup-restore.md pour le runbook complet (usage prévu :
 * bases de test/développement locales jetables).
 */
const { run } = require('./backup');
const { assertTargetAllowed } = require('./import-sqlite');

/**
 * @param databaseUrl URI PostgreSQL complète de la base CIBLE (déjà créée,
 *                     vide ou non — --clean --if-exists gère les deux)
 * @param targetName  nom de la base cible, pour la même vérification que
 *                     import-sqlite.js (« …test… », ou
 *                     SECURISITE_IMPORT_CONFIRM=<nom> après validation humaine)
 * @param inFile       chemin du fichier produit par backup.js (-Fc)
 */
async function restore({ databaseUrl, targetName, inFile, targetEnv = process.env }) {
  assertTargetAllowed(targetName, targetEnv);
  if (!databaseUrl) throw Object.assign(new Error('databaseUrl requis'), { code: 'DATABASE_URL_REQUIRED' });
  if (!inFile) throw Object.assign(new Error('inFile requis'), { code: 'INPUT_REQUIRED' });
  // --clean --if-exists : repart proprement même si la cible porte encore
  // des objets (un réimport après un premier essai, par exemple) — jamais
  // un échec silencieux sur un objet préexistant. --no-owner : la
  // restauration ne dépend jamais des rôles OWNER/MIGRATOR/APP du système
  // source (backend/db/postgresql/provision-roles.js), qui peuvent
  // légitimement différer d'un environnement à l'autre.
  await run('pg_restore', ['-d', databaseUrl, '--clean', '--if-exists', '--no-owner', '--no-password', inFile]);
  return { file: inFile };
}

module.exports = { restore };
