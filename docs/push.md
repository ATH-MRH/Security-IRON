# SécuriSite — infrastructure push (PG-13)

**Aucun fournisseur réel dans cette passe.** Le fournisseur actif est
`backend/push/fake-provider.js` — en mémoire, aucun réseau, aucune clé,
aucun compte tiers. L'activation d'un fournisseur réel reste un
**HUMAN CHECKPOINT** (voir « Fournisseur réel » plus bas).

## Architecture

`backend/push.js` — service central, point d'écriture unique pour
`push_subscriptions` (migration `008`) et seul consommateur du fournisseur
actif. Écoute le **même bus** que `backend/realtime.js` (PG-12) :
temps réel (SSE) et push sont deux consommateurs indépendants du même flux
d'événements — aucune duplication de logique de déclenchement dans
`alert-core/service.js`, qui reste inchangé au-delà de ses deux appels
`realtime.emit` déjà posés en PG-12.

`push_subscriptions` : `user_id`, `endpoint`, `p256dh`, `auth` — la forme
standard d'un `PushSubscription` navigateur (Web Push). État de
périphérique, pas un journal : contrairement à `memberships` (PG-7), mis à
jour et supprimé librement (`ON CONFLICT DO UPDATE`, `ON DELETE CASCADE`
avec l'utilisateur) — pas de trigger append-only, pas de RLS (isolation par
`user_id` en requête, même modèle que `alert_notifications`).

## API

- `POST /api/push/subscribe` — corps `{endpoint, keys:{p256dh, auth}}` (forme
  de `PushSubscription.toJSON()`). Exige un périmètre actif (même porte
  `requireScope` que le reste de `routes.js`) : sans membership, aucun
  événement ne serait jamais poussé de toute façon.
- `DELETE /api/push/subscribe` — corps `{endpoint}`, supprime uniquement
  l'abonnement de l'appelant pour cet `endpoint` (jamais celui d'un autre
  utilisateur, même en cas de collision d'`endpoint`).

## Livraison

`push.deliverFor(event)` — déclenché à chaque événement du bus temps réel
(`alert:created`, `alert:updated`). Pour chaque abonnement enregistré,
résout le périmètre de son propriétaire (`backend/scope.js`, comme
`backend/realtime-routes.js` en PG-12) et filtre :

- `alertAccess === 'scope'` (SOC) : reçoit tout événement du tenant ;
- `alertAccess === 'own'` : reçoit uniquement les événements dont il est
  l'auteur.

Charge utile : `{type, id, at}` uniquement — jamais le contenu de l'alerte.
Le client recharge toujours via l'API REST déjà autorisée ; le push n'est
qu'un indice de réveil, jamais une donnée de confiance. Un abonnement dont
le fournisseur signale l'expiration (`{expired: true}`) est supprimé
automatiquement.

## Fournisseur réel — HUMAN CHECKPOINT

Le seul protocole de push navigateur qui n'exige **aucun compte tiers** est
Web Push standard avec authentification **VAPID** : l'application génère sa
propre paire de clés, aucun enregistrement FCM/APNs nécessaire pour un push
web (contrairement à un push mobile natif). Malgré cela, ce lot ne génère
et n'active **aucune** clé VAPID : même auto-générée et gratuite, une paire
de clés VAPID devient une **identité de production réelle** dès qu'elle sert
à livrer de vraies notifications à de vrais navigateurs — exactement le
type de « clé » que le contrat de ce lot réserve à une décision humaine.

Activer un fournisseur réel (VAPID ou autre) reviendra à :
1. générer/fournir la paire de clés (jamais dans Git) ;
2. implémenter `backend/push/web-push-provider.js` (contrat identique à
   `fake-provider.js` : `send(subscription, payload) -> {ok, expired?}`) ;
3. `push.setProvider(webPushProvider)` au démarrage, derrière une variable
   d'environnement explicite.

Aucune de ces trois étapes n'est faite ici.

## Tests

`tests/postgres-push.test.js` (PostgreSQL réel) : validation de forme,
périmètre requis pour s'abonner, idempotence (`ON CONFLICT`), suppression
scopée au seul propriétaire, livraison réelle filtrée own/scope, absence de
contenu dans la charge utile, substitution de fournisseur (`setProvider`) et
restauration, suppression automatique d'un abonnement expiré, readiness.
