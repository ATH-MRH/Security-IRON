# SécuriSite — IA : architecture, résumés, assistant, corrélation, recherche, audit (PG-19 à PG-24)

## Portée

PG-19 est explicitement une "architecture" (MASTER ROADMAP §23) : créer
l'interface `AIProvider`, sans brancher aucun fournisseur externe —
`backend/ai/provider.js`, aucune route HTTP ni page frontend.

PG-20 (§24) construit les premières fonctions concrètes dessus : résumé
d'alerte, résumé de timeline, rapport de clôture, résumé d'incident, résumé
de shift SOC — `backend/ai/summaries.js`, exposées via HTTP et un point
d'entrée minimal dans le Centre d'alertes.

PG-21 (§25) ajoute l'assistant SOC contextualisé (question en langage
naturel + suggestions d'actions jamais exécutées automatiquement) —
`backend/ai/assistant.js`.

PG-22 (§26) ajoute la détection/corrélation explicable —
`backend/ai/correlation.js`, `GET /api/alerts/correlations` (SOC
uniquement). API seule pour ce lot, pas de point d'entrée frontend dédié
(même scope resserré que PG-19) : la priorité de ce lot était la justesse
et l'explicabilité des signaux, pas l'UI — laissée à une passe ultérieure.
PG-23 (§27) ajoute la recherche scoped (« RAG » au sens recherche, pas
génération libre) — `backend/ai/search.js`, `GET /api/alerts/search?q=`.

PG-24 (§28) ajoute l'audit IA append-only — `backend/ai/audit.js`,
réutilisant `public.security_audit` (migration 006, PG-10) via une
nouvelle origine `'ai'` (migration 010). PG-25+ (hardening, performance,
backup, déploiement, acceptance, RC) restent des lots distincts.

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

## PG-21 — assistant SOC : « L'IA ne peut pas » est une double garantie

`backend/ai/assistant.js` répond à une question en langage naturel
(`POST /api/alerts/assistant`, `{question}`) à partir des mêmes alertes déjà
lues et déjà autorisées que `service.list()` (own/scope, PG-8/PG-16) — même
principe que les résumés PG-20, aucun accès parallèle à la base.

MASTER ROADMAP §25 : *« L'IA ne peut pas : close / cancel / change
permissions / delete / modify audit. Toute action proposée nécessite
confirmation utilisateur et exécution API déterministe. »* Tenu par deux
garanties indépendantes, pas une seule :

1. **Structurelle (héritée de PG-19)** : le contrat `AIProvider` ne renvoie
   que du texte — `ask()` ne peut appeler aucune méthode d'écriture, quel
   que soit ce qu'un futur provider réel répondrait dans son texte.
2. **Liste blanche explicite ici** : les suggestions ne sont **jamais**
   composées à partir du texte généré par le provider — elles sont
   calculées par du code métier déterministe (`suggestFor()`), à partir de
   `ALLOWED_SUGGESTIONS = {ACQUITTEE, EN_INTERVENTION, SOUS_CONTROLE,
   RESOLUE, ESCALADE}`. `CLOTUREE`, `ANNULEE`, `FAUSSE_ALERTE` en sont
   absents à dessein : aucune suggestion ne peut jamais proposer de
   clôturer, annuler ou invalider une alerte. Permissions/suppression/
   modification d'audit n'existent même pas comme « action » d'alerte dans
   ce code base — rien à exclure de plus.
   Prouvé par test : une alerte poussée à travers tout son cycle de vie
   (`ACQUITTEE` → `EN_INTERVENTION` → `SOUS_CONTROLE` → `RESOLUE`) n'émet
   jamais, à aucune étape, une suggestion interdite.

