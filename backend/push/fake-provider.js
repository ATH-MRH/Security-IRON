'use strict';
/**
 * PG-13 — fournisseur push FAKE, actif par défaut et seul fournisseur câblé
 * dans cette passe autonome. Aucun fournisseur externe, aucune clé, aucun
 * coût : enregistre chaque envoi en mémoire (utile aux tests, et à un futur
 * écran de debug SOC), ne contacte jamais un service réel.
 *
 * Le fournisseur réel — Web Push standard (VAPID), le seul protocole de push
 * navigateur qui n'exige aucun compte tiers, contrairement à un push mobile
 * natif (FCM/APNs) — reste un HUMAN CHECKPOINT : une paire de clés VAPID,
 * même auto-générée, devient une identité de production réelle une fois
 * déployée et utilisée pour livrer de vraies notifications. Voir docs/push.md.
 *
 * Contrat (backend/push.js#setProvider) : send(subscription, payload) ->
 * { ok: boolean, expired?: boolean }. `expired: true` fait supprimer
 * l'abonnement correspondant par l'appelant — jamais fait ici (ce fournisseur
 * ne sait pas si un abonnement est réellement mort, il ne fait rien de réel).
 */
const sent = [];

async function send(subscription, payload) {
  sent.push({ subscription, payload, at: new Date().toISOString() });
  return { ok: true };
}

function all() { return sent.slice(); }
function clear() { sent.length = 0; }

module.exports = { send, all, clear };
