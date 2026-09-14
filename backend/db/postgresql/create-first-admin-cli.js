'use strict';
/**
 * Crée le premier administrateur SécuriSite (compte + membership SOC) en un
 * seul processus Node, sans bash ni docker compose : chaîne exactement les
 * deux outils existants (create-admin.js, bootstrap-admin-membership.js),
 * inchangés, dans le même ordre que scripts/create-first-admin.sh.
 *
 * Existe parce que l'image applicative de production (node:22-alpine) ne
 * contient pas bash, sur lequel scripts/create-first-admin.sh s'appuyait —
 * rencontré lors du premier déploiement Coolify (le terminal disponible dans
 * ce contexte est un shell POSIX dans le conteneur `app`, pas un hôte avec
 * docker compose). Ce fichier est exécutable directement avec `node`, seul
 * binaire réellement garanti dans ce conteneur — `sh`/`ash` suffisent pour
 * positionner les variables d'environnement avant de le lancer.
 *
 * Usage (depuis un shell dans le conteneur `app`, ou tout conteneur ayant
 * l'image applicative et un accès réseau à `db`) :
 *   export DATABASE_URL='postgres://securisite_migrator:...@db:5432/securisite'
 *   export SECURISITE_ADMIN_PASSWORD='...'
 *   node backend/db/postgresql/create-first-admin-cli.js [identifiant]
 *
 * Connexion : rôle MIGRATOR requis (bootstrap-admin-membership.js écrit dans
 * memberships ET security_audit, hors de portée d'APP) — jamais le rôle APP,
 * jamais le superutilisateur du cluster.
 *
 * scripts/create-first-admin.sh (usage depuis un hôte avec docker compose)
 * appelle désormais ce même fichier en une seule commande.
 */
const { createAdmin } = require('./create-admin');
const { bootstrapAdminMembership } = require('./bootstrap-admin-membership');
const db = require('../../database');

async function main() {
  const username = process.argv[2];
  const created = await createAdmin(process.env, { username });
  console.log(created.created
    ? `[create-first-admin] compte administrateur « ${created.username} » créé.`
    : `[create-first-admin] le compte « ${created.username} » existe déjà : aucune modification.`);

  const membership = await bootstrapAdminMembership(process.env, created.username);
  console.log(membership.provisioned
    ? `[create-first-admin] membership ${membership.role}/${membership.alert_access} provisionné pour « ${membership.username} ».`
    : (membership.reason
        ? `[create-first-admin] « ${membership.username} » : rôle hors périmètre local (${membership.reason}), rien à faire.`
        : `[create-first-admin] « ${membership.username} » a déjà un membership de ce niveau : inchangé.`));
}

if (require.main === module) {
  main()
    .catch(err => { console.error('[create-first-admin]', err.message); process.exitCode = 1; })
    .finally(() => db.close());
}

module.exports = { main };
