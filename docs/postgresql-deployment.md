# SécuriSite — déploiement PostgreSQL et provisioning

Lot PG-4, complété par PG-28 (revue déploiement). Aucun accès production
dans ce dépôt ; ce document décrit la procédure, les outils sont dans
`backend/db/postgresql/`.

> **Deux correctifs critiques trouvés par PG-28** en vérifiant, pour la
> première fois, que l'application fonctionne réellement sous le rôle
> `securisite_app` documenté ci-dessous (RLS pleinement appliquée, jamais
> de `BYPASSRLS`) plutôt que sous le superutilisateur qu'utilise toute la
> suite de tests par ailleurs — voir `tests/postgres-scope-rls.test.js` :
> 1. `backend/scope.js#resolveScope()` ne posait jamais l'acteur RLS avant
>    de lire `memberships`/`tenants` — sous le rôle réel, **absolument
>    aucune route gardée par `requireScope()` ne fonctionnait** (`hasAccess`
>    toujours faux). Corrigé.
> 2. `backend/security-audit.js#record()` utilisait `INSERT ... RETURNING
>    id` sur `security_audit` (RLS active) — un événement à `tenant_id`
>    NULL (login) faisait échouer l'INSERT entier sous le rôle réel,
>    jamais seulement son `RETURNING`. Pour un événement à l'intérieur
>    d'une transaction critique (`alert.create`), cela aurait fait
>    échouer la mutation elle-même. Corrigé (plus de `RETURNING`).
>
> Les deux étaient masqués depuis PG-8/PG-9/PG-10 : rien dans la suite de
> tests, avant PG-28, n'exerçait jamais le chemin de requête applicatif
> sous un rôle réellement soumis à RLS.

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
ni créer, ni modifier une structure, ni contourner RLS — `NOBYPASSRLS` est
maintenant réellement significatif depuis PG-9 (migration `005`) : la Row Level
Security est active sur `tenants`/`sites`/`zones`/`memberships`/
`membership_audit`, et `securisite_app` reçoit en plus `EXECUTE` sur
`securisite_meta.current_actor_tenant_ids()` (la fonction que ces politiques
appellent) — voir `docs/postgresql-scope.md`.

Les noms de rôles sont surchargables : `SECURISITE_OWNER_ROLE`,
`SECURISITE_MIGRATOR_ROLE`, `SECURISITE_APP_ROLE`.

## 2. Ordre de provisioning (une fois par base)

