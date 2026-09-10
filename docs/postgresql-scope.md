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

## Readiness et droits

`backend/db/postgresql/readiness.js` exige désormais `tenants`, `sites`, `zones`
(un `DROP` d'une de ces tables fait échouer `start()` avant l'écoute). Le rôle
applicatif reçoit **`SELECT` seul** sur ces trois tables via
`provision-roles.js` — aucune écriture avant PG-8.
