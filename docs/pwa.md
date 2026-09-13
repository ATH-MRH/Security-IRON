# SécuriSite — PWA (PG-14)

Aucun fournisseur externe requis (manifest + service worker sont des
standards navigateur, servis statiquement par `express.static`, déjà en
place depuis le début du dépôt). Complète — ne remplace pas — la
distribution Electron existante (`electron/`).

## `frontend/manifest.json`

Champs standards : `name`, `short_name`, `start_url`, `scope`, `display:
standalone`, `background_color`/`theme_color` alignés sur `--bg`/`--primary`
de `css/style.css` (thème sombre par défaut), une icône (le logo existant,
`assets/iron-global-securite-logo.png`, 550×550 — pas encore de jeu
d'icônes redimensionnées 192/512/maskable dédiées ; limite connue, à
affiner si l'installation PWA devient un canal de distribution prioritaire).

## `frontend/sw.js`

- **App shell hors-ligne** : précache HTML/CSS/JS/manifest/icône/vendor
  statique (`chart.umd.min.js`, `qrcode.min.js` — pas le bundle Tesseract,
  volumineux et non essentiel au shell ; mis en cache à l'usage si sollicité).
  Cache-first avec rafraîchissement réseau en arrière-plan : un visiteur
  déjà venu en ligne charge instantanément, même hors-ligne, tout en
  recevant la version la plus récente dès que le réseau revient.
- **`/api/*` jamais intercepté** : ces réponses sont dynamiques et
  authentifiées ; les mettre en cache serait activement dangereux pour une
  application de sûreté (données périmées affichées comme actuelles, fuite
  entre sessions sur un poste partagé). Même règle pour toute requête
  cross-origin (ex. le proxy caméra) et tout verbe non-`GET`.
- **`push` / `notificationclick`** : gestionnaires prêts pour PG-13
  (`backend/push.js`), mais **inertes tant qu'aucun fournisseur push réel
  n'est activé** (voir `docs/push.md` — HUMAN CHECKPOINT non levé). La
  notification affichée reste générique (`{type, id, at}` uniquement, jamais
  le contenu de l'alerte) ; un clic ramène le focus sur l'application déjà
  ouverte ou en ouvre une nouvelle — jamais de contenu embarqué dans la
  notification elle-même.

## Câblage minimal

`index.html` : `<link rel="manifest">`, `<meta name="theme-color">`, et un
enregistrement de service worker **best-effort** (`if ('serviceWorker' in
navigator)`) — un navigateur sans support, ou hors contexte sécurisé
(`http://` hors `localhost`), continue de fonctionner à l'identique, sans
mode hors-ligne ni notifications.

## Non fait dans ce lot

Aucune UI « activer les notifications » n'a été ajoutée : sans clé VAPID
réelle (PG-13, HUMAN CHECKPOINT), un appel `PushManager.subscribe()`
n'aboutirait à aucun abonnement exploitable — ajouter un bouton qui échoue
silencieusement aurait été trompeur. Le câblage temps réel (SSE, PG-12) côté
client (`EventSource`, rafraîchissement de `NotificationBell`) n'a pas non
plus été ajouté ici : `app.js`/`notifications.js` restent inchangés au-delà
du script d'enregistrement du service worker — l'intégration SOC de ces flux
relève naturellement de PG-16 (SOC nouvelle génération), pas de
l'installabilité PWA elle-même.

## Tests

`tests/postgres-pwa.test.js` : manifest servi avec les champs requis et des
icônes réellement présentes sur disque ; `sw.js` servi en JavaScript,
syntaxiquement valide, n'intercepte jamais `/api/*` ; chaque fichier précaché
existe réellement et est servable (détecte toute dérive si un fichier
JS/CSS est renommé sans mettre à jour la liste) ; gestionnaires push/
notificationclick présents et strictement limités à `{type, id, at}` ;
`index.html` référence bien le manifest et enregistre le service worker.
