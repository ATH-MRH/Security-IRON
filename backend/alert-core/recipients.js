'use strict';
/**
 * PCS01 (Lot C) — ciblage explicite de destinataires pour une alerte
 * (agent/site/zone/tout le tenant) et accusés de réception PAR
 * DESTINATAIRE (migration 011). Module séparé de service.js/repository.js :
 * une seule direction de dépendance (service.js appelle ici, jamais
 * l'inverse) pour éviter toute dépendance circulaire.
 *
 * Résolution des destinataires : TOUJOURS depuis les memberships ACTIVES du
 * tenant de l'opérateur — jamais un id de destinataire fourni par le
 * client pris pour argent comptant (site_id/zone_id sont vérifiés
 * appartenir à ce même tenant avant toute résolution). Un site/zone ciblé
 * résout aux memberships de niveau site/zone COUVRANT précisément cette
 * cible — jamais les memberships de niveau tenant (elles voient déjà tout
 * via own/scope, backend/scope.js ; leur ajouter une ligne ici ferait
 * doublon sans jamais rien leur apporter).
 *
 * `tenant_wide` reste réservé au SOC (même porte que le reste des actions
 * SOC — service.js#act) : aucune permission plus fine (ex. "SOC de niveau
 * tenant uniquement") n'existe dans le modèle memberships actuel ; en
 * ajouter une serait une extension de schéma distincte, hors de ce lot.
 */
const db = require('../database');
const scope = require('../scope');
const { atomic } = require('./repository');

