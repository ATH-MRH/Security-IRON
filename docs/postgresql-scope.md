# SécuriSite — modèle de périmètre PostgreSQL (tenants / sites / zones)

Lot **PG-6**. Migration `backend/db/postgresql/migrations/003_tenants_sites_zones.sql`.
Schéma + contraintes + backfill **uniquement** : aucune activation de visibilité
multitenant (aucune lecture/écriture applicative, aucune RLS). L'activation est
l'objet des lots PG-7 (memberships), PG-8 (scope applicatif) et PG-9 (RLS).

## Ne pas réutiliser les migrations SQLite A2

Le worktree `SecuriSite-source` (`backend/db/migrations/002_tenants_sites_zones.js`,
`003_memberships.js`) est **référence fonctionnelle uniquement**. `003` ici est une
migration PostgreSQL native, pas un portage.

Améliorations natives par rapport à A2 :

| A2 (SQLite) | PG-6 (PostgreSQL natif) |
|---|---|
| `id TEXT` (UUID v5 applicatif) | `id UUID DEFAULT gen_random_uuid()` (v5 figé seulement pour le backfill) |
| dates `TEXT` ISO | `created_at TIMESTAMPTZ DEFAULT now()` |
| cohérence tenant/site/zone par **3 triggers** `RAISE(ABORT)` | **clés étrangères composites** déclaratives, index-backées |
| — | CHECK GPS (plages + couple), CHECK slug `code`, `sites.external_ref` unique partiel |

## Tables

### `tenants`
`id UUID PK` · `code` slug unique (`^[a-z0-9][a-z0-9_-]{0,62}$`) · `name` non vide ·
`status ∈ {active,suspended,archived}` (défaut `active`) · `created_at TIMESTAMPTZ`.

### `sites`
`id UUID PK` · `tenant_id → tenants(id)` **RESTRICT** · `code` slug ·
`name` non vide · `address` (nullable) · `timezone` non vide (défaut `UTC`) ·
`latitude`/`longitude` (nullable, plages ±90 / ±180, **couple** — les deux ou
aucun) · `external_ref` (nullable) · `status` · `created_at`.
Contraintes : `UNIQUE (tenant_id, code)` ; `UNIQUE (id, tenant_id)` (cible des FK
de `zones`) ; index unique partiel `external_ref` (un site au plus par référence
externe).

### `zones`
`id UUID PK` · `site_id` · `tenant_id → tenants(id)` **RESTRICT** · `code` slug ·
`name` non vide · `kind ∈ {perimeter,parking,building,access_point,other}` ou NULL ·
`status ∈ {active,archived}` · `created_at`.
Cohérence : `FOREIGN KEY (site_id, tenant_id) REFERENCES sites (id, tenant_id)`
**RESTRICT** — garantit `zones.tenant_id = sites.tenant_id` et interdit de
re-tenanter un site tant qu'une zone y référence l'ancien couple.
Index : `zones (tenant_id)`.

## Backfill local

- Un `tenants` : `code='local'`, `name='Client local'`, id figé
  `507486ba-d55e-5142-9ac2-196da97866df`.
- Un `sites` sous `local` : `code='main'`, id figé
  `fa831124-0323-581e-993c-1f4332a36282`, `timezone='UTC'`, `name`/`address`
  repris de `public.parametres` (`site` / `adresse`) s'ils sont non vides, sinon
  `name='Site principal'` / `address=NULL`.
- **Aucune zone.** Les chaînes historiques `incidents.lieu` / `pietons.point` /
  `main_courante.lieu` ne constituent pas un référentiel fiable : leur
  transformation en zones relève d'une validation humaine ultérieure.

### Limite connue — nom du site `main`

Le backfill s'exécute au moment de la migration ; `public.parametres` est en
général encore vide à cet instant (peuplé ensuite par l'application ou l'import
PG-5). Le site `main` reçoit donc souvent le nom `'Site principal'`. Après
premier démarrage ou import, un opérateur peut ajuster :

```sql
UPDATE public.sites
   SET name = (SELECT valeur FROM public.parametres WHERE cle = 'site'),
       address = (SELECT valeur FROM public.parametres WHERE cle = 'adresse')
 WHERE code = 'main' AND tenant_id = '507486ba-d55e-5142-9ac2-196da97866df';
```

Aucune reprise automatique n'est faite en PG-6 (hors périmètre : schéma seul).

## Appartenances (`memberships` / `membership_audit`) — lot PG-7

Migration `004_memberships.sql`. Schéma + contraintes + backfill + provisioning ;
**aucun contrôle d'accès applicatif branché, aucune RLS** (PG-8 / PG-9).