`db:roles` (`provision-roles.js#apply`) est réexécutable : il crée les rôles
et accorde d'abord ce qui ne dépend pas du schéma (CONNECT). Le `GRANT` sur
`securisite_meta` et les tables métier — qui dépend du schéma — n'est plus une
étape séparée à relancer à la main après les migrations : `db:migrate`
(`migrate-cli.js`) le fait lui-même, automatiquement, juste après avoir
appliqué les migrations, avec la seule connexion MIGRATOR déjà en main
(`provision-roles.js#finalizeGrants` — jamais de connexion administrateur ni
de mot de passe APP à cette étape). Avant ce correctif, cette seconde passe
manuelle de `db:roles` était facile à oublier ou à lancer trop tôt (avant
qu'une migration donnée n'ait créé la fonction RLS qu'elle grante) : APP se
retrouvait durablement sans `USAGE` sur `securisite_meta`, sans `SELECT` sur
`securisite_meta.schema_migrations` ou sans `EXECUTE` sur les fonctions
RLS — jamais détecté par `/api/ready` (voir §5), et provoquant des `42501` en
production dès la première requête sur une table sous RLS (alerts, incidents,
visiteurs, notifications, realtime).

```
# 1. Rôles + attributs + CONNECT, en tant qu'administrateur du cluster.
#    a) revue DBA :
SECURISITE_TARGET_DB=securisite npm run db:roles -- --emit > roles.sql
psql -h HOST -U ADMIN -d securisite -v migrator_password=… -v app_password=… -f roles.sql
#    b) application directe (mots de passe par l'environnement, jamais journalisés) :
DATABASE_URL='postgres://ADMIN:…@HOST/securisite' \
SECURISITE_MIGRATOR_PASSWORD='…' SECURISITE_APP_PASSWORD='…' \
  npm run db:roles
#    -> « schéma incomplet » si le schéma n'est pas encore là : normal avant
#       les migrations, complété automatiquement par l'étape 2.

#    (La base est créée avec OWNER = securisite_owner :
#       CREATE DATABASE securisite OWNER securisite_owner;
#     l'ordre exact — rôle owner avant createdb — dépend de l'outil ; en cas de
#     besoin, créer d'abord les rôles sur la base « postgres » puis la base cible.)

# 2. Migrations, en tant que MIGRATOR, AVANT tout démarrage applicatif — GRANT
#    runtime d'APP finalisés automatiquement dans la foulée :
DATABASE_URL='postgres://securisite_migrator:…@HOST/securisite' PGSSL=verify-full \
  npm run db:migrate

# 3. Premier administrateur applicatif + membership SOC (mot de passe par
#    l'environnement ou un TTY) — un seul processus Node, sans bash :
DATABASE_URL='postgres://securisite_migrator:…@HOST/securisite' PGSSL=verify-full \
SECURISITE_ADMIN_PASSWORD='…' \
  npm run db:create-first-admin -- admin
#    Idempotent : ne modifie jamais un compte ni un membership existant.
#    (db:create-admin puis db:bootstrap-admin-membership restent utilisables
#    séparément si besoin ; db:create-first-admin les enchaîne tous les deux.)

# 4. Démarrage de l'application en tant qu'APP :
DATABASE_URL='postgres://securisite_app:…@HOST/securisite' PGSSL=verify-full \
  npm run server
#    start() fait db.init() -> attestation readiness (lecture seule) -> écoute.
#    Aucune migration, aucun seed, aucune réparation au démarrage.
```

Aux montées de version suivantes, seule l'étape 2 (migrations, GRANT compris)
est rejouée avant le rollout.

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

- **Readiness** : deux niveaux distincts, jamais confondus (PG-18) —
  - **au démarrage** : `start()` échoue **avant** d'écouter si le registre,
    les versions 001..010, les tables métier, la ligne `alert_rules.id=1`,
    la fonction et les triggers append-only, RLS ou un privilège APP requis
    manquent (`backend/db/postgresql/readiness.js#assertReady`, audit
    exhaustif, coûteux, exécuté **une seule fois**) ;
  - **en continu** : `GET /api/ready` — un aller-retour PostgreSQL minimal
    (`SELECT 1`), pensé pour être interrogé en continu par un orchestrateur
    sans répéter l'audit exhaustif à chaque appel (`backend/health.js`).
- **Liveness** : `GET /api/health` — répond `{status:'ok'}` sans aucune
  dépendance externe, jamais bloqué par PostgreSQL (`backend/health.js`,
  PG-18). Ne pas utiliser `GET /api/ready` comme sonde de liveness : une
  base momentanément indisponible ferait alors redémarrer le processus
  pour un problème qui n'est pas le sien.
- **Migrations** : `npm run db:migrate` sortie `0` = base à jour ; `schema_migrations`
  contient exactement les versions des fichiers, avec noms et empreintes SHA-256.

## 6. Monitoring

- **Logs structurés** (PG-18, `backend/observability.js`) : une ligne JSON
  par requête `/api/*` (hors `/api/health`/`/api/ready`, trop fréquentes
  pour constituer un signal) sur stdout — `request_id`, `correlation_id`,
  `method`, `path`, `status`, `duration_ms`, `tenant_id`, `site_id`,
  `alert_id`, `error_code`. Allowlist stricte : ni secret, ni JWT, ni
  contenu de requête/réponse n'y figure structurellement — voir
  `docs/observability.md`.
- **Journal de sécurité** (PG-10, `security_audit`) : connexions,
  refus d'accès, mutations sensibles, événements IA (PG-24) —
  interrogeable par un rôle `soc` via RLS, jamais par simple lecture de
  logs. Voir `docs/postgresql-security-audit.md`.
- **Métriques de pool** : `db.stats()` (`backend/database.js`) expose
  `total`/`idle`/`waiting` — non branché sur un exportateur externe
  aujourd'hui (aucune nécessité démontrée), disponible pour un futur
  point de collecte sans changement de code.

## 7. Arrêt (shutdown)

`server.js#start()` retourne `stop()`, **idempotent**, câblée sur
`SIGTERM`/`SIGINT` (lancement direct `node server.js`) :

1. plus aucun nouveau cycle d'escalade (`alerts.escalateDue`, PG-1) ni
   nouvel envoi push (`push.stop()`, PG-13) ;
2. attend la fin du cycle d'escalade en cours (au plus
   `SHUTDOWN_GRACE_MS`, 10 s par défaut) ;