const RECIPIENT_TYPES = new Set(['user', 'site', 'zone', 'tenant_wide']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// memberships/sites/zones sont protégées par RLS (migration 005) : sans
// contexte d'acteur PostgreSQL (SET LOCAL securisite.actor_user_id), le
// rôle applicatif restreint (securisite_app, NOBYPASSRLS) ne voit AUCUNE
// ligne — jamais une erreur, un simple résultat vide qui ressemblerait à
// tort à "aucun destinataire" (bug réel trouvé en vérification live : la
// suite de tests, connectée en superutilisateur implicite, ne l'avait pas
// révélé — même piège documenté PG-28, backend/scope.js). Chaque lecture
// de ces trois tables passe donc par scope.withActorContext(callerUserId,
// ...), exactement comme backend/map.js#listSites — jamais directement
// via le paramètre `client` d'un appelant (qui n'a posé aucun acteur).
async function resolveRecipients(callerUserId, tenantId, recipientType, recipientId) {
  return scope.withActorContext(callerUserId, async client => {
    if (recipientType === 'tenant_wide') {
      const rows = await client.all(
        'SELECT DISTINCT user_id FROM public.memberships WHERE tenant_id=$1 AND status=$2',
        [tenantId, 'active']);
      return rows.map(r => r.user_id);
    }
    if (recipientType === 'user') {
      const userId = Number.isInteger(recipientId) ? recipientId : parseInt(recipientId, 10);
      if (!Number.isInteger(userId)) fail('Identifiant de destinataire invalide');
      const row = await client.get(
        'SELECT 1 FROM public.memberships WHERE tenant_id=$1 AND status=$2 AND user_id=$3 LIMIT 1',
        [tenantId, 'active', userId]);
      return row ? [userId] : [];
    }
    if (recipientType === 'site') {
      const site = await client.get(
        'SELECT id FROM public.sites WHERE id=$1 AND tenant_id=$2', [recipientId, tenantId]);
      if (!site) fail('Site introuvable dans ce périmètre', 404);
      const rows = await client.all(`
        SELECT DISTINCT user_id FROM public.memberships
        WHERE tenant_id=$1 AND status='active'
          AND (site_id=$2 OR zone_id IN (SELECT id FROM public.zones WHERE site_id=$2))`,
        [tenantId, recipientId]);
      return rows.map(r => r.user_id);
    }
    if (recipientType === 'zone') {
      const zone = await client.get(
        'SELECT id FROM public.zones WHERE id=$1 AND tenant_id=$2', [recipientId, tenantId]);
      if (!zone) fail('Zone introuvable dans ce périmètre', 404);
      const rows = await client.all(
        "SELECT DISTINCT user_id FROM public.memberships WHERE tenant_id=$1 AND status='active' AND zone_id=$2",
        [tenantId, recipientId]);
      return rows.map(r => r.user_id);
    }
    fail('Type de destinataire invalide');
  });
}

/**
 * @param alert   ligne security_alerts déjà chargée (tenant_id vérifié par l'appelant)
 * @param user    opérateur PCS01 (déjà vérifié isSoc par l'appelant)
 * @param input   { recipientType, recipientId }
 */
async function broadcast(alert, user, input, transactionClient = null) {
  const recipientType = input && input.recipientType;
  if (!RECIPIENT_TYPES.has(recipientType)) fail('Type de destinataire invalide (user, site, zone ou tenant_wide)');
  const recipientId = recipientType === 'tenant_wide' ? null : input.recipientId;
  if (recipientType !== 'tenant_wide' && (recipientId === undefined || recipientId === null || recipientId === '')) {
    fail('Identifiant de destinataire requis pour ce type de cible');
  }
  // Résolu AVANT d'entrer dans la transaction d'écriture : la résolution a
  // besoin de son propre contexte d'acteur RLS (withActorContext ouvre sa
  // propre transaction, voir resolveRecipients ci-dessus) — distinct de la
  // transaction atomic() ci-dessous, qui n'écrit que des tables non
  // protégées par RLS (alert_recipients, alert_audit) et n'en a pas besoin.
  const resolved = [...new Set(await resolveRecipients(user.id, user.tenantId, recipientType, recipientId))]
    .filter(userId => userId !== user.id); // le diffuseur n'a pas besoin d'un accusé sur sa propre diffusion
  if (!resolved.length) fail('Aucun destinataire actif ne correspond à cette cible', 404);
  return atomic(async client => {
    const stamp = new Date().toISOString();
    const recipientRef = recipientId == null ? null : String(recipientId);
    let inserted = 0;
    for (const userId of resolved) {
      const result = await client.query(`
        INSERT INTO public.alert_recipients(alert_id,user_id,recipient_type,recipient_ref,broadcast_by)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (alert_id,user_id) DO NOTHING`,
        [alert.id, userId, recipientType, recipientRef, user.id]);
      inserted += result.rowCount;
    }
    await client.query(
      'INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES($1,$2,$3,$4,$5)',
      [alert.id, stamp, user.username, 'DIFFUSION',
        `${recipientType}${recipientRef ? ':' + recipientRef : ''} — ${inserted} destinataire(s)`]);
    return { recipientCount: inserted, targeted: resolved.length, recipientUserIds: resolved };
  }, transactionClient);
}

/** L'appelant doit être le destinataire lui-même (userId depuis le JWT, jamais depuis le corps de la requête). */
async function markReceipt(alertId, userId, status, transactionClient = null) {
  if (!['delivered', 'acknowledged'].includes(status)) fail('Statut invalide');
  return atomic(async client => {
    const column = status === 'delivered' ? 'delivered_at' : 'acknowledged_at';
    // Un accusé implique la réception : si delivered_at n'était pas encore
    // posé (ex. l'overlay a été acquitté avant que le "reçu" best-effort
    // n'ait eu le temps de s'écrire), les deux colonnes sont honorées d'un
    // coup — jamais un accusé sans réception enregistrée.
    const sql = status === 'acknowledged'
      ? 'UPDATE public.alert_recipients SET delivered_at=COALESCE(delivered_at,now()), acknowledged_at=COALESCE(acknowledged_at,now()) WHERE alert_id=$1 AND user_id=$2 RETURNING id'
      : `UPDATE public.alert_recipients SET ${column}=COALESCE(${column},now()) WHERE alert_id=$1 AND user_id=$2 RETURNING id`;
    const result = await client.query(sql, [alertId, userId]);
    if (!result.rowCount) fail('Vous n’êtes pas destinataire de cette alerte', 404);
    const stamp = new Date().toISOString();
    const user = await client.get('SELECT username FROM public.users WHERE id=$1', [userId]);
    await client.query(
      'INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES($1,$2,$3,$4,$5)',
      [alertId, stamp, user ? user.username : ('user#' + userId),
        status === 'delivered' ? 'RECU_DESTINATAIRE' : 'ACCUSE_DESTINATAIRE', '']);
    return { ok: true };
  }, transactionClient);
}

async function listReceipts(alertId, client = db) {
  return client.all(`
    SELECT r.id, r.user_id, u.username, r.recipient_type, r.recipient_ref,
           r.sent_at, r.delivered_at, r.acknowledged_at
    FROM public.alert_recipients r
    JOIN public.users u ON u.id = r.user_id
    WHERE r.alert_id=$1 ORDER BY r.sent_at`, [alertId]);
}

async function isRecipient(alertId, userId, client = db) {
  const row = await client.get(
    'SELECT 1 FROM public.alert_recipients WHERE alert_id=$1 AND user_id=$2', [alertId, userId]);
  return Boolean(row);
}

/** Alertes où l'utilisateur est destinataire explicite — jamais une visibilité
 * plus large que ça : le tenant est revérifié ici même si les lignes
 * alert_recipients sont déjà construites tenant-cohérentes (défense en
 * profondeur, même principe que repository.js#allAlerts/alertsByCreator). */
async function alertsForRecipient(userId, tenantId, client = db) {
  return client.all(`
    SELECT DISTINCT a.* FROM public.security_alerts a
    JOIN public.alert_recipients r ON r.alert_id = a.id
    WHERE r.user_id=$1 AND a.tenant_id=$2
    ORDER BY a.level DESC, a.created_at DESC`, [userId, tenantId]);
}

// Bouton SOS réel (mission « panic button ») — décision produit validée :
// la désignation se fait par un simple booléen par compte (users.
// sos_recipient, migration 021), global, jamais résolu depuis les
// memberships (contrairement à resolveRecipients() ci-dessus). Appelée
// UNIQUEMENT pour origin='SOS' (voir service.js#create) — jamais pour une
// alerte COMMAND/INCIDENT/REGLE_BADGE, qui gardent le ciblage manuel
// existant. users n'est pas protégé par RLS (pas de tenant_id, compte
// global) : lu directement via le client de la transaction en cours,
// aucun contexte d'acteur à poser ici (contrairement à resolveRecipients).
async function broadcastToSosDesignated(alert, creatorUserId, transactionClient) {
  return atomic(async client => {
    const rows = await client.all(
      `SELECT id FROM public.users WHERE sos_recipient = true AND status <> 'blocked' AND id <> $1`,
      [creatorUserId]);
    const ids = rows.map(r => r.id);
    let inserted = 0;
    for (const userId of ids) {
      // recipient_type='user' + recipient_ref=son propre id : même forme
      // exacte qu'une diffusion manuelle ciblant cet utilisateur précis
      // (voir broadcast() ci-dessus) — aucune extension de schéma requise
      // (la contrainte CHECK migration 011 autorise déjà 'user').
      const result = await client.query(`
        INSERT INTO public.alert_recipients(alert_id,user_id,recipient_type,recipient_ref,broadcast_by)
        VALUES($1,$2,'user',$3,$4)
        ON CONFLICT (alert_id,user_id) DO NOTHING`,
        [alert.id, userId, String(userId), creatorUserId]);
      inserted += result.rowCount;
    }
    if (inserted) {
      await client.query(
        'INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES($1,$2,$3,$4,$5)',
        [alert.id, new Date().toISOString(), 'system', 'DIFFUSION', `sos_designated — ${inserted} destinataire(s)`]);
    }
    return { recipientCount: inserted, recipientUserIds: ids };
  }, transactionClient);
}

/** Candidats "utilisateur" pour le sélecteur de diffusion PCS01 — mêmes
 * comptes qu'une membership active sous ce tenant pourrait cibler
 * individuellement (recipientType='user' ci-dessus). Jamais depuis la
 * table employes (fiches RH, sans lien direct vers un compte de
 * connexion) : seuls des comptes qui peuvent réellement se connecter et
 * recevoir quelque chose ont un sens ici. */
async function userCandidates(callerUserId, tenantId) {
  return scope.withActorContext(callerUserId, client => client.all(`
    SELECT DISTINCT u.id, u.username, u.nom_complet
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id
    WHERE m.tenant_id=$1 AND m.status='active'
    ORDER BY u.username`, [tenantId]));
}

module.exports = { resolveRecipients, broadcast, broadcastToSosDesignated, markReceipt, listReceipts, isRecipient, alertsForRecipient, userCandidates };
