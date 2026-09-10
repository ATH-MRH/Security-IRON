# SécuriSite — déploiement PostgreSQL et provisioning

Lot PG-4. Aucun accès production dans ce dépôt ; ce document décrit la procédure,
les outils sont dans `backend/db/postgresql/`.

## 1. Modèle de rôles

Trois rôles distincts, un seul utilisé par l'application en fonctionnement.

| Rôle | Connexion | Rôle réel | Attributs |
|---|---|---|---|
| `securisite_owner` | **NOLOGIN** | propriétaire de la base et des objets | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS` |
| `securisite_migrator` | LOGIN | exécute la DDL / les migrations | membre d'`owner` (`INHERIT`), `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` |
| `securisite_app` | LOGIN | **runtime uniquement** | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`, **jamais membre d'`owner`** |

`securisite_app` reçoit exactement : `CONNECT` sur la base, `USAGE` sur `public` et
`securisite_meta`, le DML strict table par table déclaré par
`backend/db/postgresql/readiness.js` (`PRIVILEGES`), et `SELECT` sur
`securisite_meta.schema_migrations`. Les journaux append-only (`alert_audit`,
`alert_config_audit`) ne reçoivent qu'`INSERT` + `SELECT`. `securisite_app` ne peut
ni créer, ni modifier une structure, ni contourner RLS.

Les noms de rôles sont surchargables : `SECURISITE_OWNER_ROLE`,
`SECURISITE_MIGRATOR_ROLE`, `SECURISITE_APP_ROLE`.

## 2. Ordre de provisioning (une fois par base)

`db:roles` est réexécutable : il crée les rôles et accorde d'abord ce qui ne
dépend pas du schéma (CONNECT), puis, relancé après les migrations, complète les
`GRANT` sur `securisite_meta` et les tables métier.

```
# 1. Rôles + attributs + CONNECT, en tant qu'administrateur du cluster.
#    a) revue DBA :
SECURISITE_TARGET_DB=securisite npm run db:roles -- --emit > roles.sql
psql -h HOST -U ADMIN -d securisite -v migrator_password=… -v app_password=… -f roles.sql
#    b) application directe (mots de passe par l'environnement, jamais journalisés) :
DATABASE_URL='postgres://ADMIN:…@HOST/securisite' \
SECURISITE_MIGRATOR_PASSWORD='…' SECURISITE_APP_PASSWORD='…' \
  npm run db:roles
#    -> « relancer après les migrations » si le schéma n'est pas encore là.

#    (La base est créée avec OWNER = securisite_owner :
#       CREATE DATABASE securisite OWNER securisite_owner;
#     l'ordre exact — rôle owner avant createdb — dépend de l'outil ; en cas de
#     besoin, créer d'abord les rôles sur la base « postgres » puis la base cible.)

# 2. Migrations, en tant que MIGRATOR, AVANT tout démarrage applicatif :
DATABASE_URL='postgres://securisite_migrator:…@HOST/securisite' PGSSL=verify-full \
  npm run db:migrate

# 3. Compléter les GRANT (schéma et tables existent maintenant) :
DATABASE_URL='postgres://ADMIN:…@HOST/securisite' \
SECURISITE_MIGRATOR_PASSWORD='…' SECURISITE_APP_PASSWORD='…' \
  npm run db:roles

# 4. Premier administrateur applicatif (mot de passe par l'environnement ou un TTY) :
DATABASE_URL='postgres://securisite_migrator:…@HOST/securisite' PGSSL=verify-full \
SECURISITE_ADMIN_PASSWORD='…' \
  npm run db:create-admin -- admin
#    Idempotent : ne modifie jamais un compte existant.

# 5. Démarrage de l'application en tant qu'APP :
DATABASE_URL='postgres://securisite_app:…@HOST/securisite' PGSSL=verify-full \
  npm run server
#    start() fait db.init() -> attestation readiness (lecture seule) -> écoute.
#    Aucune migration, aucun seed, aucune réparation au démarrage.
```

Aux montées de version suivantes, seules les étapes 2 (migrations) et, si une
migration a introduit une table, 3 (`db:roles`) sont rejouées avant le rollout.

## 3. Checklist environnement (rôle APP au runtime)

| Variable | Attendu |
|---|---|
| `DATABASE_URL` **ou** `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` | connexion `securisite_app` |
| `PGSSL` | `verify-full` (hors développement/test) ; `PGSSLROOTCERT` si CA privée |
| `JWT_SECRET` | secret fort, non vide |
| `PGPOOL_MAX` | dimensionné (défaut 10) |
| `PGSTATEMENT_TIMEOUT_MS`, `PGCONNECT_TIMEOUT_MS`, `PGIDLE_TIMEOUT_MS`, `PGTRANSACTION_IDLE_TIMEOUT_MS` | valeurs explicites |
| `PORT` | port d'écoute |

