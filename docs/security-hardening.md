# SécuriSite — hardening sécurité (PG-25)

Revue offensive/défensive complète (MASTER ROADMAP §29). Ce document liste
ce qui a été **trouvé et corrigé**, et ce qui a été **vérifié et jugé déjà
correct** (pas de changement inventé sans preuve d'un défaut réel).

## Corrigé

### 1. JWT_SECRET — secret par défaut codé en dur

`backend/auth.js` repliait sur `'dev-secret-change-me'` si `JWT_SECRET`
n'était pas configuré. Ce secret est public (présent dans l'historique
Git) : sur tout déploiement où la variable aurait été oubliée, n'importe
qui pouvait forger un JWT valide pour **n'importe quel compte, y compris
admin**. Corrigé : fail closed hors test/développement (même convention
que `backend/database.js#configuration`, `['test','development']`), un
secret non fourni y génère un secret aléatoire par processus (jamais
partagé, jamais besoin de survivre à un redémarrage en test) ; un secret
explicite de moins de 32 caractères est refusé. Testé par spawn de
processus réels (`tests/auth-secret.test.js`) — le module lève à
l'exigence, impossible à re-`require()` avec un env différent dans le même
processus.

### 2. CORS grand ouvert

`app.use(cors())` sans options reflétait n'importe quelle origine. Ce
serveur sert le frontend ET l'API sur la même origine
(`express.static` + `/api/*`) : aucun besoin cross-origin démontré.
Corrigé : `{origin:false}` par défaut (aucun en-tête CORS, sans effet sur
les requêtes same-origin du frontend lui-même), `ALLOWED_ORIGIN`
(optionnel, liste séparée par des virgules) pour un futur déploiement
séparé.

### 3. Aucun en-tête de sécurité HTTP

