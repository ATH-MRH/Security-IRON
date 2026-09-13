'use strict';
/**
 * Complète `create-admin.js` : provisionne le membership SOC (périmètre
 * tenant « local », accès `scope`) du compte administrateur, sans lequel
 * il n'a accès qu'aux routes `/api/admin/*` (rôle JWT) — jamais au
 * tableau de bord SOC, aux alertes ou aux incidents
 * (`scope.requireScope()`, PG-8). `create-admin.js` ne le fait pas lui-même
 * (portée volontairement minimale, voir son en-tête) ; PG-8 a laissé
 * `provisionLocalMembership` disponible mais jamais câblé à un CLI —
 * constaté et corrigé en préparant la mise en production (l'étape a dû
 * être faite à la main lors de la validation en staging).
 *
 * Idempotent : n'élargit ni ne réactive jamais un membership existant
 * (ON CONFLICT DO NOTHING, voir provision-membership.js). Ne modifie
 * jamais un compte différent de celui demandé. Aucun secret manipulé ici
 * (ni lu, ni affiché, ni journalisé).
 *
 * Usage :
 *   node backend/db/postgresql/bootstrap-admin-membership.js [identifiant]
 *   (identifiant par défaut : 'admin', ou SECURISITE_ADMIN_USERNAME)
 *
 * Connexion : DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
 * (rôle MIGRATOR — écrit dans memberships ET security_audit dans la même
 * transaction, comme provision-membership.js l'exige).
 */
const db = require('../../database');
const { provisionLocalMembership } = require('./provision-membership');

const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;

async function bootstrapAdminMembership(env, username) {
  const user = username || env.SECURISITE_ADMIN_USERNAME || 'admin';
  if (!USERNAME.test(user)) throw new Error('Identifiant invalide : ' + user);

  const row = await db.get('SELECT id FROM public.users WHERE username = $1', [user]);
  if (!row) {
    throw Object.assign(
      new Error(`Compte « ${user} » introuvable — exécuter d'abord create-admin.js.`),
      { code: 'BOOTSTRAP_ADMIN_UNKNOWN' });
  }
  const result = await db.transaction(client =>
    provisionLocalMembership(client, row.id, { actorUserId: row.id, origin: 'provisioning' }));
  return { username: user, ...result };
}

async function main() {
  const username = process.argv[2];
  const r = await bootstrapAdminMembership(process.env, username);
  console.log(r.provisioned
    ? `[bootstrap-admin-membership] membership ${r.role}/${r.alert_access} provisionné pour « ${r.username} ».`
    : (r.reason
        ? `[bootstrap-admin-membership] « ${r.username} » : rôle hors périmètre local (${r.reason}), rien à faire.`
        : `[bootstrap-admin-membership] « ${r.username} » a déjà un membership de ce niveau : inchangé.`));
  await db.close();
}

if (require.main === module) {
  main().catch(err => { console.error('[bootstrap-admin-membership]', err.message); process.exit(1); });
}

module.exports = { bootstrapAdminMembership };