3. ferme l'écoute HTTP (même plafond), puis force la fermeture des
   connexions restantes ;
4. ferme le pool PostgreSQL **en dernier** — jamais avant que tout le
   reste ait eu sa chance de se terminer proprement.

Au-delà du délai, l'arrêt se poursuit quand même (jamais un arrêt qui ne
se termine pas) : un arrêt gracieux borné, pas un arrêt garanti sans
perte pour un cycle déjà en cours.

## 8. Déploiement : job migration → readiness → rollout

1. **Job de migration** (rôle MIGRATOR) : `npm run db:migrate`. Sérialisé par un
   verrou consultatif ; transaction par migration ; succès obligatoire — un job
   en échec ne doit jamais être suivi d'un rollout applicatif.
2. **Readiness** : l'orchestrateur ne bascule le trafic que si une instance
   applicative démarre (donc l'attestation readiness a réussi).
3. **Rollout applicatif** : instances `securisite_app` uniquement.

### Rollback

- **Applicatif** : redéployer la version précédente **compatible avec le schéma
  courant**. Les migrations sont *forward-only* : ne jamais rétrograder le schéma
  pour un rollback applicatif.
- **Schéma** : restauration depuis une sauvegarde (`backend/db/postgresql/
  backup.js`/`restore.js`, PG-27 — voir `docs/postgresql-backup-restore.md`).
  Il n'existe pas de migration descendante automatique.
- **Compatibilité réelle, migration par migration** (revue de chaque
  fichier, pas une affirmation générique) : `001`–`004`, `006`, `008` créent
  uniquement de nouveaux objets (tables/colonnes) — une version applicative
  antérieure qui ne les connaît pas continue de fonctionner sans erreur, elle
  les ignore simplement. `007` n'ajoute que des index (toujours transparent).
  `010` élargit une contrainte `CHECK` déjà en place (`origin`) — une version
  antérieure qui n'a jamais utilisé la valeur ajoutée (`'ai'`) n'est pas
  affectée. **Deux exceptions, à connaître avant tout rollback applicatif :**
  - `005` (RLS) : une version applicative antérieure à PG-9 qui lirait
    `tenants`/`sites`/`zones`/`memberships`/`membership_audit` sans jamais
    poser `securisite.actor_user_id` (`withActorContext`, PG-9) verrait ces
    tables **vides** sous le rôle `securisite_app` (RLS s'applique sans
    acteur résolu = aucune ligne visible) — pas une erreur, un
    comportement silencieusement dégradé. Sans conséquence pour un
    rollback vers une version postérieure à PG-6 mais antérieure à PG-9
    qui ne lit pas ces tables (elles n'existaient pas encore dans son
    propre périmètre de fonctionnalités) ; à vérifier explicitement pour
    toute version intermédiaire qui le ferait.
  - `009` (`security_alerts.tenant_id NOT NULL`) : une version applicative
    antérieure à PG-16 qui insère une alerte sans fournir `tenant_id`
    échoue la contrainte `NOT NULL` — rollback vers une version antérieure
    à PG-16 **non compatible** avec le schéma issu de `009` sans
    intervention (soit rendre la colonne nullable temporairement, soit ne
    pas rétrograder au-delà de PG-16).

## 9. Import de données SQLite → PostgreSQL (`npm run db:import`)

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

## 10. Notes

- `backend/db/postgresql/migrate.js` (runner) et `migrate-cli.js` (CLI) sont
  distincts de `server.js` : l'application ne migre jamais.
- L'ancien `backend/seed.js` (données de démonstration SQLite, non chargé par le
  serveur) a été retiré au lot PG-4. Le provisioning applicatif se limite au
  premier administrateur ; il n'y a pas de jeu de données de démonstration
  PostgreSQL.
- `backend/db/migrate.js`, `backup.js`, `migrations/001_baseline.js` restent des
  références SQLite du lot A2, testées isolément (`tests/migrations.test.js`).