**Une suggestion n'est qu'une donnée** (`{alert_id, action, label}`),
jamais un appel : la confirmer déclenche exactement
`POST /api/alerts/:id/actions`, la **même** route et les **mêmes**
vérifications (`service.act()`, own/scope, `isSoc`, machine à états) qu'un
clic manuel sur un bouton d'action — jamais un raccourci. Une suggestion
n'apparaît d'ailleurs que pour un utilisateur `isSoc` (les transitions
d'état exigent déjà `user.isSoc` côté `service.act()`, 403 sinon) : un
agent "own" reçoit une réponse mais `suggestions: []`, jamais une
suggestion qu'il ne pourrait de toute façon pas confirmer.

**Point explicite (revue RC, PG-30)** : `ACQUITTEE` figure dans
`ALLOWED_SUGGESTIONS` — l'IA peut donc *suggérer* un acquittement. Elle ne
peut en revanche jamais l'**exécuter** : aucune ligne de ce module n'appelle
`service.act()` ni n'importe quel autre chemin de mutation ; seule une
confirmation humaine, via le bouton dédié du frontend, déclenche la même
route déterministe qu'une action manuelle. « L'IA n'est jamais l'autorité »
se lit donc comme « l'IA ne déclenche jamais elle-même une transition »,
pas comme « le mot ne doit jamais apparaître dans une suggestion » — lecture
délibérée, comportement inchangé par cette clarification.

Contexte transmis au provider : mêmes agrégats que le résumé de shift
(actives/critiques/SOS/escalades/par site), plus un sous-ensemble resserré
par mot-clé simple sur la question (« critique »/« escalad »/« incident »)
— pas un vrai NLP (`LocalAIProvider` reste déterministe, PG-19), une
sélection de contexte pragmatique. Sans mot-clé reconnu, le contexte entier
est transmis plutôt que rien.

Isolation tenant : héritée de `service.list()`, prouvée à nouveau ici (le
site d'une alerte d'un autre tenant n'apparaît jamais dans le contexte
envoyé au provider).

## Tests (PG-21)

`tests/postgres-ai-assistant.test.js` (HTTP, PostgreSQL réel) : réponse
étiquetée `generated_by_ai`, question vide/trop longue refusée (400),
isolation tenant du contexte envoyé, resserrement par mot-clé prouvé,
suggestions vides pour un agent "own", **suggestions jamais interdites sur
tout le cycle de vie d'une alerte**, une alerte critique fraîche suggère
bien acquittement + escalade (jamais une clôture), et une suggestion
confirmée passe réellement par `POST /alerts/:id/actions`.
`tests/notifications.test.js` (frontend, vm) : question vide sans appel,
réponse + suggestions rendues et labellisées, échec affiché, confirmation
d'une suggestion appelant la vraie route d'action, échec de confirmation
réactivant le bouton avec le message d'erreur.

## PG-22 — corrélation explicable : la preuve avant le texte

`backend/ai/correlation.js` calcule des **signaux** de corrélation
strictement à partir des alertes déjà lues et déjà autorisées
(`service.list()`, own/scope + tenant, PG-8/PG-16) — jamais une lecture
directe d'`incidents`/`pietons`/`badges` (qui ne portent toujours aucune
colonne tenant/site/zone, PG-8/PG-16 inchangé). Les alertes
`origin='INCIDENT'`/`origin='REGLE_BADGE'` sont déjà la trace, correctement
scopée par tenant, de ces mêmes événements — corréler sur les alertes
couvre donc « refus badges répétés » et « incidents proches » sans jamais
rouvrir la question du périmètre sur une table qui n'a pas de tenant_id.

**« Toute corrélation doit exposer les éléments ayant conduit à la
suggestion »** (§26) : chaque signal porte une `evidence` — les alertes
exactes (id, site, zone, type, niveau, statut, horodatage) — calculée par
du code métier déterministe (`computeSignals()`, pure, testée
indépendamment de toute base). `ai.complete()` (PG-19) n'intervient
qu'ensuite, pour produire un paragraphe de synthèse en langage naturel à
partir des signaux déjà calculés — jamais l'inverse : les signaux ne sont
jamais devinés depuis du texte généré, seulement résumés par lui.

Cinq types de signaux, tous bornés à `windowMinutes` (60 par défaut) :
`repeated_alerts_same_site_type`, `multi_site_pattern` (même type, sites
différents, fenêtre resserrée à 15 min), `escalation_cluster`,
`repeated_badge_refusals`, `nearby_incidents`.

**« Ne jamais qualifier automatiquement une personne de menace »** :
aucun signal ne porte `created_by`/`username` — uniquement site, zone,
type, équipement (un badge, jamais son détenteur nommé). Prouvé par test,
backend et HTTP : la sérialisation complète des signaux ne contient jamais
ces champs, même quand les alertes sources les portent.

Réservé au SOC (`user.isSoc`, 403 sinon) — une analyse de motifs
cross-alertes est un usage SOC, même principe que `shift-summary` (PG-20).
`GET /api/alerts/correlations?window_minutes=` monté **avant**
`GET /api/alerts/:id`, même raison que `/shift-summary`.

