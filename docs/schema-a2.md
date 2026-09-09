# A2.2 — Référentiel tenants / sites / zones

Ce lot ajoute un référentiel relationnel. Il n'active pas le multi-tenant : aucune
route, permission, visibilité, affectation utilisateur ou règle d'alerte ne change.
Les memberships sont réservées à A2.3. Les chaînes métier historiques restent
indépendantes du nouveau référentiel ; aucun rapprochement n'est effectué.

## Migration

`backend/db/migrations/002_tenants_sites_zones.js` est découverte automatiquement
par le runner A2.1. La migration 001 et son checksum restent inchangés. Le runner
exécute 002 dans sa transaction `BEGIN IMMEDIATE`, enregistre sa version après
succès et annule DDL et backfill sur erreur. Une base existante reçoit une sauvegarde
avant les migrations en attente ; un redémarrage à jour n'en crée pas une autre.
Le démarrage existant applique les migrations : aucun nouvel appel n'est ajouté.
Les vérifications physiques historiques du runner portent toujours sur la baseline
001 ; ce lot n'étend pas la détection de dérive physique aux nouveaux objets 002.

## Tables

Tous les IDs du référentiel sont des UUID stockés en `TEXT`. Les dates `created_at`
sont des textes ISO UTC obligatoires, fournis lors de l'insertion. Le schéma ne
valide pas le format lexical des UUID ou des dates.

### tenants

- `id TEXT PRIMARY KEY`.
- `code TEXT NOT NULL UNIQUE`, `name TEXT NOT NULL`.
- `status TEXT NOT NULL DEFAULT 'active'`, limité à `active`, `suspended`, `archived`.
- `created_at TEXT NOT NULL`.

### sites

- `id TEXT PRIMARY KEY` ; `tenant_id TEXT NOT NULL REFERENCES tenants(id)`.
- `code TEXT NOT NULL`, `name TEXT NOT NULL`, `address TEXT` nullable.
- `timezone TEXT NOT NULL` ; `latitude REAL`, `longitude REAL` nullables.
- `external_ref TEXT` nullable : réservation pour ATLAS, sans mapping ni modification de `sync.js`.
- `status TEXT NOT NULL DEFAULT 'active'`, limité à `active`, `suspended`, `archived`.
- `created_at TEXT NOT NULL`.
- Unicité `(tenant_id, code)` ; index `idx_sites_tenant(tenant_id)`.

### zones

- `id TEXT PRIMARY KEY` ; `site_id TEXT NOT NULL REFERENCES sites(id)`.
- `tenant_id TEXT NOT NULL REFERENCES tenants(id)`.
- `code TEXT NOT NULL`, `name TEXT NOT NULL`.
- `kind TEXT` nullable, limité sinon à `perimeter`, `parking`, `building`, `access_point`, `other`.
- `status TEXT NOT NULL DEFAULT 'active'`, limité à `active`, `archived`.
- `created_at TEXT NOT NULL`.
- Unicité `(site_id, code)` ; indexes `idx_zones_site(site_id)` et `idx_zones_tenant(tenant_id)`.

Les FK ne comportent aucune suppression ou modification en cascade. Comme dans
A2.1, les connexions applicatives doivent activer `PRAGMA foreign_keys=ON`.
Les triggers `zones_parent_insert` et `zones_parent_update` refusent un parent
inexistant (« Zone: site parent inexistant ») et un tenant différent de celui du
site (« Zone: tenant incompatible avec le site parent »).
Le trigger `sites_tenant_update` empêche aussi de changer le tenant d'un site si
cela rendrait ses zones incohérentes. Un site sans zone peut changer de tenant.
Le transfert explicite d'une zone vers un autre tenant exige de modifier son
site et son tenant ensemble, vers un couple cohérent.

## Backfill conservateur

Le tenant historique est `local` / `Client local`. Son nom ne vient jamais du
paramètre `site`. Le site principal est `main`, sous ce tenant :

- nom : valeur non vide de `parametres.site` après `trim()`, sinon `Site principal` ;
- adresse : valeur non vide de `parametres.adresse` après `trim()`, sinon `NULL` ;
- timezone : `UTC`, valeur technique explicite faute de source fiable. Aucun pays
  n'est déduit des données. Une future configuration pourra choisir une timezone
  par site ; ce lot ne change pas l'interprétation des dates historiques ;
- latitude, longitude et `external_ref` : `NULL`.

Les deux UUID v5 sont figés, dérivés du namespace DNS standard
`6ba7b810-9dad-11d1-80b4-00c04fd430c8` :

| Entité | Nom stable utilisé pour UUID v5 | UUID |
| --- | --- | --- |
| Tenant local | `securisite.local.tenant` | `507486ba-d55e-5142-9ac2-196da97866df` |
| Site main | `securisite.local.site.main` | `fa831124-0323-581e-993c-1f4332a36282` |

