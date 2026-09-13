# SécuriSite — index de performance PostgreSQL (PG-11)

Migration `007_performance_indexes.sql`. Règle du lot : **mesurer avant de
modifier, `EXPLAIN ANALYZE` à l'appui, aucun index sans preuve**. Aucune
requête n'a été réécrite ; seuls des index ont été ajoutés, tous justifiés
individuellement ci-dessous.

## Méthode

Base PostgreSQL jetable, migrée intégralement, peuplée d'un volume
synthétique réaliste : 60 000 lignes dans chacune de `visiteurs`, `badges`,
`security_alerts`, `pietons`, `security_audit`, 200 utilisateurs distincts
(pour que les filtres `created_by`/`actor_username` ne soient pas
dégénérés). `EXPLAIN (ANALYZE, BUFFERS)` exécuté sur les requêtes **réellement
émises par le runtime** (`backend/routes.js`, `backend/alert-core/
repository.js`, `GET /api/admin/security-audit`), avant puis après ajout des
index candidats, sur la même base et le même volume. `tests/
postgres-performance-indexes.test.js` fige ensuite la preuve : chaque index
existe avec la définition attendue, et le planificateur le choisit bien pour
la requête qui l'a justifié (jamais un `Seq Scan`).

## Résultats mesurés

| Requête (site d'appel) | Avant | Après | Index ajouté |
|---|---|---|---|
| `GET /visiteurs` (`ORDER BY arrivee DESC`) | Seq Scan + tri externe (disque), **44 ms** | Index Scan, **15 ms** | `visiteurs_arrivee_idx (arrivee DESC)` |
| `GET /badges` (`ORDER BY emis DESC`) | Seq Scan + tri externe, **55 ms** | Index Scan, **11 ms** | `badges_emis_idx (emis DESC)` |
| `repository.alertsByCreator` (liste Alert Core, utilisateur `own`) | Seq Scan + tri, **3,8 ms** | Bitmap Index Scan + tri léger, **0,3 ms** | `security_alerts_created_by_idx (created_by, level DESC, created_at DESC)` |
| `repository.allAlerts` (liste Alert Core, `scope`) | Seq Scan parallèle + tri externe, **157 ms** | Index Scan (tri déjà satisfait), **12 ms** | `security_alerts_level_created_idx (level DESC, created_at DESC)` |
| `repository.recentBadgeAlert` (chemin chaud : chaque refus de badge évalué) | Seq Scan (60 000 lignes éliminées), **11,4 ms** | Index Scan, **0,01 ms** | `security_alerts_badge_rule_idx (equipment, created_at) WHERE origin='REGLE_BADGE'` |
| `repository.badgeRefusalCount` (même chemin chaud) | Seq Scan, **10,8 ms** | Bitmap Index Scan, **0,05 ms** | `pietons_badge_refus_idx (badge, datetime) WHERE resultat='refus'` |
| `GET /api/admin/security-audit?actor=` | Seq Scan, **2,4 ms** | Index Scan, **0,05 ms** | `security_audit_actor_username_created_idx (actor_username, created_at DESC)` |
| `repository.pendingEscalations` (chemin chaud : timer d'escalade, chaque seconde) | Bitmap Index Scan sur `alert_status_idx` (migration 002), **6,3 ms** | **identique** — aucun changement de plan | **aucun** — déjà bien servi |

`recentBadgeAlert` et `badgeRefusalCount` méritent une mention particulière :
ce sont les deux requêtes évaluées à **chaque** passage piéton refusé
(`backend/alert-core/service.js#fromBadge`), sous verrou advisory
transactionnel — un chemin chaud où chaque milliseconde gagnée réduit
directement la fenêtre de verrouillage.

## Choix délibérés

- **Index partiels** (`security_alerts_badge_rule_idx`,
  `pietons_badge_refus_idx`) : la seule valeur jamais filtrée par ces deux
  requêtes est respectivement `origin='REGLE_BADGE'` et `resultat='refus'` —
  un index partiel reste petit et rapide à maintenir, sans indexer les
  lignes que ces requêtes ne consultent jamais.
- **`pendingEscalations` inchangé** : la mesure confirme que l'index
  existant (`alert_status_idx`, PG-2) sert déjà correctement cette requête —
  ajouter un index dessus aurait été de la sur-ingénierie sans preuve.
- **`security_alerts_level_created_idx` sans filtre** : `allAlerts` n'a
  aucun `WHERE` (visibilité `scope` complète) — l'index n'apporte pas de
  sélectivité, seulement l'ordre déjà trié, évitant un tri qui, à l'échelle
  mesurée, débordait sur disque.
- **Aucune requête réécrite** : tous les gains proviennent d'index, jamais
  d'un changement de logique applicative — hors périmètre du lot.

## Limite de la preuve en test

`tests/postgres-performance-indexes.test.js` utilise un volume plus modeste
(6 000 lignes, prix CI oblige) que la mesure ci-dessus (60 000). À cette
échelle, deux effets de seuil du planificateur PostgreSQL apparaissent :

- `allAlerts` : le tri tient encore en mémoire (`work_mem`) à 6 000 lignes —
  le planificateur choisit alors légitimement `Seq Scan + Sort` plutôt que
  l'index (il devient meilleur uniquement quand le tri déborde sur disque,
  démontré ci-dessus à 60 000 lignes). Le test contourne cette limite de
  volume avec `SET LOCAL enable_seqscan = off` : il prouve que l'index est
  directement utilisable pour cette requête exacte (plan sans tri), sans
  dépendre d'un volume de données irréaliste pour un test.
- `pendingEscalations` : sensible à la sélectivité réelle de `status`/`level`
  dans les données de test, pas à l'échelle — corrigé en variant `status` sur
  ses 6 valeurs dans le jeu de données du test (comme en production), ce qui
  restaure la sélectivité qui fait réellement choisir l'index existant.
