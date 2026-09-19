'use strict';
/**
 * PCS01 (Lot D) — fournisseur Web Push réel (VAPID standard, le seul
 * protocole de push navigateur sans compte tiers — voir docs/push.md).
 * N'est JAMAIS actif par défaut : configureFromEnv() (appelée par
 * server.js) ne bascule server.js hors de backend/push/fake-provider.js que
 * si SECURISITE_VAPID_PUBLIC_KEY / _PRIVATE_KEY / _SUBJECT sont TOUTES les
 * trois définies — rester sur le fournisseur FAKE tant qu'elles ne le sont
 * pas est le comportement voulu (HUMAN CHECKPOINT), jamais une
 * configuration incomplète à signaler.
 *
 * Contrat identique à fake-provider.js (backend/push.js#setProvider) :
 * send(subscription, payload) -> { ok, expired? }. `web-push` lève sur tout
 * statut HTTP non-2xx renvoyé par le service de push du navigateur
 * (statusCode sur l'erreur) : 404/410 signifient un abonnement mort
 * (désinstallation/révocation côté utilisateur) — le seul cas où
 * `expired: true` est renvoyé, pour que l'appelant (backend/push.js
 * #deliverFor) supprime la ligne. Toute autre erreur (réseau, clé
 * invalide, throttling…) reste ok:false, jamais levée plus haut : une
 * notification manquée ne doit jamais faire échouer la mutation qui l'a
 * déclenchée (même contrat que fake-provider.js).
 */
const webpush = require('web-push');

function configureFromEnv(env = process.env) {
  const publicKey = env.SECURISITE_VAPID_PUBLIC_KEY;
  const privateKey = env.SECURISITE_VAPID_PRIVATE_KEY;
  const subject = env.SECURISITE_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

async function send(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, payload);
    return { ok: true };
  } catch (error) {
    const expired = Boolean(error) && (error.statusCode === 404 || error.statusCode === 410);
    return { ok: false, expired };
  }
}

module.exports = { configureFromEnv, send };