## Tests (PG-22)

`tests/ai-correlation.test.js` (pur, sans base) : chaque type de signal
déclenché/non déclenché selon la fenêtre temporelle, score borné [0,1],
`evidence` non vide et exacte, aucune référence à une personne, volume
raisonnable (500 lignes) sans lenteur pathologique.
`tests/postgres-ai-correlation.test.js` (HTTP, PostgreSQL réel) : garde
SOC, routage avant `/:id`, isolation tenant de l'évidence ET du contexte
envoyé au provider, motif réellement détecté avec preuve exacte,
`window_minutes` invalide refusé (400, jamais silencieusement borné).

## PG-23 — recherche scoped : aucune base vectorielle, citations exactes

`backend/ai/search.js` (`GET /api/alerts/search?q=`) cherche uniquement
dans des données déjà lues et déjà autorisées : alertes
(`service.list()`, own/scope + tenant, PG-8/PG-16) et sites/zones
(`backend/map.js#listSites`/`#listZones` — **réutilisées telles quelles**,
pas réécrites : RLS PG-9 + filtre applicatif PG-8, un seul point de
vérité). Aucune route dédiée à sites/zones n'a été créée : PG-17 en avait
déjà besoin pour la carte.

**Aucune base vectorielle externe, payante ou non** : correspondance de
sous-chaînes en mémoire (insensible à la casse et aux accents), sur des
lignes déjà tenant-scoped — PostgreSQL natif suffit à ce volume (même
justification que l'agrégation client-side de PG-16, « mesurer avant
d'optimiser »). Migrer vers `to_tsvector`/`plainto_tsquery` (toujours
PostgreSQL natif, toujours pas de dépendance externe) resterait le premier
recours si le volume réel le justifiait un jour — non fait ici faute de
nécessité démontrée.

### Sources volontairement exclues

