'use strict';
/**
 * PG-12 — temps réel minimal : un bus d'événements en mémoire (process
 * unique — server.js ne fait tourner qu'un seul processus Node, aucun
 * clustering aujourd'hui) diffusé aux clients connectés via Server-Sent
 * Events. Choisi plutôt que WebSocket : le seul besoin réel est un push
 * serveur -> client (« quelque chose a changé, recharge la ressource déjà
 * autorisée via l'API REST ») ; aucun flux n'a besoin d'un canal client ->
 * serveur temps réel. SSE tourne sur HTTP simple (pas de bibliothèque
 * supplémentaire), se reconnecte automatiquement côté navigateur
 * (EventSource), et s'intègre sans changement au modèle d'autorisation
 * existant : chaque événement transmis ne porte qu'un identifiant et les
 * coordonnées nécessaires au filtrage par périmètre — jamais le contenu de
 * la ressource. Le client ne fait jamais confiance au contenu de l'événement
 * : il recharge via l'API REST déjà autorisée (own/scope, RLS, etc.).
 *
 * Limite connue, assumée : si le processus est un jour mis à l'échelle
 * horizontalement, ce bus en mémoire ne diffuse plus qu'aux clients connectés
 * à CE processus. La suite naturelle est PostgreSQL LISTEN/NOTIFY (chaque
 * instance s'abonne, le canal devient partagé) — non construite ici : aucun
 * besoin démontré aujourd'hui (déploiement mono-processus), l'ajouter
 * maintenant serait la sur-ingénierie que ce lot doit éviter.
 */
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const bus = new EventEmitter();
bus.setMaxListeners(0); // un abonné par connexion SSE active, nombre non borné a priori

/**
 * @param type    ex. 'alert:created', 'alert:updated'
 * @param payload jamais le contenu de la ressource — seulement de quoi
 *                filtrer par périmètre (tenantId, createdBy) et un id à
 *                utiliser pour un rechargement REST côté client.
 */
function emit(type, payload) {
  bus.emit('event', { type, payload, at: new Date().toISOString() });
}

/**
 * @param matches(event) => boolean   filtre de périmètre, jamais contourné
 * @param onEvent(event)               appelé pour chaque événement retenu
 * @returns () => void  désabonnement
 */
function subscribe(matches, onEvent) {
  // Audit SOS bout-en-bout : EventEmitter#emit() appelle chaque abonné de
  // façon SYNCHRONE et DANS L'ORDRE — un abonné qui lève (ex. un flux SSE
  // dont le socket vient de se fermer, backend/realtime-routes.js) arrêtait
  // net la diffusion aux abonnés suivants ET remontait jusqu'à l'appelant de
  // emit(), c.-à-d. jusqu'à la requête qui vient de créer l'alerte
  // (alert-core/service.js#create, après le COMMIT). Un SOS déjà enregistré
  // avec succès recevait alors une réponse 500 — un faux « échec » causé par
  // un abonné SANS RAPPORT avec l'émetteur. Isolé ici, au point d'entrée
  // unique de tous les abonnés (présents et futurs), plutôt que dans chaque
  // implémentation d'onEvent : aucun abonné cassé ne doit jamais empêcher ni
  // la diffusion aux autres, ni la réussite de l'action qui a émis l'événement.
  const listener = event => {
    if (!matches(event)) return;
    try { onEvent(event); }
    catch (err) { console.error('[realtime] abonné en échec, ignoré :', err?.message || err); }
  };
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

// Tickets à usage unique, courte durée de vie : EventSource ne peut pas
// envoyer d'en-tête Authorization, et un JWT longue durée ne doit jamais se
// retrouver dans une URL (journaux serveur/proxy, en-tête Referer). Un
// ticket est émis par un appel REST authentifié (Authorization: Bearer,
// comme toute autre route) et consommé une seule fois par la connexion SSE
// elle-même. Un client capable d'envoyer un en-tête (tests, un futur client
// non-navigateur) utilise directement le Bearer token — le ticket n'est un
// repli que pour EventSource.
const TICKET_TTL_MS = 30000;
const tickets = new Map(); // ticket -> { userId, expiresAt }

function issueTicket(userId) {
  const ticket = randomUUID();
  tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, expiresInMs: TICKET_TTL_MS };
}

// Toujours retiré, y compris expiré ou absent : usage unique par construction,
// jamais un ticket valide deux fois même si le premier essai échoue.
function consumeTicket(ticket) {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) if (entry.expiresAt < now) tickets.delete(ticket);
}, TICKET_TTL_MS);
sweep.unref();

// Observability / tests: how many active SSE subscribers are attached right
// now — proves subscribe()'s returned unsubscribe actually detaches on
// disconnect, and is a cheap building block for a future health endpoint.
function listenerCount() { return bus.listenerCount('event'); }

module.exports = { emit, subscribe, issueTicket, consumeTicket, listenerCount, TICKET_TTL_MS };
