# SécuriSite — proxy caméras IP (PG-30, correctif de sécurité)

## La vulnérabilité corrigée

`GET /api/camera/proxy?src=<url>` (et `/stream` pour RTSP) était monté
**avant** le middleware JWT (une balise `<img>` ne peut pas envoyer
d'en-tête `Authorization`) et acceptait une URL **arbitraire** fournie par
le client, sans aucune vérification de périmètre, transmettait des
identifiants Basic fournis par le client, et désactivait la vérification
TLS (`rejectUnauthorized:false`). Côté produit, la fonctionnalité
« Ajouter une caméra IP » (`frontend/js/app.js`) laissait n'importe quel
utilisateur saisir cette URL/ces identifiants, stockés en `localStorage` et
transmis tels quels au proxy.

Résultat : une **SSRF non authentifiée** — quiconque pouvait joindre le
serveur pouvait lui faire contacter n'importe quelle adresse réseau qu'il
pouvait lui-même joindre (réseau interne, métadonnées cloud
`169.254.169.254`, etc.) et recevoir la réponse reflétée. Trouvé lors de la
revue adversariale finale RC (PG-30), non détecté par les revues de
sécurité précédentes de la session (`docs/security-hardening.md`, qui
n'avait examiné ce fichier que sous l'angle injection de commande).

## Le modèle corrigé

Le client ne transmet plus **jamais** qu'un `camera_id` opaque — jamais une
URL, jamais des identifiants.

```
GET  /api/camera/list                          (authentifié, périmètre)
       -> [{ id, name, type, streamMode }, ...] jamais url/authUser/authPass

POST /api/camera/ticket   { camera_id }         (authentifié, périmètre)
       -> { ticket, expiresIn }                 ticket à usage unique, 30 s,
                                                 lié à CE camera_id précis

GET  /api/camera/proxy?camera_id=<id>&ticket=<t>   (ticket OU Bearer direct)
GET  /api/camera/stream?camera_id=<id>&ticket=<t>  (idem, flux RTSP->MJPEG)
```

Le ticket rejoue le même mécanisme que `backend/realtime.js` (PG-12) —
`<img>`/`<video>` ne peuvent pas envoyer d'en-tête — mais lié en plus au
`camera_id` pour lequel il a été émis : impossible à rejouer sur une autre
caméra, même par le même utilisateur.

### 1. Configuration serveur (`backend/camera-registry.js`)

Seule source de vérité des caméras joignables. Chargée depuis un fichier
JSON local (`SECURISITE_CAMERAS_CONFIG_FILE`), **jamais committé**, édité
par un opérateur humain sur le serveur — pas une interface web
d'administration : aucun modèle de persistance caméra n'existait avant ce
correctif, et en construire un (migration, table, routes CRUD) aurait
dépassé la portée d'un correctif de sécurité. Variable absente ou fichier
absent → registre **vide** → le proxy refuse tout (fail-closed), jamais
« ouvert par défaut » comme avant ce correctif.

Format (tableau JSON) :

```json
[
  {
    "id": "entree-principale",
    "name": "Entrée principale",
    "type": "http",
    "url": "http://192.168.1.50/snapshot.jpg",
    "tenantId": "<uuid tenant>",
    "siteId": null,
    "zoneId": null,
    "authUser": "admin",
    "authPass": "…",
    "insecureTls": false,
    "streamMode": "snapshot"
  }
]
```

- `id` : `[a-zA-Z0-9_-]{1,64}`, unique.
- `type` : `'http'` (snapshot JPEG / MJPEG, protocole `http:`/`https:`) ou
  `'rtsp'` (protocole `rtsp:`, converti en MJPEG par ffmpeg).
- `streamMode` (`type:'http'` uniquement) : `'snapshot'` (défaut, image
  rafraîchie côté client) ou `'mjpeg'` (flux HTTP continu). Sans effet sur
  la sécurité — seulement une indication pour le frontend.
- `tenantId`/`siteId`/`zoneId` : périmètre de la caméra, vérifié contre le
  périmètre réel de l'appelant (`backend/scope.js`) — exactement comme
  n'importe quelle autre ressource de ce code base. `siteId`/`zoneId`
  absents = caméra visible à tout membership du tenant.
- `authUser`/`authPass` (optionnels) : identifiants Basic Auth envoyés à LA
  CAMÉRA — jamais transmis au client, jamais journalisés.
- `insecureTls` (défaut `false`) : autorise un certificat auto-signé pour
  CETTE caméra précisément. Jamais un interrupteur global, jamais
  influençable par le client.

Une entrée pointant vers une IP littérale interdite (loopback, link-local,
multicast — voir plus bas) est refusée **au chargement**, avant même la
première requête.

### 2. Autorisation (`backend/scope.js`, inchangé)

`camera.tenantId/siteId/zoneId` vérifié via `scope.resolveScope(userId)
.allows(...)` — même fonction que le reste du code base. Caméra inconnue OU
hors périmètre : **même 404** (non-divulgation — ne jamais confirmer
l'existence d'une caméra à quelqu'un qui n'y a pas accès, même convention
que `GET /alerts/:id` pour une alerte d'un autre tenant).

### 3. Défense réseau en profondeur (`backend/ssrf-guard.js`)

Même pour une destination déjà allowlistée par un opérateur : une erreur de
configuration ou une reliaison DNS (DNS rebinding) ne doit jamais suffire à
faire contacter au serveur une adresse sensible.

Toujours refusées :
- loopback (`127.0.0.0/8`, `::1`)
- non spécifiée (`0.0.0.0/8`, `::`)
- link-local (`169.254.0.0/16`, `fe80::/10`) — **inclut les métadonnées
  cloud** (`169.254.169.254`)
- multicast (`224.0.0.0/4`, `ff00::/8`) et broadcast (`255.255.255.255`)

Toujours autorisées par défaut : les plages RFC1918 (`10/8`, `172.16/12`,
`192.168/16`) et toute autre adresse unicast normale — une caméra de
vidéosurveillance vit légitimement sur un LAN privé ; les bloquer
aveuglément casserait l'usage normal du produit. Aucune exception par
caméra à la liste des adresses toujours refusées.

`guardedLookup` a exactement la signature attendue par l'option `lookup` de
`http.request`/`https.request` (Node) : l'adresse validée est donc celle
**réellement utilisée** pour la connexion TCP — pas une vérification
séparée suivie d'une résolution DNS distincte, qui laisserait une fenêtre
de reliaison DNS entre la vérification et la connexion.

### 4. Durcissement de la réponse (`backend/camera.js`)

- TLS vérifié par défaut (`rejectUnauthorized`) — seule `insecureTls:true`
  (configuration serveur) le désactive, jamais un paramètre client.
- Aucun redirect (3xx) suivi automatiquement (Node ne le fait déjà pas par
  construction) ; une réponse 3xx échoue l'allowlist de Content-Type
  (rarement `image/*`) et n'est donc jamais relayée telle quelle.
- Content-Type limité à `image/*`, `multipart/x-mixed-replace`, `video/*`
  — le proxy ne sert jamais de contenu arbitraire (HTML, JSON, binaire
  quelconque).
- Taille de réponse plafonnée (50 Mio) — coupe une réponse/un flux runaway.
- Aucun en-tête de la réponse distante relayé au-delà de `Content-Type` —
  jamais de `Set-Cookie`, jamais de `Location`.
- Limite de débit par utilisateur (120 requêtes/minute — même idiome que le
  SOS, `backend/alerts.js`).
- Erreurs génériques uniquement (`Caméra injoignable.`) — jamais l'URL, une
  adresse IP interne, un identifiant ou un détail réseau brut.

## Ce que le client ne peut plus jamais faire

- Fournir une URL de caméra (`?src=`) — le paramètre est ignoré.
- Fournir des identifiants (`?user=&pass=`) — ignorés, seuls ceux de la
  configuration serveur sont utilisés.
- Ajouter/modifier/supprimer une caméra depuis le navigateur — la
  fonctionnalité « Ajouter une caméra IP » (localStorage, URL arbitraire)
  a été **supprimée**, pas seulement masquée : c'était la cause racine, au
  niveau produit, de la SSRF. Une caméra n'existe que si un opérateur l'a
  ajoutée à `SECURISITE_CAMERAS_CONFIG_FILE` sur le serveur.

## Limite opérationnelle assumée

Pas d'interface d'administration web pour gérer les caméras (édition du
fichier de configuration serveur uniquement) — délibéré, pour ne pas
construire un modèle de persistance complet (migration, table, routes CRUD)
dans le cadre d'un correctif de sécurité. Une future évolution pourrait
migrer ce registre vers PostgreSQL si le besoin d'une gestion en libre-service
(opérateur, pas utilisateur final) est démontré.

## Tests

- `tests/ssrf-guard.test.js` : matrice de blocage, injection de test
  (`configureLookup`), pinning DNS.
- `tests/camera-registry.test.js` : validation stricte au chargement,
  fail-closed par défaut.
- `tests/postgres-camera-ssrf.test.js` (25 tests, serveur réel + base
  PostgreSQL réelle) : les 20 scénarios SSRF requis (sans auth, session
  révoquée, mauvais tenant/site, caméra inconnue, URL arbitraire impossible,
  destinations interdites simulées par DNS, redirect jamais suivi,
  identifiants client ignorés, TLS invalide/autorisé, fonctionnement
  normal, timeout, taille plafonnée, content-type inattendu, en-têtes
  jamais reflétés, aucune fuite de secret) + liaison ticket↔caméra, usage
  unique du ticket, Bearer direct, `GET /list` sans fuite, limite de débit,
  fail-closed sans configuration.
- `tests/frontend-camera-ssrf-hardening.test.js` : garde de régression au
  niveau source — la fonctionnalité client supprimée ne doit jamais
  réapparaître.
