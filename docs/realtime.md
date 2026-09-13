# SécuriSite — temps réel (PG-12)

## Choix : SSE, pas WebSocket

Le seul besoin réel identifié est un **push serveur → client** : prévenir un
tableau de bord SOC connecté qu'une alerte vient d'être créée ou modifiée,
pour qu'il recharge la ressource déjà autorisée via l'API REST. Aucun flux
n'a besoin d'un canal client → serveur temps réel (toutes les actions
passent déjà par des `POST`/`PUT` REST classiques). Server-Sent Events :

- tourne sur HTTP simple, aucune bibliothèque supplémentaire ;
- reconnexion automatique côté navigateur (`EventSource`) ;
- s'intègre sans changement à `backend/scope.js` (périmètre résolu côté
  serveur) et au modèle d'erreurs existant.

WebSocket aurait apporté un canal bidirectionnel dont rien dans l'application
n'a besoin aujourd'hui — sur-ingénierie pour ce lot.

## Architecture

`backend/realtime.js` — bus en mémoire (`node:events`), un seul processus
Node (`server.js` ne fait tourner aucun cluster aujourd'hui). `emit(type,
payload)` : jamais le contenu de la ressource, seulement un identifiant et
les coordonnées de périmètre nécessaires au filtrage (`tenantId`,
`createdBy`). Le client ne fait **jamais confiance** à l'événement reçu : il
recharge toujours via l'API REST déjà autorisée (own/scope, RLS, etc.) — le
push est un indice de rafraîchissement, jamais une donnée.

`backend/realtime-routes.js` — surface HTTP, montée à `/api/realtime` **sans**
`auth.authMiddleware` global (le flux `/stream` s'authentifie lui-même, voir
plus bas) :

- `POST /api/realtime/ticket` (authentifiée normalement, `Authorization:
  Bearer`) — émet un ticket à usage unique, 30 s.
- `GET /api/realtime/stream` — Bearer **ou** ticket (`?ticket=`). Résout le
  périmètre exactement comme `backend/alerts.js` (PG-8) : sans membership
  actif, 403 `Accès au périmètre refusé`, même message que les autres routes.

### Pourquoi un ticket

`EventSource` (l'API navigateur pour SSE) ne peut envoyer aucun en-tête
personnalisé — impossible d'y passer `Authorization: Bearer`. Mettre le JWT
long-lived directement dans l'URL de connexion serait dangereux (journaux
serveur/proxy, en-tête `Referer`). Le ticket résout ceci : émis par un appel
REST authentifié normalement, à usage unique, 30 secondes de validité,
consommé exactement une fois par la connexion `/stream` elle-même — jamais
réutilisable, jamais journalisé (voir `backend/security-audit.js`, aucun
event `realtime.*` n'a été ajouté à PG-10 : un ticket n'est pas un événement
de sécurité au sens de ce journal, il n'autorise rien de plus que la session
qui l'a émis). Un client capable d'envoyer un en-tête (tests, un futur client
non-navigateur) utilise directement le Bearer token — le ticket n'est qu'un
repli pour `EventSource`.

### Filtrage par périmètre

Résolu **une fois**, à la connexion (`scope.resolveScope` + `tenantAccess`,
PG-8) :

- `alertAccess === 'scope'` (SOC) : reçoit tout événement dont
  `payload.tenantId` correspond au tenant de l'abonné.
- `alertAccess === 'own'` : reçoit uniquement les événements dont
  `payload.createdBy` correspond à son propre `user.id`.

Aucun contenu d'alerte n'étant jamais transmis, un faux positif de filtrage
ne pourrait révéler qu'un identifiant d'alerte et un horodatage — jamais site,
type, niveau, commentaire. Le filtrage par tenant reste néanmoins appliqué,
cohérent avec la posture multitenant établie depuis PG-8/PG-9.

## Câblage

`backend/alert-core/service.js#create` et `#act` émettent respectivement
`alert:created` / `alert:updated`, **après** résolution de `atomic()` (jamais
avant — un événement émis avant un COMMIT réel serait un faux signal).
`service.js` garde son contrat testé (aucun appel SQL propre, exports
inchangés) : `realtime.emit` est un appel synchrone en mémoire, jamais une
requête.

### Limite assumée : émission "au moins probablement", pas garantie

Quand `create()`/`act()` sont appelés avec un `transactionClient` **parent**
(le cas de `fromIncident`/`fromBadge`, déclenchés depuis `POST /incidents` ou
`POST /pietons`), `atomic()` ne fait alors que relâcher un SAVEPOINT — la
transaction *parente* peut encore échouer après coup. Émettre à cet instant
reste un risque résiduel faible et documenté : au pire un rafraîchissement
client inutile (l'API REST rechargée ne montrera simplement rien de nouveau),
jamais une fuite de contenu. Retarder l'émission jusqu'à la certitude absolue
du commit final aurait exigé de faire remonter un callback post-commit
depuis `backend/database.js` à travers toute la pile d'appels — complexité
non justifiée par la conséquence réelle de ce cas rare.

### Ce qui n'émet pas d'événement (limite assumée)

`escalateDue` (minuteur d'escalade, PG-1) ne déclenche aucun `alert:updated` :
il n'a pas de `user` authentifié (tâche système), donc aucun `tenantId` à
résoudre sans une requête supplémentaire par alerte escaladée — non justifié
pour ce lot. Un client verra l'escalade à sa prochaine reconnexion ou
son prochain rafraîchissement REST, pas immédiatement.

## Limite d'échelle assumée

Le bus est un `EventEmitter` en mémoire : un déploiement à plusieurs
processus/instances ne diffuserait qu'aux clients connectés à l'instance qui
a traité la mutation. Non construit ici : `server.js` ne fait tourner qu'un
seul processus aujourd'hui, et la suite naturelle (PostgreSQL LISTEN/NOTIFY,
canal partagé entre instances) serait de la sur-ingénierie sans besoin
démontré — à réévaluer si/quand un déploiement multi-instance devient réel.
