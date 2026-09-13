# SécuriSite — bouton de détresse (PG-15)

Aucun fournisseur externe requis. Réutilise intégralement l'infrastructure
déjà construite (Alert Core PG-1/2, temps réel PG-12, push PG-13, audit
PG-10) — PG-15 n'ajoute qu'un chemin de déclenchement dédié, sans dupliquer
aucune de leurs garanties.

## Principe : le SOS fonctionne indépendamment de l'IA

Rappel du contrat : **le SOS doit fonctionner indépendamment de l'IA.
L'IA ne doit jamais être l'autorité des transitions critiques.**
`backend/alert-core/service.js#sos` n'appelle et ne dépend d'aucun module
IA — aucun n'existe encore dans ce dépôt (PG-19+). `tests/postgres-sos.test.js`
fige cette propriété par une recherche de motif sur le code source
(`openai|anthropic|ai-provider|llm`), pour qu'une future intégration IA
(PG-19+) ne puisse jamais silencieusement s'insérer dans ce chemin précis
sans faire échouer ce test — un rappel explicite au moment où quelqu'un
tenterait de le faire.

## Backend

`POST /api/alerts/sos` (`backend/alerts.js`), derrière la même chaîne de
middlewares que toute route Alert Core (PG-8 : révocation de session,
périmètre actif requis — 403 `Accès au périmètre refusé` sinon, exactement
comme les autres routes).

`service.sos(input, user, transactionClient)` — **aucun champ requis** :
sous contrainte réelle, aucune friction. `level` et `type` ne sont **jamais**
au choix de l'appelant, quoi qu'il soumette : toujours `4` / `'SOS'`. Un
`site` explicite est honoré s'il est fourni (ex. un poste connu) ; à défaut,
`'Position non précisée — <username>'` identifie au moins qui a déclenché.
Réutilise `create()` telle quelle : même transaction, même audit
(`security_audit.event_type = 'alert.create'`, `detail.alert_origin = 'SOS'`,
`origin = 'http'` — un humain a pressé le bouton, jamais `'system'`), même
émission temps réel (`alert:created`) et push — aucun code de livraison
dupliqué.

`service.js` garde son contrat testé : `sos` est la seule nouvelle export
ajoutée (mise à jour explicite de la liste verrouillée dans
`tests/postgres-alert-core-service.test.js`), toujours aucun appel SQL
propre à `service.js`.

## Frontend (`frontend/js/sos.js`)

Isolé de `app.js` : un flux de sûreté critique ne doit dépendre d'aucun
autre état applicatif. **Appui maintenu (~1,5 s)**, pas un simple clic :
un appui accidentel ne doit pas déclencher une fausse alerte, mais aucune
boîte de confirmation ne doit ralentir un déclenchement réel. Accessible
au clavier (Entrée/Espace maintenus). Bouton flottant, toujours visible,
indépendant de la page affichée. Envoi immédiat au relâchement complet de
la jauge ; retour visible (`notify(...)`) succès ou échec, jamais de blocage
silencieux.

### Non fait dans ce lot

Pas de géolocalisation navigateur jointe automatiquement à l'appel : le
prompt de permission introduirait un délai et une friction incompatibles
avec un déclenchement d'urgence sans confirmation — amélioration future
possible si un besoin réel est démontré, jamais ajoutée sans preuve
(cohérent avec la discipline PG-11).

## Tests

`tests/postgres-sos.test.js` : zéro champ requis, niveau/type jamais
substituables par l'appelant (même avec une tentative explicite), porte de
périmètre identique aux autres routes Alert Core, visibilité own/scope
identique à une alerte ordinaire, audit exact (`alert.create` /
`alert_origin=SOS` / `origin=http`), diffusion temps réel et push réellement
observées, absence de toute dépendance IA dans le chemin.
