# SécuriSite — SOC nouvelle génération (PG-16)

## Périmètre

Refonte du **Centre d'alertes** (`page-alertes`, `frontend/js/alerts.js` —
`AlertCenter`), pas du tableau de bord facilitaire générique : c'est déjà
l'écran SOC-orienté (alertes, SOS, escalades, actions métier), et le faire
évoluer évite de dupliquer un second système de filtrage/scope à côté d'un
tableau de bord qui répond à un besoin différent.

Contraintes du lot, toutes tenues : aucun contrat API cassé, aucune fonction
retirée (`AlertCenter` exporte exactement les mêmes clés qu'avant, testé
explicitement — voir `tests/notifications.test.js`, « contract preservation
»), aucune dépendance externe payante, aucun provider cartographique, aucune
IA, aucun push automatique nouveau, réutilisation intégrale de
`backend/realtime.js` (PG-12), `backend/push.js` (PG-13), `backend/scope.js`
(PG-8) et du SOS existant (PG-15).

## KPI : agrégation côté client, pas de nouvel endpoint de stats

`frontend/js/soc-kpis.js` (`SocKpis.compute(rows)`) calcule alertes actives,
critiques, SOS, non-acquittées, escalades, aujourd'hui, temps moyen
d'acquittement et répartition par site — **à partir de la réponse déjà reçue
et déjà autorisée de `GET /alerts`**, jamais d'une requête supplémentaire.

Choix justifié par la mesure, pas par principe : au volume réel actuel (voir
`tests/postgres-soc.test.js`, 400 lignes en volume de test « raisonnable »),
`GET /alerts` répond largement sous la seconde et le tri/filtrage côté client
est instantané. Un nouvel endpoint d'agrégation SQL (`COUNT`/`AVG` côté
serveur) n'apporterait rien de mesurable à cette échelle, pour un coût réel
(nouvelle route, nouveau test de scope, nouvelle surface d'audit). À
réévaluer si le volume réel dépasse ce qui a été mesuré ici — ce jour-là,
l'agrégation devra migrer côté SQL avec un filtre tenant/site explicite,
selon le même modèle que `repository.allAlerts`.

**RESOLUE n'est pas un statut actif mais n'est pas terminal** : `isActive()`
exclut `RESOLUE` des KPI d'alertes en cours (comme `AlertCenter` le faisait
déjà — `!finished(a) && a.status !== 'RESOLUE'`), alors que l'action
« Clôturer » reste offerte dessus. `soc-kpis.js` reproduit exactement cette
sémantique préexistante plutôt que d'en inventer une nouvelle — testé en
régression explicite (`tests/frontend-soc-kpis.test.js`).

## Incidents récents / timeline opérationnelle : fetch découplé

`GET /incidents` alimente les panneaux « Incidents récents » et « Timeline
opérationnelle », mais **n'est jamais attendu dans la chaîne `await` de
`load()`** : `load()` reste fonctionnellement identique à l'historique
(un seul `await API.get('/alerts')`, mêmes délais, même comportement sous
course de promesses — la suite de tests préexistante `tests/notifications.test.js`
qui contrôle ces courses au timing près continue de passer sans
modification de son propre timing). `loadRecentIncidents()` est appelée en
tir-et-oublie juste après le rendu principal ; un échec y est absorbé
silencieusement (panneau dégradé, jamais d'erreur bloquant le reste du
tableau de bord).

## Temps réel : `Realtime` (SSE), câblé sur l'existant

`frontend/js/realtime.js` est un client SSE minimal au-dessus de
`backend/realtime.js`/`realtime-routes.js` (PG-12, inchangés) : ticket à usage
unique, `EventSource`, reconnexion (5 s) et repli par sondage périodique
(15 s) si `EventSource` est indisponible ou si la connexion tombe.
`AlertCenter.start()` s'abonne (`Realtime.on`) et déclenche un rafraîchissement
(`refreshNow()`, identique à celui du minuteur existant) sur `alert:created`,
`alert:updated` et `poll` (repli). Un badge (`#ac-live-badge`) affiche l'état
réel (« ● Temps réel » / « ● Repli (actualisation périodique) »).