### `memberships`
`id UUID PK` · `user_id → users(id)` RESTRICT · `tenant_id → tenants(id)` RESTRICT ·
`site_id` / `zone_id` (nullables) · `role ∈ {soc,client_manager,supervisor,site_manager,agent,client_viewer}` ·
`alert_access ∈ {own,scope}` (défaut `own`) · `status ∈ {active,suspended,archived}` ·
`scope` **`GENERATED ALWAYS STORED`** = `zone` / `site` / `tenant` selon les FK ·
`created_at` / `updated_at TIMESTAMPTZ`.

Cohérence **déclarative** (pas de trigger de cohérence, contrairement à A2) :

- `CHECK (zone_id IS NULL OR site_id IS NOT NULL)` — une zone implique un site ;
- `FOREIGN KEY (site_id, tenant_id) → sites (id, tenant_id)` — le site appartient au tenant ;
- `FOREIGN KEY (zone_id, site_id, tenant_id) → zones (id, site_id, tenant_id)` —
  la zone appartient au couple site/tenant (nécessite `zones UNIQUE (id, site_id, tenant_id)`, ajouté par 004).

Unicité : une appartenance `(user, tenant, role)` au plus **par niveau** (index
uniques partiels tenant / site / zone).

### `membership_audit` (append-only)
`id BIGINT identity` · `membership_id → memberships(id)` · `user_id` · `tenant_id` ·
`actor_user_id` (nullable) · `action ∈ {CREATE,UPDATE}` · `created_at` · `detail JSONB`
(`{origin, before, after}` — snapshots `to_jsonb`).

### Immuabilité (triggers, `securisite_meta`)
- `memberships` : suppression interdite (`memberships_no_delete`) ; `id` / `user_id`
  / `tenant_id` / `created_at` non modifiables (`memberships_identity_lock`) ;
  `updated_at` repositionné à chaque `UPDATE` (`memberships_touch_updated_at`).
  → **archiver** (`status`) au lieu de supprimer ; créer une nouvelle appartenance
  au lieu de réidentifier.
- `membership_audit` : `UPDATE` / `DELETE` / `TRUNCATE` rejetés (23514).
- Journalisation : `memberships_audit_insert` / `_update` écrivent une rangée
  `membership_audit` ; l'acteur et l'origine viennent de
  `current_setting('securisite.actor_user_id' / 'securisite.audit_origin', true)`
  (posés par `SET LOCAL` dans la transaction appelante).

### Backfill et provisioning
- Backfill (migration) : une appartenance de niveau tenant par utilisateur
  `admin` / `agent` sous `local` (`admin → soc` / accès `scope`, `agent → agent` /
  accès `own`). `ON CONFLICT DO NOTHING` — jamais de réactivation ni
  d'élargissement.
- `backend/db/postgresql/provision-membership.js` — `provisionLocalMembership(exec,
  userId, { actorUserId, origin })` : même logique, transactionnelle, idempotente.
  **Non branché au runtime** (réservé PG-8).

## Activation applicative — lot PG-8

Décision humaine figée avant implémentation (voir historique de conversation) :
bascule sans mode legacy parallèle, admin historique = `soc`/`scope` **sans**
accès implicite à un futur tenant, 403 stable (jamais une liste vide) sans
périmètre actif, enforcement applicatif d'abord — **aucune RLS** (PG-9,
deuxième défense indépendante, non touchée ici).

### Service central — `backend/scope.js`

Point d'autorité unique, réutilisé par `backend/routes.js` (données
historiques) et `backend/alerts.js` (Alert Core) : « ne disperse pas des
conditions tenant dans toutes les routes ». `resolveScope(userId, client)`
charge les memberships **actifs** de l'utilisateur dont le tenant (et, le cas
échéant, le site/la zone) est lui-même actif — suspendu/archivé à n'importe
quel niveau retire tout accès, y compris pour un ancien SOC. Expose :