`DATABASE_URL` ne doit pas contenir de paramètres de requête ; TLS se configure via `PGSSL`.

## 4. Checklist secrets

- Mots de passe `securisite_migrator`, `securisite_app`, `SECURISITE_ADMIN_PASSWORD`,
  `JWT_SECRET` : fournis par le gestionnaire de secrets de la plateforme.
- **Jamais** dans le dépôt, un fichier commité, un log applicatif, ni la sortie
  standard des outils (`db:roles`, `db:create-admin`, `db:migrate` n'impriment
  que des noms de rôles, des numéros de version et des codes SQLSTATE).
- `securisite_owner` n'a **pas** de mot de passe (NOLOGIN).
- Rotation : `ALTER ROLE … PASSWORD …` (idempotent, réémis par `db:roles`).

## 5. Contrôles de santé

- **Readiness** (démarrage) : `start()` échoue **avant** d'écouter si le registre,
  les versions 001/002, les 18 tables, la ligne `alert_rules.id=1`, la fonction et
  les triggers append-only, ou un privilège APP requis manquent
  (`backend/db/postgresql/readiness.js`).
- **Liveness** : `GET /api/*` sans jeton renvoie `401` dès que l'écoute est ouverte.
- **Migrations** : `npm run db:migrate` sortie `0` = base à jour ; `schema_migrations`
  contient exactement les versions des fichiers, avec noms et empreintes SHA-256.

## 6. Déploiement : job migration → readiness → rollout

1. **Job de migration** (rôle MIGRATOR) : `npm run db:migrate`. Sérialisé par un
   verrou consultatif ; transaction par migration ; `001` conservée si `002` échoue.
2. **Readiness** : l'orchestrateur ne bascule le trafic que si une instance
   applicative démarre (donc l'attestation readiness a réussi).
3. **Rollout applicatif** : instances `securisite_app` uniquement.

### Rollback

- **Applicatif** : redéployer la version précédente **compatible avec le schéma
  courant**. Les migrations sont *forward-only* : ne jamais rétrograder le schéma
  pour un rollback applicatif.
- **Schéma** : restauration depuis une sauvegarde (voir lot PG-27). Il n'existe pas
  de migration descendante automatique.

## 7. Import de données SQLite → PostgreSQL (`npm run db:import`)

`backend/db/postgresql/import-sqlite.js` reprend une base SécuriSite SQLite
historique dans une cible PostgreSQL **fraîche** (migrations 001/002, aucune
donnée hormis le seed `alert_rules`).

```
node backend/db/postgresql/import-sqlite.js chemin/vers/securisite.db --dry-run   # validation + rapport
node backend/db/postgresql/import-sqlite.js chemin/vers/securisite.db             # import réel
```

- **Source** ouverte en lecture seule, `PRAGMA quick_check` exigé.
- **Validation bloquante** avant toute écriture : clé primaire nulle, doublon de
  clé, entier hors `int4`, entier hors plage JS, chaîne non UTF-8, JSON invalide
  dans `security_alerts.policy` / `alert_rules.config`. Une seule anomalie ⇒
  import refusé, cible inchangée.
- **Cible protégée** : base « …test… » acceptée ; toute autre base exige
  `SECURISITE_IMPORT_CONFIRM=<nom exact>` (après validation humaine) ; une base
  « prod/production » est toujours refusée. **Ne jamais importer dans une base
  réelle sans point de contrôle humain.**
- **Transaction unique** : colonnes communes source ∩ cible uniquement, ordre des
  clés étrangères respecté (`parking_zones` avant `parking_places`,
  `security_alerts` avant `alert_audit`/`alert_notifications`), `alert_rules`
  remplace le seed.
- **Séquences identity** (`users.id`, `alert_audit.id`, `alert_notifications.id`,
  `alert_config_audit.id`) repositionnées sur `MAX(id)` via `setval`.
- **Vérification post-commit** : comptes source/cible et ensembles de clés
  primaires identiques par table.
- **Réimport** : les journaux append-only ne pouvant pas être purgés, un nouvel
  import se fait dans une base cible neuve (recréer + migrer).

## 8. Notes

- `backend/db/postgresql/migrate.js` (runner) et `migrate-cli.js` (CLI) sont
  distincts de `server.js` : l'application ne migre jamais.
- L'ancien `backend/seed.js` (données de démonstration SQLite, non chargé par le
  serveur) a été retiré au lot PG-4. Le provisioning applicatif se limite au
  premier administrateur ; il n'y a pas de jeu de données de démonstration
  PostgreSQL.
- `backend/db/migrate.js`, `backup.js`, `migrations/001_baseline.js` restent des
  références SQLite du lot A2, testées isolément (`tests/migrations.test.js`).