Le minuteur périodique de secours (5 s, préexistant) n'est pas retiré : il
reste le filet de sécurité si le flux SSE est silencieux sans déclencher
`onerror` (ex. côté serveur descendu proprement). Le contenu de l'alerte
n'est jamais lu depuis l'événement SSE lui-même (voir `docs/realtime.md`) —
seul un identifiant déclenche un rechargement via l'API REST déjà autorisée.

## La fuite intertenant trouvée et corrigée par ce lot

`security_alerts` n'avait **aucune colonne `tenant_id`** avant ce lot :
`repository.allAlerts()`/`alertsByCreator()` ne filtraient par aucun tenant.
Documenté depuis PG-6/PG-8/PG-9 comme une limite acceptée — un seul tenant
existait alors en pratique. PG-16 introduit le premier scénario de test à
deux tenants réellement actifs (`tests/postgres-soc.test.js`), qui a
immédiatement démontré une fuite réelle : un SOC scope-tenant-A voyait les
alertes du tenant B via `GET /alerts?tenant_id=A`.

Corrigé au niveau schéma, pas seulement documenté :

- **Migration `009_alert_core_tenant.sql`** : ajoute
  `security_alerts.tenant_id` (FK vers `tenants`, `ON UPDATE/DELETE
  RESTRICT`), backfill vers le tenant `local` figé (même UUID v5 que la
  migration 003) pour les lignes préexistantes, puis `NOT NULL` + index.
  Scope volontairement limité à `security_alerts` : aucune preuve démontrée
  d'une fuite équivalente sur les autres tables historiques (aucun filtre
  SOC-facing dessus aujourd'hui) — étendre sans preuve serait un changement
  de schéma non justifié.
- **`repository.js`** : `insertAlert` prend désormais `tenantId` (17e
  paramètre positionnel, avant `client`) ; `allAlerts`/`alertsByCreator`
  prennent `tenantId` en premier paramètre et filtrent dessus.
- **`service.js`** : `create()` exige `user.tenantId` (403 `Périmètre non
  résolu` sinon) ; `get()`/`act()` vérifient `a.tenant_id === user.tenantId`
  **sans condition**, y compris pour l'accès `own` — une alerte hors du
  tenant résolu de l'utilisateur est invisible même si elle lui appartient
  historiquement, posture la plus stricte contre toute fuite résiduelle.
- **`routes.js`** : `req.user.tenantId` est renseigné juste après la
  résolution de périmètre (`scope.requireScope()`), pour que les
  déclencheurs automatiques (`alerts.fromIncident`/`fromBadge`, appelés
  depuis `POST /incidents`/`POST /pietons`) connaissent le tenant résolu.
- **`backend/db/postgresql/import-sqlite.js`** : une base SQLite historique
  n'a jamais connu qu'un seul client — l'import applique le même backfill que
  la migration 009 (tenant `local`) aux lignes `security_alerts` importées.

Testé explicitement : `tests/postgres-soc.test.js` (isolation tenant A/B,
agent `own` limité, filtre site, tenant forgé refusé sur les actions et le
SOS, SOS visible en temps réel côté KPI, volume 400 lignes). Toute la suite
Alert Core (repository/service/concurrency/HTTP/e2e/incidents/realtime/push/SOS)
et les tests d'index/permissions/import touchés par le nouveau `NOT NULL`
ont été mis à jour en conséquence — voir historique Git de ce lot.

## Filtres : intersection serveur, jamais confiance au client

`GET /alerts?tenant_id=&site_id=&zone_id=` continue de passer par
`scope.requireScope()` (PG-8) : toute valeur fournie par le client est
**intersectée** avec le périmètre réellement résolu côté serveur, jamais
utilisée telle quelle. Un tenant/site forgé hors périmètre est refusé de la
même façon sur `/alerts`, `/alerts/:id/actions` et `/alerts/sos` — testé.

## Responsive et accessibilité

Desktop/tablette pris en charge par la grille CSS existante
(`#ac-kpis` en `repeat(auto-fit, minmax(170px,1fr))`, nouveaux panneaux
`.ac-insights` en flex/grid responsive). Base compatible mobile conservée
sans reprendre le travail PWA de PG-14 (`frontend/sw.js` étendu pour mettre
en cache les deux nouveaux scripts, `js/realtime.js` et `js/soc-kpis.js`,
dans `SHELL_ASSETS`).