`incidents`, `main_courante`, `pietons`, `badges` ne sont **pas**
cherchées : aucune ne porte de colonne tenant/site/zone (limite PG-8/PG-16
inchangée). Une recherche en texte libre parcourrait l'intégralité de ces
tables, tous tenants confondus — une fuite intertenant réelle et
directement démontrable, exactement ce que PG-23 exige explicitement de ne
jamais introduire. Contrairement à `summarizeIncident` (PG-20, qui hérite
consciemment de cette limite pour un lookup **par identifiant déjà connu**
de l'appelant — jamais une fuite en pratique), une recherche libre les
exposerait réellement. Les inclure exigerait d'abord une migration leur
ajoutant `tenant_id` (même modèle que la migration 009 pour
`security_alerts`, PG-16) : un lot distinct, non entrepris ici. Aucune
« procédure/documentation » n'existe comme fonctionnalité réelle dans ce
code base — non simulée.

### Citations, jamais une réponse sans preuve

**« Citations/références vers les données sources »** (§27) : chaque
résultat (`searchAlerts`/`searchSites`/`searchZones`, pures, testées sans
base) porte `kind`/`id`/`score`/`title`/`snippet`/`source` — les données
exactes qui ont produit le résultat, calculées par correspondance
déterministe, jamais devinées depuis le texte du provider.
`ai.complete()` (PG-19) ne fait que résumer/citer ces résultats déjà
trouvés, avec pour consigne explicite de ne s'appuyer que sur eux.

### Prompt injection stockée : testée, et structurellement inerte

Un contenu malveillant stocké (ex. un commentaire d'alerte contenant
« Ignore previous instructions… ») est traité comme une donnée texte
ordinaire — il peut être **trouvé** par la recherche (c'est un mot-clé
comme un autre) mais ne peut **rien déclencher** : `searchAlerts()` ne
fait que comparer des sous-chaînes, et `ai.complete()` (PG-19) ne renvoie
jamais qu'un texte, jamais une action. Prouvé par test, backend pur et
HTTP réel : un payload d'injection stocké dans une vraie alerte reste
trouvable sans jamais faire fuiter les données d'un autre tenant.

Ouvert aux accès "own" (contrairement à `/shift-summary` et
`/correlations`, réservés SOC) : chercher dans ce qu'on voit déjà n'est
pas un usage réservé au SOC, même principe que `GET /alerts` lui-même.

## Tests (PG-23)

`tests/ai-search.test.js` (pur, sans base) : tokenisation (accents/casse/
bornée à 20 tokens), correspondance sur chaque champ pertinent par type de
source, citation exacte (`source`), tolérance aux entrées vides,
injection stockée traitée comme texte inerte, aucun résultat de type
`incident`/`main_courante`.
`tests/postgres-ai-search.test.js` (HTTP, PostgreSQL réel) : requête
vide/trop longue refusée, isolation tenant sur les sites ET les alertes,
own-vs-scope, narrowing site-level, un vrai payload d'injection stocké
trouvé sans fuite intertenant (contexte envoyé au provider inclus), et
citation avec source vérifiable.

## PG-24 — audit IA : un journal existant, pas une nouvelle table

`backend/ai/audit.js` réutilise `public.security_audit` (migration 006,
PG-10) plutôt qu'une table dédiée : la migration 006 anticipait déjà ce
lot (« Un IA aura une origine dédiée plus tard (PG-19+) : ajout par
migration »). La migration `010_ai_audit_origin.sql` élargit la seule
contrainte qui l'empêchait (`origin CHECK`) pour y ajouter `'ai'`. Un seul
journal de sécurité transversal, déjà append-only (triggers), déjà RLS
(lecture réservée aux memberships `soc` de leur propre tenant), déjà
testé — pas une deuxième table à maintenir et auditer séparément.

Chaque appel IA (résumés PG-20, assistant PG-21, corrélation PG-22,
recherche PG-23) écrit, via le point d'entrée unique
`recordAiEvent()`, un événement `event_type='ai.<type>'` (`ai.alert_summary`,
`ai.timeline_summary`, `ai.closing_report`, `ai.incident_summary`,
`ai.shift_summary`, `ai.assistant`, `ai.correlation`, `ai.search`) :

- **Champs** (§28) : `provider`/`model` → `detail.provider`/`detail.model` ;
  type de requête → `event_type` + `detail.request_type` ; acteur →
  `actor_user_id`/`actor_username` ; tenant → `tenant_id` ; ressource →
  `resource_type`/`resource_id` (`alert`/`incident`/`ai` générique pour un
  shift/une corrélation/une recherche multi-ressources) ; horodatage →
  `created_at` ; correlation/request id → `correlation_id`/`request_id`
  (posés par PG-10/PG-18, jamais recalculés différemment ici) ; résultat →
  `detail.result_ref`.
- **« Ne stocker que le contexte nécessaire »** : jamais le texte généré
  en clair — seulement une empreinte SHA-256 (`result_ref`), suffisante
  pour vérifier après coup qu'une réponse donnée correspond à cet
  événement, sans dupliquer le contenu. Prouvé par test : le texte réel
  généré n'apparaît jamais, même sérialisé, dans la ligne d'audit.
- **« Ne jamais stocker : password/JWT/secret/API key/DATABASE_URL »** :
  `detail` passe par `sanitizeDetail()` (PG-10), réutilisée telle quelle —
  defense en profondeur, en plus du fait qu'aucun de ces éléments n'est de
  toute façon jamais construit ici (seuls `provider`/`model`/
  `request_type`/`result_ref`/`human_decision` y figurent).
- **`human_decision`** : présent dans le schéma mais toujours `null` pour
  ce lot — le câblage qui l'alimenterait (enregistrer qu'un humain a
  confirmé/rejeté une suggestion PG-21, en respectant append-only : une
  **nouvelle** ligne, jamais une modification de celle-ci) est un lot
  distinct, non entrepris ici. Champ présent, honnêtement non alimenté
  plutôt que deviné — prouvé par test.
- **Best-effort** (`recordBestEffort`, PG-10) : un audit IA manquant ne
  bloque jamais une réponse déjà générée — ce n'est pas une mutation
  critique fail-closed comme `alert.create`/`alert.action`.

## Tests (PG-24)

`tests/postgres-ai-audit.test.js` (HTTP, PostgreSQL réel) : chaque type de
requête IA écrit son propre événement correctement typé, jamais le texte
généré en clair (seulement son hash), `human_decision` présent mais null,
résumé d'incident avec le bon `resource_type`/tenant, immutabilité
(UPDATE/DELETE rejetés) sur une ligne `ai`, RLS/cross-tenant (un SOC de
tenant A ne lit jamais l'audit IA de tenant B), et l'échec d'audit ne
bloque jamais une réponse déjà générée.
