# SécuriSite — IA : architecture et résumés (PG-19, PG-20)

## Portée

PG-19 est explicitement une "architecture" (MASTER ROADMAP §23) : créer
l'interface `AIProvider`, sans brancher aucun fournisseur externe —
`backend/ai/provider.js`, aucune route HTTP ni page frontend.

PG-20 (§24) construit les premières fonctions concrètes dessus : résumé
d'alerte, résumé de timeline, rapport de clôture, résumé d'incident, résumé
de shift SOC — `backend/ai/summaries.js`, exposées via HTTP et un point
d'entrée minimal dans le Centre d'alertes. PG-21 (assistant SOC
conversationnel) reste un lot distinct, non entrepris ici.

## Aucun fournisseur réel

Choisir et brancher un fournisseur externe (OpenAI, Anthropic, etc. —
n'importe lequel nécessitant une clé) reste un HUMAN CHECKPOINT REQUIRED
(MASTER ROADMAP §2, condition B "un secret externe réel est requis").
`LocalAIProvider`, seul provider actif aujourd'hui, ne fait **aucun appel
réseau** et renvoie un texte déterministe explicitement étiqueté
`simulated: true` — jamais présenté comme un vrai modèle de langage.

Remplacer ce provider par un vrai se limite à un appel à
`configureProvider(unRealProvider)` : rien d'autre dans le code base n'a à
changer — c'est le point d'extension unique, exactement le même principe
que `frontend/js/map-provider.js` (PG-17) pour la cartographie.

## L'IA est assistante, jamais autorité — structurel, pas une convention

Le contrat `AIProvider` (duck typing, une seule méthode) :

```js
async complete({ prompt, context }) -> { text, provider, generatedAt, simulated? }
```

- Un provider ne reçoit **jamais** de référence vers la base de données,
  `backend/alert-core/repository.js` ou `backend/alert-core/service.js` —
  seulement des données déjà lues et déjà autorisées par l'appelant
  (own/scope, PG-8). Il ne peut structurellement rien écrire : aucune
  méthode du contrat ne le permettrait, même si un fournisseur malveillant
  ou bogué le tentait.
- `complete()` ne renvoie que du texte. Un futur appelant (PG-20/21) reste
  seul responsable d'agir — ou non — sur ce qu'une IA suggère, via les
  mêmes routes et vérifications qu'une action humaine (jamais un
  court-circuit vers `service.act()`/`service.create()`).
- Prouvé par test (`tests/ai-provider.test.js`) : la surface du module
  n'expose aucun nom évoquant une capacité d'écriture (`create`, `update`,
  `delete`, `act`, `write`, `mutate`, `transition`).

## Rédaction défensive du contexte

`context` transitera un jour vers un fournisseur externe réel (après
checkpoint). `buildSafeContext()` retire **récursivement** toute
clé/valeur ressemblant à un secret — même motif que
`backend/security-audit.js#sanitizeDetail` (PG-10), réutilisé ici via
`FORBIDDEN_DETAIL_PATTERN` exporté, jamais dupliqué — avant qu'aucun
provider, y compris le local, ne la voie :

- une clé suspecte (`password`, `token`, `jwt`, `secret`, `api_key`,
  `cookie`, `session`, `authoriz…`, `database_url`, `dsn`, `sql`,
  `stack`, …) est retirée entièrement, à n'importe quelle profondeur,
  tableaux inclus ;
- une valeur longue (>40 caractères) contenant un de ces motifs est
  retirée même sous une clé anodine (ex. un jeton collé par erreur dans un
  commentaire libre).

`sanitizeDetail` (PG-10) exige un objet plat — adapté à un journal d'audit
à un seul niveau. Un contexte IA est légitimement imbriqué (une alerte avec
sa timeline, un lot d'alertes pour un résumé de shift) : `redact()` est
donc récursif, avec une borne de profondeur défensive (8) qui protège aussi
contre une éventuelle référence circulaire.

Défense en profondeur, pas la seule ligne de défense : l'appelant (PG-20/21)
reste responsable de ne jamais construire ce contexte à partir de champs
sensibles au départ.

## Tests (PG-19)

`tests/ai-provider.test.js` : provider par défaut simulé/sans réseau,
rédaction récursive (clé à toute profondeur, tableau, valeur longue),
`configureProvider` valide le contrat et peut être remplacé/restauré,
`complete()` rédige toujours le contexte avant l'appelant réel (prouvé via
un provider espion), et absence structurelle de toute capacité d'écriture
sur la surface du module.

