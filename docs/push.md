# SécuriSite — infrastructure push (PG-13, PCS01 Lot D)

**Aucun fournisseur réel en production à ce jour.** Le fournisseur actif par
défaut reste `backend/push/fake-provider.js` — en mémoire, aucun réseau,
aucune clé. `backend/push/web-push-provider.js` (PCS01, Lot D) implémente
désormais le fournisseur Web Push réel, mais **reste inactif tant que les
trois variables d'environnement `SECURISITE_VAPID_PUBLIC_KEY` /
`_PRIVATE_KEY` / `_SUBJECT` ne sont pas explicitement fournies** — server.js
ne bascule dessus que si les trois sont présentes ; absentes (le cas
aujourd'hui, y compris en production), le comportement est strictement
identique à avant ce lot. Fournir ces trois clés en production, elles, restent
un **HUMAN CHECKPOINT** (voir « Fournisseur réel » plus bas) : c'est ce choix
précis, pas le code, que ce lot ne prend pas à la place de l'opérateur.

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
web (contrairement à un push mobile natif — c'est Chrome lui-même qui relaie
ensuite via `fcm.googleapis.com`, sans compte ni configuration Firebase côté
SécuriSite). Même auto-générée et gratuite, une paire de clés VAPID devient
une **identité de production réelle** dès qu'elle sert à livrer de vraies
notifications à de vrais navigateurs — c'est cette mise en service en
production, précisément, que ce lot ne fait pas à la place de l'opérateur.

Activer un fournisseur réel (VAPID) revient à :
1. générer une paire de clés (`node -e "console.log(require('web-push').generateVAPIDKeys())"`,
   ou toute paire VAPID existante) — **jamais dans Git**, jamais dans les
   logs ; la clé PRIVÉE est un secret, la clé PUBLIQUE ne l'est pas (c'est
   son principe, Web Push standard) ;
2. la fournir au déploiement (Coolify ou équivalent) comme
   `SECURISITE_VAPID_PUBLIC_KEY`, `SECURISITE_VAPID_PRIVATE_KEY`,
   `SECURISITE_VAPID_SUBJECT` (un `mailto:` ou une URL de contact réels — le
   service de push du navigateur peut l'utiliser pour joindre l'opérateur en
   cas d'abus) ;
3. redémarrer l'application — `server.js#start` bascule alors automatiquement
   sur `backend/push/web-push-provider.js` (`docs`/commentaire dans
   `server.js`, juste avant `push.init()`) ; rien d'autre à changer côté code,
   frontend inclus (`frontend/js/push.js` le documentait déjà, avant même que
   ce lot n'existe).

**Implémenté, testé, jamais activé par ce lot lui-même** :
`backend/push/web-push-provider.js` (contrat identique à `fake-provider.js` :
`send(subscription, payload) -> {ok, expired?}` ; 404/410 du service de push
→ `expired:true`, toute autre erreur → `{ok:false}`, jamais levée). Vérifié
en direct avec une **vraie** paire de clés VAPID jetable (générée pour la
vérification, jamais committée) : un vrai Chrome signé (pas le Chromium nu
de Playwright, qui n'a pas les clés API Google nécessaires à la Push API) qui
s'abonne réellement auprès de `fcm.googleapis.com`, et le même appel
`web-push` que `web-push-provider.js#send()` accepté par FCM avec un 201 —
preuve d'une livraison réelle acceptée par l'infrastructure Google, pas un
mock. (Le rendu de la notification système côté Chrome for Testing *headless*
lui-même n'a pas pu être observé dans le harnais Playwright — limitation
connue du mode headless pour le réveil push en arrière-plan, indépendante du
code livré ici : l'appel réel côté serveur, lui, est prouvé accepté.)

## Tests

`tests/postgres-push.test.js` (PostgreSQL réel) : validation de forme,
périmètre requis pour s'abonner, idempotence (`ON CONFLICT`), suppression
scopée au seul propriétaire, livraison réelle filtrée own/scope, absence de
contenu dans la charge utile, substitution de fournisseur (`setProvider`) et
restauration, suppression automatique d'un abonnement expiré, readiness.

`tests/push-web-push-provider.test.js` (PCS01, Lot D — aucune base de
données) : `configureFromEnv` (les trois variables requises, sinon inactif),
`send()` sur les trois issues (succès, abonnement mort 404/410 → `expired`,
toute autre erreur → `{ok:false}` jamais levée), `web-push` monkey-patché
pour rester sans réseau réel dans la suite automatisée.