- `allows(tenantId, siteId?, zoneId?)` / `coverage(...)` — couverture
  hiérarchique tenant > site > zone (un membership de niveau tenant couvre
  tous ses sites et zones ; site couvre ses zones ; zone ne couvre qu'elle-même).
- `tenantAccess(tenantId)` — meilleur `alert_access` (`own`/`scope`) toutes
  appartenances confondues sous ce tenant (Alert Core ne porte aucune colonne
  site/zone propre : la résolution y reste au niveau du tenant entier).
- `hasRole(tenantId, role)` — utilisé pour la capacité SOC (`role='soc'`),
  indépendante de `alert_access` : `own`/`scope` pilote la **visibilité**,
  `role='soc'` pilote les **actions** réservées. Aucune des deux ne se déduit
  jamais de `username`/`id`/du rôle JWT historique.
- `resolveTenant(tenantId?)` — sans argument, résout l'unique tenant couvert
  (réalité mono-tenant actuelle) ; avec argument, ne renvoie ce tenant que
  s'il est réellement couvert par un membership actif — jamais autrement.

`requireScope()` (middleware Express) : 403 `{"error":"Accès au périmètre
refusé"}` sans accès ; `?tenant_id=`/`?site_id=`/`?zone_id=` ne sont lus que
comme des **filtres demandés**, intersectés avec le périmètre réellement
couvert — jamais une autorisation en soi. Limite connue documentée dans
`scope.js` : la cohérence d'un triplet `(tenantId, siteId, zoneId)` fourni par
l'appelant n'est pas revérifiée contre `sites`/`zones` — sans conséquence
aujourd'hui puisqu'aucune table historique ne porte de colonne tenant/site/
zone à filtrer (voir plus bas), à durcir avant qu'un endpoint ne s'appuie sur
ces identifiants pour filtrer des lignes.

### Portée réelle sur les routes historiques

`backend/routes.js` applique `requireScope()` à tout sauf `/admin/*` : la
gestion de comptes reste une capacité **système** gérée par le rôle JWT
(`role==='admin'`), pas par le périmètre memberships — « un véritable
administrateur global devra être représenté explicitement par une politique
dédiée ultérieure », pas par cette porte. Aucune ligne n'est filtrée par
tenant/site/zone : les tables historiques (`incidents`, `pietons`, `visiteurs`,
`vehicules`, `main_courante`, …) ne portent toujours **aucune** colonne
tenant/site/zone (PG-6/PG-7 n'ont ajouté que le référentiel, pas ces colonnes)
et il n'existe qu'un tenant/site aujourd'hui : la seule protection
significative possible est donc la porte « au moins un membership actif » —
403 sinon, jamais une liste vide. Une suppression de compte via
`DELETE /admin/users/:id` renvoie désormais 409 (au lieu d'un 500 technique)
si des memberships y font référence : `memberships` est en RESTRICT et
append-only (PG-7), un compte ayant eu une appartenance ne peut plus être
supprimé — l'archiver est le chemin prévu.

Aucun provisioning automatique de membership n'a été ajouté à
`POST`/`PUT /admin/users` : `provision-membership.js` (PG-7) reste un outil
explicite, distinct de la création de compte — élargir silencieusement les
droits à chaque création de compte contredirait « ne jamais élargir
silencieusement les droits ». Un compte nouvellement créé reste donc hors
périmètre (403 sur les routes métier) jusqu'à provisioning explicite.

### Alert Core

`backend/alerts.js` résout le périmètre une fois par requête (après la
revalidation de session existante), pose `req.user.alertAccess`
(`tenantAccess`) et `req.user.isSoc` (`hasRole(tenantId,'soc')`), puis
`backend/alert-core/service.js` les consomme à la place de l'ancien
`user.role==='admin'` :

- `get`/`act` (visibilité) : `alertAccess==='scope'` **ou** alerte propre
  (`created_by===user.id`) — sinon 404 (comportement inchangé : ne jamais
  distinguer « inexistant » de « non autorisé »).
- `list` : `scope` ⇒ toutes les alertes du tenant ; `own` ⇒ les siennes.
- Actions réservées (transitions, escalade manuelle, `/rules`) :
  `isSoc` — indépendant d'`alertAccess`, donc un membership `role='agent'`
  avec `alert_access='scope'` voit tout mais ne peut rien clôturer, et un
  `role='soc'` avec `alert_access='own'` peut agir sur ses propres alertes
  sans voir celles des autres.

`service.js` ne fait toujours aucun appel SQL ni requête de périmètre
lui-même (contrat déjà testé : `PG32A service adds no SQL...`) — `alertAccess`/
`isSoc` sont résolus une fois, côté routeur, jamais recalculés en base par le
service métier.

## Readiness et droits

`backend/db/postgresql/readiness.js` exige désormais `tenants`, `sites`, `zones`,
`memberships`, `membership_audit`, la fonction de garde
`securisite_meta.reject_membership_mutation` et les triggers append-only de
`memberships` / `membership_audit` (un `DROP` ou un `DISABLE` fait échouer
`start()` avant l'écoute). Le rôle applicatif reçoit **`SELECT` seul** sur
`tenants`/`sites`/`zones`/`memberships` (et `INSERT` sur `membership_audit`,
uniquement atteignable via le trigger `AFTER` — inerte tant que PG-8 n'a pas
accordé l'écriture de `memberships`).