## PG-20 — résumés : périmètre et étiquetage

`backend/ai/summaries.js` ne lit **que** via les points d'autorité déjà
testés du reste de l'application — jamais un accès parallèle à la base :

- `summarizeAlert`/`summarizeTimeline`/`closingReport` passent par
  `service.detail(id, user, client)` (own/scope + tenant, PG-8/PG-16) :
  une alerte hors périmètre renvoie le même 404 "Alerte introuvable"
  qu'ailleurs, jamais un comportement différent pour la voie IA.
- `summarizeShift` passe par `service.list(user, client)` et exige en plus
  `user.isSoc` (403 sinon) — un résumé agrégé sur plusieurs alertes est un
  usage SOC, pas un usage "own", même principe que les autres actions
  réservées au SOC (`/rules`, escalade manuelle…).
- `summarizeIncident` lit `incidents` directement (comme
  `GET /api/incidents` aujourd'hui) : **hérite exactement de la même
  limite** que le reste de la fonctionnalité incidents — `incidents` ne
  porte toujours aucune colonne tenant/site/zone (PG-8/PG-16 inchangé,
  voir `docs/soc.md`) — aucun filtrage supplémentaire inventé ici, ce
  n'était pas le périmètre de ce lot.

**"Les résultats IA doivent être identifiés comme générés"** (§24) :
`label()` pose `generated_by_ai: true` sur **chaque** retour,
inconditionnellement — jamais une confiance dans le fait qu'un futur
provider réel s'auto-déclare correctement. Côté frontend, le panneau de
résumé (`frontend/js/alerts.js#aiSummary`) porte son propre bandeau
"✨ Généré par IA — à vérifier, jamais une décision automatique", visuellement
séparé (`.ac-ai-summary`, bordure en pointillés) du reste du détail rédigé
par des humains.

## Surface HTTP (PG-20)

Toutes en lecture seule (`GET`), aucune n'écrit quoi que ce soit :

- `GET /api/alerts/:id/summary`, `/timeline-summary`, `/closing-report`
- `GET /api/alerts/shift-summary?since_hours=` (SOC uniquement ; monté
  **avant** `GET /api/alerts/:id` dans `backend/alerts.js`, sinon capturé
  comme un id d'alerte littéral `"shift-summary"`)
- `GET /api/incidents/:id/summary`

## Frontend (PG-20)

Un seul point d'entrée, volontairement minimal : un bouton "✨ Résumé IA"
dans le détail d'une alerte (Centre d'alertes), jamais chargé
automatiquement (coût d'appel, et un résumé n'a de sens que sur demande
explicite). `frontend/js/alerts.js#aiSummary` ignore toute réponse arrivée
après que la sélection a changé (même garde `id !== selected` que le reste
du fichier) — jamais un résumé de l'alerte précédente affiché par erreur
sur la nouvelle. Timeline/rapport de clôture/résumé de shift restent
disponibles via l'API sans point d'entrée dédié dans l'UI pour ce lot —
scope volontairement resserré ; un futur lot (PG-21 ou une passe UI
dédiée) pourra les exposer.

## Tests (PG-20)

`tests/postgres-ai-summaries.test.js` (HTTP, PostgreSQL réel) : chaque
résumé étiqueté `generated_by_ai: true` même avec un provider espion qui ne
le déclare jamais lui-même, contenu du contexte envoyé au provider prouvé
(timeline seule pour `timeline-summary`, pas l'alerte entière), isolation
tenant héritée de `service.detail` (404 cross-tenant), garde SOC de
`shift-summary` (403 pour un agent "own"), routage `/shift-summary` avant
`/:id` prouvé par une requête réelle, résumé d'incident (200/404), et
rédaction défensive prouvée de bout en bout (un commentaire d'alerte
contenant un jeton est retiré avant d'atteindre le provider).
`tests/notifications.test.js` (frontend, vm) : panneau jamais chargé
automatiquement, rendu labellisé après clic, échec affiché explicitement,
réponse tardive ignorée après changement de sélection.