Express n'en pose aucun par défaut. Ajoutés sans nouvelle dépendance :
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: same-origin`. Pas de `Content-Security-Policy`
générique : une CSP correcte dépend du contenu réel de chaque page
(scripts/styles déjà en place) et une valeur mal calibrée casserait le
frontend sans bénéfice réel — à calibrer explicitement si/quand
nécessaire, jamais devinée.

### 4. Brute-force sur `/auth/login` — aucune protection

Un mot de passe pouvait être deviné par essais illimités. Deux compteurs
en mémoire (par processus, best-effort — même modèle que `realtime.js`/
`push.js`, PG-12/PG-13), comptant uniquement les **échecs** (jamais les
succès, pour ne jamais ralentir la suite de tests ni un usage légitime) :

- **par compte ciblé** (IP+identifiant) : 10 échecs tolérés, le 11ᵉ refusé
  (429) — protège un compte précis d'un essai exhaustif ;
- **par IP** : 50 échecs tolérés — protège contre une pulvérisation sur de
  nombreux comptes différents depuis une même source.

Un succès réinitialise le compteur du compte ciblé. Chaque refus est
audité (`auth.login.rate_limited`, `outcome:'denied'`).
`tests/postgres-auth-rate-limit.test.js` (par compte, reset, audit) et
`tests/postgres-auth-ip-rate-limit.test.js` (par IP, isolé dans son propre
processus — il épuise délibérément le compteur partagé).

### 5. Abus du bouton SOS — aucune protection

`POST /api/alerts/sos` (PG-15) n'avait aucune limite. Seuil **très
généreux et par compte** : 20 signaux tolérés par minute — jamais un frein
pour un vrai appel de détresse (y compris plusieurs pressions rapprochées
par doute, ou plusieurs urgences réelles rapprochées) — bloque seulement
un flot automatisé capable de noyer le tableau de bord SOC sous de faux
signaux. Jamais un silence : toujours un 429 explicite, jamais un SOS
avalé sans réponse. `tests/postgres-sos-rate-limit.test.js`.

### 6. Révocation de session incomplète (RBAC / session)

`backend/alerts.js` revérifiait déjà (PG-10) que le compte JWT existe
toujours à chaque requête — mais **`backend/routes.js` ne le faisait pas**
(ni `/admin/*`, ni le reste des routes métier). Un JWT reste valide 8h
(`backend/auth.js`) : un compte supprimé, ou un rôle rétrogradé
(admin → agent), restait pleinement actif jusqu'à expiration naturelle du
token sur tout `routes.js` — y compris `/admin/*`. Corrigé : même
mécanisme, étendu à `routes.js`, placé avant toute autre vérification
(y compris avant l'exemption `/admin/*` de `scope.requireScope()`, PG-8 —
un compte inexistant n'a besoin d'aucun périmètre pour être refusé). Même
`event_type` qu'ailleurs (`auth.session.revoked`).
`tests/postgres-session-revocation.test.js` : compte supprimé refusé sur
une route métier (pas seulement Alert Core), événement audité, un admin
rétrogradé perd `/admin/*` immédiatement, un agent promu l'obtient
immédiatement — avec le même token, jamais besoin de se reconnecter.

### 7. XSS stockées (trois occurrences)

Toutes exploitables par un simple compte authentifié (pas besoin d'être
admin, sauf la troisième) — texte libre POSTé par un utilisateur, stocké
tel quel, rendu **sans échappement** pour d'autres utilisateurs (souvent
un admin consultant un tableau partagé) :

- **`frontend/js/app.js` — piétons** : `onclick='editPieton(${JSON.stringify(p)})'`
  intégrait l'enregistrement entier dans un attribut délimité par des
  guillemets simples. `nom`/`point`/`notes` sont du texte libre non
  validé (`POST /pietons`) ; un guillemet simple dans l'un de ces champs
  cassait l'attribut et permettait d'injecter du HTML/JS arbitraire.
  Corrigé : même motif que `editIncident`/`deleteVehicule`/etc. partout
  ailleurs dans ce fichier — ne transporter qu'un identifiant opaque,
  relire l'enregistrement depuis le cache déjà chargé. `p.badge` (affiché
  en clair) également passé sous `escapeHtml()`.
- **LAPI (lecture de plaques)** : `plaque_detectee`/`image`/`confiance`/
  `statut`/`action` (tous texte libre, `POST /lapi`, sans validation
  serveur) rendus sans échappement dans l'historique (miniatures, y
  compris l'attribut `src` d'une `<img>`) et le tableau. Tous passés sous
  `escapeHtml()`.
- **Badges** : `ref` peut être fourni tel quel par l'appelant
  (`POST /badges`, réservé admin — sévérité plus faible, admin-vers-admin)
  et était affiché en clair, y compris dans trois attributs `onclick`.
  Passé sous `escapeHtml()`.

`tests/frontend-xss-hardening.test.js` : garde de régression au niveau
source (le motif dangereux exact ne doit jamais réapparaître ; le motif
sûr doit être présent) — `app.js` est un monolithe DOM de 1000+ lignes
sans harnais de sandbox existant (contrairement à `alerts.js`) ; un test
comportemental complet serait disproportionné pour trois occurrences déjà
identifiées avec précision.

### 8. Porte dérobée admin — mot de passe codé en dur (`POST /admin/system-admin`)

Trouvé lors d'une revue adversariale ultérieure (PG-28, en recherchant
d'autres accès directs aux tables protégées par RLS). `backend/routes.js`
créait un compte `system_admin` (`role:'admin'`) avec un mot de passe
**codé en dur en clair** (`'securisite2026'`), visible dans le dépôt Git et
renvoyé en clair par l'API à **chaque** appel — une vraie porte dérobée,
réellement câblée depuis `frontend/js/app.js#ensureSystemAdmin()` (page
Utilisateurs), pas du code mort. N'importe qui lisant le dépôt (ou ayant
observé une seule réponse HTTP) pouvait se connecter en admin sur tout
déploiement n'ayant jamais changé ce mot de passe.

Corrigé : mot de passe aléatoire (`crypto.randomBytes(18)`), généré et
renvoyé **une seule fois**, à la création du compte (`created:true`). Un
appel ultérieur sur un compte déjà existant ne révèle ni ne réinitialise
jamais le mot de passe (`password:null`, `created:false`) — même
philosophie que `backend/db/postgresql/create-admin.js`, qui n'affiche ni
n'enregistre non plus de mot de passe en clair. Le frontend affiche un
message dédié quand `password` est `null` plutôt que la chaîne littérale
« null ». Testé par `tests/postgres-system-admin.test.js` : création avec
mot de passe aléatoire jamais égal à l'ancien littéral, connexion réelle
avec le mot de passe renvoyé, non-révélation au second appel, 403 pour un
non-admin.

### 9. SSRF non authentifiée — proxy caméras (`GET /api/camera/proxy`, `/stream`)

Trouvé lors de la revue adversariale finale RC (PG-30) — `backend/camera.js`
n'avait jusque-là été examiné (`docs/release-candidate.md`) que sous
l'angle injection de commande (`spawn` en forme tableau, sans `shell:true`
— jugé sûr, et toujours vrai), jamais sous celui de
l'authentification/l'autorisation/la destination réseau.

`GET /api/camera/proxy?src=<url>` était monté **avant** le middleware JWT
(une balise `<img>` ne peut pas envoyer d'en-tête `Authorization`) et
acceptait une URL **arbitraire** fournie par le client, sans aucune
authentification ni vérification de périmètre, transmettait des
identifiants Basic fournis par le client, et désactivait la vérification
TLS (`rejectUnauthorized:false`) — une SSRF non authentifiée exploitable
pour atteindre n'importe quelle adresse réseau joignable par le serveur
(réseau interne, métadonnées cloud `169.254.169.254`, etc.), avec la
réponse distante reflétée au client. `GET /api/camera/stream` (RTSP via
ffmpeg) partageait le même défaut. Côté produit, la fonctionnalité
« Ajouter une caméra IP » (`frontend/js/app.js`) laissait n'importe quel
utilisateur authentifié saisir cette URL/ces identifiants — la cause racine
n'était pas seulement un défaut d'implémentation du proxy, mais une
fonctionnalité en libre-service structurellement incompatible avec une
destination réseau sûre.

Corrigé (réécriture complète, voir `docs/camera-proxy.md` pour le détail) :
le client ne transmet plus jamais qu'un `camera_id` opaque, jamais une URL
ni des identifiants. Authentification par ticket à usage unique lié à une
caméra précise (`POST /api/camera/ticket`, même mécanisme que
`backend/realtime.js` PG-12) ou Bearer direct. Autorisation par périmètre
réel (`backend/scope.js`, comme toute autre ressource). Destination réseau
exclusivement issue d'une configuration SERVEUR
(`backend/camera-registry.js`, fail-closed si absente) — jamais le client.
Défense réseau en profondeur (`backend/ssrf-guard.js`) : loopback/
link-local (métadonnées cloud incluses)/multicast/broadcast toujours
refusés même pour une destination déjà allowlistée (anti-reliaison DNS,
résolution pinnée via l'option `lookup` de `http.request`), RFC1918
toujours autorisé (une caméra vit légitimement sur un LAN privé). TLS
vérifié par défaut, taille de réponse plafonnée, Content-Type limité à
image/vidéo/MJPEG, aucun en-tête distant relayé au-delà de Content-Type,
limite de débit, erreurs génériques sans fuite. La fonctionnalité
« Ajouter une caméra IP » (localStorage, URL arbitraire) est **supprimée**,
pas seulement masquée.

Testé par `tests/ssrf-guard.test.js` (matrice de blocage), `tests/camera-registry.test.js`
(validation stricte, fail-closed), `tests/postgres-camera-ssrf.test.js`
(25 tests, serveur + base réels : les 20 scénarios SSRF requis par la revue
RC + liaison ticket↔caméra + usage unique + Bearer direct + `/list` sans
fuite + limite de débit), `tests/frontend-camera-ssrf-hardening.test.js`
(garde de régression : la fonctionnalité supprimée ne doit jamais
réapparaître).

## Vérifié, jugé déjà correct (aucun changement)

- **Injection SQL** : toutes les requêtes de ce code base utilisent des
  paramètres liés (`$1,$2,…`) — aucune concaténation de chaîne dans une
  requête n'a été trouvée.
- **Mass assignment** : aucune route ne fait `INSERT`/`UPDATE` à partir
  d'un spread (`...req.body`) ou d'`Object.assign`/`Object.keys(req.body)`
  dynamique — chaque champ est référencé explicitement.
- **Prototype pollution** : aucun utilitaire de fusion profonde
  (deep-merge/extend récursif) n'existe dans ce code base — le seul
  vecteur classique de cette classe de bug est absent par construction.
- **IDOR / cross-tenant / RLS / falsification d'audit / injection de
  prompt** : déjà prouvés en profondeur par PG-8/PG-9/PG-10/PG-16/PG-22/
  PG-23 (own/scope, RLS, append-only, contexte IA rédigé) — non
  redupliqué ici.
- **Fuite de secret / fuite d'erreur** : `backend/http-errors.js` ne
  renvoie ni ne journalise jamais un message technique brut (PG-3.3C) ;
  `backend/observability.js` (PG-18) est une liste blanche de champs
  (aucun risque de fuite par oubli) ; `backend/security-audit.js#sanitizeDetail`
  (PG-10, réutilisé par PG-19+) retire tout ce qui ressemble à un secret.
- **Redirections ouvertes** : aucune route ne construit une redirection à
  partir d'une entrée utilisateur — ce code base n'a pas de fonctionnalité
  de redirection du tout.
- **Téléversement de fichiers** : aucune fonctionnalité d'upload
  (`multer` ou équivalent) n'existe dans ce code base — rien à durcir.

## Portée non couverte ici

Détection/corrélation (PG-22), RAG (PG-23) et audit IA (PG-24) ont chacun
déjà leurs propres tests cross-tenant/injection dédiés (voir `docs/ai.md`)
— non redupliqués. Performance/charge (PG-26), sauvegarde/restauration
(PG-27) et déploiement (PG-28) restent des lots distincts.
