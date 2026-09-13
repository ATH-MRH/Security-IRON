# SécuriSite — architecture IA (PG-19)

## Portée de ce lot

PG-19 est explicitement une "architecture" (MASTER ROADMAP §23) : créer
l'interface `AIProvider`, sans brancher aucun fournisseur externe. Aucune
fonctionnalité concrète (résumés, assistant) n'est livrée ici — ce sera
PG-20 (résumés) et PG-21 (assistant SOC), qui consommeront cette interface.
Ce lot n'ajoute donc aucune route HTTP ni page frontend : uniquement
`backend/ai/provider.js`.

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

## Tests

`tests/ai-provider.test.js` : provider par défaut simulé/sans réseau,
rédaction récursive (clé à toute profondeur, tableau, valeur longue),
`configureProvider` valide le contrat et peut être remplacé/restauré,
`complete()` rédige toujours le contexte avant l'appelant réel (prouvé via
un provider espion), et absence structurelle de toute capacité d'écriture
sur la surface du module.
