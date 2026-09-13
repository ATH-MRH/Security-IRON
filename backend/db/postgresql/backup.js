'use strict';
/**
 * PG-27 — sauvegarde PostgreSQL via `pg_dump` (déjà installé avec
 * PostgreSQL — aucune nouvelle dépendance, aucun service externe).
 *
 * Format `-Fc` (custom, compressé) : le seul compatible avec `pg_restore`
 * et ses options de reprise sélective — jamais `-Fp` (SQL brut), qui ne
 * permettrait pas les mêmes garanties de restauration testées ici.
 *
 * Lecture seule par construction (`pg_dump` ne modifie jamais sa source) :
 * contrairement à `restore.js`, aucune restriction de cible n'est
 * nécessaire — sauvegarder une base réelle est sans risque en soi (le
 * risque est entièrement du côté de la restauration, voir restore.js).
 *
 * Aucune opération de production : ce module ne fait qu'exécuter `pg_dump`
 * sur la cible fournie par l'appelant — voir docs/postgresql-backup-restore.md
 * pour le runbook (usage prévu : bases de test/développement locales).
 */
const { spawn } = require('node:child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { env: process.env }); }
    catch (e) { return reject(Object.assign(new Error(cmd + ' introuvable : ' + e.message), { code: 'CLI_NOT_FOUND' })); }
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => reject(Object.assign(new Error(cmd + ' introuvable : ' + e.message), { code: 'CLI_NOT_FOUND' })));
    child.on('close', code => {
      if (code === 0) return resolve();
      // Le message d'erreur brut de pg_dump/pg_restore peut mentionner
      // l'hôte/la base — jamais journalisé tel quel plus haut dans la pile
      // (voir backend/http-errors.js) ; ici, seul un appelant CLI direct le
      // voit, jamais une réponse HTTP.
      reject(Object.assign(new Error(cmd + ' a échoué (code ' + code + ') : ' + stderr.trim().slice(0, 2000)), { code: cmd.toUpperCase() + '_FAILED' }));
    });
  });
}

/**
 * @param databaseUrl URI PostgreSQL complète de la base à sauvegarder
 * @param outFile     chemin du fichier de sortie (format pg_dump -Fc)
 */
async function backup({ databaseUrl, outFile }) {
  if (!databaseUrl) throw Object.assign(new Error('databaseUrl requis'), { code: 'DATABASE_URL_REQUIRED' });
  if (!outFile) throw Object.assign(new Error('outFile requis'), { code: 'OUTPUT_REQUIRED' });
  await run('pg_dump', ['-d', databaseUrl, '-Fc', '--no-password', '-f', outFile]);
  return { file: outFile };
}

module.exports = { backup, run };