Les conflits sur les clés naturelles `code` du tenant ou `(tenant_id, code)` du
site conservent les lignes existantes, y compris leurs IDs, noms et dates. Un
conflit d'ID avec une autre clé naturelle provoque une erreur et un rollback.
Le runner ne rejoue pas une migration enregistrée ; même un replay direct du
backfill ne duplique pas les lignes. Les paramètres ne sont pas synchronisés
continuellement : une modification ultérieure ne renomme pas le site.

Aucune zone n'est créée, même si des lieux, points d'accès ou zones de parking
existent. `incidents.lieu`, `main_courante.lieu`, `pietons.point`,
`parking_mouvements.zone`, `security_alerts.site/zone`, ainsi que
`employes.site_id/site_nom`, restent strictement inchangés. Les identifiants ATLAS
historiques ne sont pas transformés en UUID.

## Diagnostic historique en lecture seule

```sh
node backend/scripts/report-historical-locations.js /chemin/vers/copie-locale.db
```

Sans argument, le chemin vient de `SECURISITE_DB_PATH`, puis de
`SECURISITE_DATA_DIR/securisite.db`, sinon de `data/securisite.db` dans le projet.
Le script ne charge pas `.env`. Pour éviter toute ambiguïté, fournir le chemin
explicite d'une copie locale. Il n'importe pas `database.js`, n'initialise pas la
base et n'applique pas de migration. La source est lue uniquement via les API
filesystem : SQLite ouvre exclusivement une copie isolée en `readOnly: true`.
Le fichier principal et le WAL présent sont copiés dans un répertoire unique
`securisite-location-report-*` sous `os.tmpdir()`. Le SHM est reconstruit sur la
copie, sans ouvrir ni modifier celui de la source. Aucun auxiliaire, backup ou
rapport n'est créé dans le répertoire source ; la sortie JSON reste sur stdout.

Deux lectures successives DB+WAL doivent être identiques ; sinon le diagnostic
échoue explicitement. Un journal rollback non vide est également refusé.
Pour une garantie de snapshot face à un producteur actif, suspendre ses écritures
pendant la capture : la comparaison détecte les changements observables mais ne
remplace pas un verrou coordonné avec le producteur. Aucun mode immutable
susceptible d'ignorer le WAL n'est utilisé. `quick_check` vérifie la copie avant
le rapport ; les transactions validées présentes uniquement dans le WAL restent
visibles. La mémoire requise est proportionnelle à la taille DB+WAL.

Une source absente échoue avant création temporaire. La copie et ses auxiliaires
sont supprimés en `finally`, après fermeture SQLite, sur succès comme sur erreur.
Une erreur de nettoyage est signalée, sans masquer l'erreur principale. Comme
pour tout nettoyage `finally`, un arrêt forcé du processus peut laisser une copie
temporaire ; le répertoire utilise les permissions privées de `mkdtemp` et les
copies sont créées avec le mode `0600`.

Le JSON sur stdout contient les paramètres `site/adresse`, les couples employés
`site_id/site_nom` distincts, les lieux/points/zones avec leurs effectifs, les codes
et noms de `parking_zones` (le code historique est la colonne `zone`), et les
valeurs site/zone des alertes si leur table existe. Les valeurs brutes, y compris
NULL et chaînes vides, sont conservées. Une source vide donne `[]`, une source
absente/incompatible donne `null` avec une entrée dans `unavailable`.
Une transaction de lecture garantit un instantané cohérent. Les erreurs vont sur
stderr avec un code de sortie non nul. Aucun mapping ou zone n'est créé.

## Validation et frontière A2.3

Exécuter `node --test tests/migrations.test.js` puis `npm test` avec un Node
supportant `node:sqlite` (environnement validé : Node 22.22.2). Aucune dépendance
ou contrainte de version globale n'est ajoutée. Les tests utilisent exclusivement
des bases temporaires ou en mémoire.

Les 33 tests historiques A2.1 continuent de cibler la migration 001 figée via un
catalogue temporaire explicite ; leurs assertions sont préservées. Les 37 nouveaux
tests couvrent le catalogue réel 001+002, le backfill, la conservation exacte des
lignes/DDL historiques, les contraintes, le rollback, la sauvegarde, la reprise
et le diagnostic en lecture seule. Les tests métier alertes et notifications
restent inchangés.

A2.3 devra définir les memberships et leur intégration aux autorisations. Ce lot
ne crée aucune relation utilisateurs/tenants, aucune nouvelle colonne sur les
alertes ou leur audit, aucun endpoint CRUD, aucune activation multi-client,
aucune modification frontend, auth, lifecycle, polling, escalades ou notifications.
