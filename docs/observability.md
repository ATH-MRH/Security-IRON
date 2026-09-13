# SécuriSite — observabilité (PG-18)

## Télémétrie opérationnelle : une ligne JSON par requête

`backend/observability.js`, monté juste après `backend/request-context.js`
(PG-10) — avant toute route. Une ligne `console.log(JSON.stringify(...))`
par requête HTTP terminée (`res.on('finish', …)`), sur stdout : cohérent
avec la contrainte "aucune nouvelle dépendance externe payante" (aucune
bibliothèque de logging, aucun agent APM) — un collecteur de logs
(Docker/journald, un agrégateur managé) ingère du JSON sur stdout tel quel ;
c'est le format qui compte, pas le transport.

Champs (MASTER ROADMAP §22) :

```json
{"ts":"…","level":"info","request_id":"…","correlation_id":"…",
 "method":"GET","path":"/api/alerts","status":200,"duration_ms":6.68,
 "tenant_id":"…","site_id":null,"alert_id":null,"error_code":null}
```

- `request_id` — posé par PG-10 (`backend/request-context.js`), un par
  requête HTTP.
- `correlation_id` — suit un en-tête entrant `X-Correlation-Id` s'il est
  fourni par l'appelant (pour relier plusieurs requêtes d'une même
  opération métier côté client, ex. un flux mobile multi-étapes), sinon
  retombe sur `request_id`. Sans rapport avec le `correlation_id` mentionné
  mais volontairement **non posé** par PG-10 pour `security_audit` (un
  journal de sécurité/conformité, contrat différent, voir
  `docs/postgresql-security-audit.md`) — celui-ci est une télémétrie
  opérationnelle, jamais une preuve d'audit.
- `tenant_id` — `req.tenantId`, posé une fois `scope.requireScope()`
  résolu (PG-8/PG-16) ; `null` avant authentification/résolution (login,
  401, sondes non scope).
- `site_id` — le filtre `?site_id=` réellement soumis et déjà validé par
  `scope.requireScope()` s'il est présent, jamais un site déduit ou
  inventé.
- `alert_id` — uniquement sur les routes `/api/alerts/:id/...`
  (`req.baseUrl === '/api/alerts' && req.params.id`) : un `:id` d'une
  autre ressource (incident, badge, …) n'est jamais étiqueté `alert_id`.
- `error_code` — posé par `backend/http-errors.js#sendError` sur
  `res.locals.errorCode`, jamais recalculé dans `observability.js` (un seul
  point de vérité). `null` pour une erreur métier (400–499, ex. "Alerte
  introuvable") : son code n'est pas une donnée machine stable, seul le
  statut HTTP (déjà dans la ligne) la qualifie. Peuplé (SQLSTATE ou
  `err.name`) pour une erreur transitoire/technique (503/500).

## Sécurité : allowlist, jamais une liste noire

La ligne de log ne contient **que** les champs listés ci-dessus. Ni
`req.body`, ni `req.headers`, ni `err.message` ne sont jamais lus par
`observability.js` — un JWT, un mot de passe, `DATABASE_URL`, un jeton push
complet ou une clé IA (aucune n'existe encore dans ce code base) ne peuvent
donc jamais y fuiter, même si l'un de ces éléments existe ailleurs dans la
requête. Une liste noire ("ne jamais logger tel champ") aurait le défaut
d'oublier un futur champ sensible ; une liste blanche ne le peut pas.
Prouvé par test (`tests/postgres-observability.test.js` : le jeton Bearer
réel de la requête testée n'apparaît jamais, même sérialisé, dans la ligne
capturée).

## Sondes exclues du signal opérationnel

`GET /api/health` et `GET /api/ready` sont interrogées en continu par un
orchestrateur (souvent chaque seconde) : les journaliser produirait du bruit
sans valeur de diagnostic. `observability.js` les ignore explicitement
(`SKIP_PATHS`).

## `/api/health` vs `/api/ready` — deux sondes, deux contrats

`backend/health.js`, non authentifié (ce sont des sondes d'infrastructure,
jamais des routes métier) :

- **`GET /api/health`** (liveness) — répond `{status:'ok'}` sans aucune
  dépendance externe, jamais bloqué par PostgreSQL. Une sonde de vivacité
  qui dépendrait de la base ferait redémarrer le processus pour un problème
  qui n'est pas le sien — confusion classique liveness/readiness.
- **`GET /api/ready`** (readiness) — un aller-retour PostgreSQL minimal
  (`SELECT 1`), `{status:'ready'}` ou `503 {status:'unavailable'}`. **Pas**
  l'audit exhaustif de schéma/permissions/RLS
  (`backend/db/postgresql/readiness.js#assertReady`) : celui-ci reste
  bloquant une seule fois, au démarrage, avant toute écoute HTTP
  (`server.js#start`) — une sonde interrogée en continu ne doit pas répéter
  un audit coûteux (migrations, triggers, politiques RLS, privilèges) à
  chaque appel, seulement confirmer que la connexion est toujours vivante.

Aucun détail technique renvoyé par l'une ou l'autre sonde — jamais un
message d'erreur PostgreSQL, jamais de SQL, jamais d'hôte.

## Tests

`tests/postgres-observability.test.js` : champs présents et corrects sur
requête réussie, `X-Correlation-Id` entrant respecté, `alert_id` scoping
strict, erreur métier sans `error_code`, requête non authentifiée toujours
journalisée sans tenant fabriqué, sondes exclues, aucune fuite de secret
même sérialisée, rafale de requêtes (une ligne par requête, dans l'ordre).
`tests/postgres-health.test.js` : les deux sondes non authentifiées,
`GET /api/ready` bascule réellement à 503 une fois PostgreSQL devenu
injoignable (coupure simulée après un démarrage réussi, pas une
configuration invalide au boot — `server.js#start` refuse déjà de démarrer
sans base).
