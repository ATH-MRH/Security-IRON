# PG-2 — Runner PostgreSQL versionné et schéma historique

## Périmètre PG-2.1

PG-2.1 ajoute uniquement `backend/db/postgresql/migrate.js`, sa suite de tests
et ce contrat. Aucune migration métier n'est livrée par PG-2.1. Aucun users, employes,
visiteurs, véhicules, Alert Core, tenant/site/zone, membership ou RLS créé par
le runner. Les objets `pg21_*` des tests sont des fixtures dans des bases jetables.
PG-2.2 ajoute la migration 001 décrite plus bas, soumise à sa propre review.
PG-2.3 ajoute ensuite la migration 002 Alert Core décrite en fin de document.

Aucun changement de dépendance, du serveur, des repositories, du frontend ou
du système de migrations SQLite. PG-1 reste intact. Aucun import SQLite.

## API et configuration explicite

Le module expose `migrate`, `discover` et la constante `LOCK_KEY`.
`migrate({ directory, migrationEnv, lockTimeoutMs, retryDelayMs })` est asynchrone.
`directory` et `migrationEnv` sont obligatoires : aucun catalogue métier par
défaut et aucun repli silencieux sur les variables runtime.

`migrationEnv` suit la validation de `backend/database.js` : DATABASE_URL ou
champs PG explicites, TLS vérifié par défaut, timeouts et paramètres bornés.
Le runner fixe `application_name=securisite-migrator`. Aucun secret ni URL n'est
journalisé. Le paramètre avancé `ClientClass` sert uniquement à injecter des
fautes dans les tests ; il ne change pas l'identité par défaut du runner.

Le runner ouvre un `pg.Client` dédié, sans Pool. Il garde la même session pour
le verrou et toutes les transactions. Son listener `error` est installé avant
connect et conservé jusqu'à end. Une erreur client mémorisée interdit les
requêtes suivantes. La connexion est toujours fermée, jamais recyclée.

Le résultat normal est `{ applied: [versions], reconciled: false, pending: [] }`.
Un catalogue vide est autorisé : il initialise uniquement le registre sur une
base vide. Les connexions refusées ou erreurs de configuration arrêtent le runner.

## Catalogue SQL

Format strict : `NNN_nom.sql`, par exemple `001_example.sql`. Trois chiffres,
versions 001 à 999, nom commençant par une lettre minuscule puis lettres
minuscules/chiffres/underscore. Versions uniques et consécutives depuis 001.
Tous les éléments du répertoire sont contrôlés : fichiers JS, noms invalides,
sous-répertoires et liens symboliques sont refusés. Aucun chargement JS.

Chaque entrée est ouverte avec O_RDONLY | O_NOFOLLOW (et O_NONBLOCK pour ne pas
bloquer sur un FIFO substitué). Le type régulier est vérifié par fstat sur le FD,
puis readFileSync lit ce FD et closeSync le ferme dans finally, même sur erreur.
Aucune lecture par pathname ne suit cette validation. Un symlink substitué entre
readdir et open est refusé par le système. Un remplacement après open ne change
pas l'inode dont les octets sont lus : le descripteur devient l'autorité.

O_NOFOLLOW est vérifié à l'exécution ; absent ou nul => UNSUPPORTED_PLATFORM,
sans repli vers une lecture non protégée. Environnement vérifié : Node 22.22.2,
macOS, O_NOFOLLOW=256. Les autres plateformes doivent fournir cette primitive.
Le répertoire configuré et ses parents restent des chemins de déploiement de
confiance ; O_NOFOLLOW protège l'entrée finale, pas tous les ancêtres du chemin.

Chaque fichier est lu une seule fois avant toute connexion. Le SHA-256 porte
sur ses octets exacts, sans normaliser les fins de ligne. UTF-8 valide et sans
NUL obligatoire ; l'aller-retour encodage doit restituer les octets d'origine.
L'exécution utilise cette copie mémorisée, jamais une deuxième lecture du disque.
Une modification du fichier pendant l'attente du verrou ne change donc pas le
contenu exécuté. Au lancement suivant, le checksum modifié sera refusé.

## Analyse lexicale et commandes interdites

Le runner n'utilise pas un split sur les points-virgules. Il inspecte les débuts
de commandes hors chaînes, identifiants cités, commentaires imbriqués et corps
dollar-quoted. Chaînes SQL avec quotes doublées, chaînes E avec échappements,
commentaires `--` et `/* ... */`, tags dollar-quoted et leurs points-virgules
sont pris en compte. Une chaîne ou un commentaire non terminé est refusé.

BEGIN, COMMIT, ROLLBACK, leurs alias END/ABORT, START TRANSACTION,
PREPARE TRANSACTION et SAVEPOINT/RELEASE sont interdits au niveau commande.
SET, RESET et DISCARD sont aussi interdits : la session appartient au runner.
Les corps de fonctions/triggers doivent être dollar-quoted ou des chaînes SQL ;
les corps SQL non cités BEGIN ATOMIC ne sont pas un format supporté en PG-2.1.
PostgreSQL reste responsable de la validation grammaticale complète.

Ce contrôle n'est pas un sandbox pour SQL malveillant : les migrations sont du
code de déploiement de confiance, soumis à review. Elles ne doivent pas manipuler
le registre, les advisory locks ou les paramètres de session, y compris via des
fonctions. Aucun script psql, accès réseau ou exécution de code JavaScript.

## Registre technique

Schéma `securisite_meta`, table `securisite_meta.schema_migrations` :

| Colonne | Contrat |
| --- | --- |
| version | INTEGER PRIMARY KEY |
| name | TEXT NOT NULL UNIQUE |
| checksum | TEXT NOT NULL, CHECK exactement 64 caractères hexadécimaux |
| applied_at | TIMESTAMPTZ NOT NULL, horodatage serveur lors de l'enregistrement |
| execution_ms | BIGINT NOT NULL, CHECK >= 0, durée avant confirmation du COMMIT |

Le registre est initialisé dans sa propre transaction sous verrou. Les types,
la nullabilité, les colonnes et les contraintes attendues sont vérifiés ; une
table temporaire, une vue ou un registre avec RLS est refusé. Il n'est pas réparé
silencieusement. Un registre inaccessible provoque une erreur, pas sa recréation.

Sans registre, le runner refuse les objets utilisateur préexistants : relations,
fonctions, types de public ou schémas utilisateur autres que public. Cette règle
conservatrice refuse aussi un schéma technique partiellement installé. PG-2.1
ne certifie/adopte pas une base historique, et n'importe aucun ancien registre.

## Historique et immutabilité

Les lignes triées par version doivent être un préfixe exact du catalogue :
version, nom et checksum identiques, métadonnées valides. Une version DB inconnue,
un trou, une migration appliquée absente/renommée ou un checksum différent arrête
le runner avant une nouvelle migration. Aucune option fake/ignore-checksum.

Après application, les fichiers sont immuables. Les corrections sont de nouvelles
migrations en avant. Une migration échouée, dont la transaction et l'entrée de
registre sont absentes, peut être corrigée avant reprise explicite. Le checksum
contrôle les fichiers appliqués ; ce n'est pas un audit exhaustif du schéma métier.

## Advisory lock

Clé PostgreSQL de session à deux int32 : `(0x53454355, 1)` = espace SECU / migrations.
Cette clé est fixe et doit rester identique pour toutes les versions du runner.
Acquisition par `pg_try_advisory_lock` ; attente entre essais de 50 ms par défaut.
`lockTimeoutMs=30000` définit une deadline d'acceptation stricte, en millisecondes
monotones via performance.now(). Les options sont des entiers strictement positifs.
L'échéance est contrôlée AVANT chaque essai et APRÈS chaque réponse, avant toute
acceptation du verrou. FALSE à l'échéance => LOCK_TIMEOUT ; sinon l'attente suivante
est limitée au budget restant.

TRUE reçu à/après l'échéance => pg_advisory_unlock immédiat sur LA MÊME session,
vérification du booléen retourné, puis LOCK_TIMEOUT. Aucun bootstrap ni SQL de
migration n'est autorisé. Un échec d'unlock reste secondaire dans unlockError ;
la fermeture de session libère alors le verrou. Le code LOCK_TIMEOUT remplace
MIGRATION_LOCK_TIMEOUT pour tous les dépassements du budget d'acquisition.

Chaque tentative reçoit aussi un query_timeout client égal au budget restant,
arrondi au milliseconde supérieure ; la vérification monotone reste l'autorité
pour accepter ou refuser la réponse. Un timeout de lecture est converti en
LOCK_TIMEOUT avec cause, puis la session dédiée est fermée, jamais réutilisée.
L'état d'acquisition peut alors être inconnu : la fermeture de session est requise.
Aucune modification du timeout SQL des migrations ni de backend/database.js.

Le nettoyage d'un TRUE tardif a son propre délai de lecture maximal de 1000 ms.
La deadline interdit d'accepter une acquisition tardive ; elle ne promet pas que
le retour à l'appelant précède la fin du nettoyage. Les timers Node ne peuvent pas
préempter un event loop bloqué, mais une réponse tardive reste refusée à sa reprise.
Le délai de connexion initial reste celui de PG-1 et précède cette deadline.

Une deuxième instance attend, puis relit le registre après acquisition. Si la
première a terminé, elle renvoie un no-op. Le verrou survit aux COMMIT et ROLLBACK
successifs ; unlock explicite uniquement à la fin de la série, puis end.

Après crash, PostgreSQL libère le verrou lorsqu'il constate la fin de la session,
pas forcément à l'instant où le processus Node meurt. Une requête en cours peut
retarder cette détection. Le runner n'interrompt pas arbitrairement le détenteur.
Il attend dans son délai ou échoue proprement. Les advisory locks sont coopératifs.

## Transactions et erreurs

Chaque migration : BEGIN, exécution SQL, validation de l'historique encore intact,
INSERT du registre, COMMIT, sur la même connexion. Aucun succès annoncé si COMMIT
ne répond pas COMMIT. Aucun format non transactionnel dans PG-2.1 ; les commandes
que PostgreSQL interdit dans une transaction échouent et ne sont pas enregistrées.

Si 001 réussit et 002 échoue, 001 reste validée ; 002 et son registre sont annulés.
Une reprise explicite vérifie toute l'histoire et commence à 002. Il n'existe pas
de commande down automatique ni de rollback des migrations déjà confirmées.

L'erreur publique MIGRATION_FAILED contient l'erreur SQL primaire dans `cause` ;
`rollbackError` et `clientError` sont attachées si présentes. `unlockError` et
`closeError` conservent les éventuelles erreurs de nettoyage sans remplacer la
cause initiale. Ne pas sérialiser ces objets bruts vers une API ou des logs publics :
les détails SQL peuvent contenir des valeurs sensibles. Le module ne les loggue pas.

## Connexion perdue et COMMIT incertain

Une perte pendant le SQL arrête la série sans replay. Une erreur pendant COMMIT
entraîne une unique réconciliation :

1. Fin de l'ancienne connexion ; tentative de rollback/nettoyage sans masquer l'erreur.
2. Nouvelle connexion, acquisition de la même clé de verrou de session.
3. Validation du registre existant, sans CREATE ni réparation, puis de son historique.
4. Entrée attendue présente/cohérente : migration considérée appliquée.
5. Entrée absente avec préfixe antérieur intact : COMMIT_NOT_APPLIED ; reprise explicite.
6. Registre absent/inaccessible, checksum divergent, historique antérieur perdu,
   connexion ou verrou non acquis : COMMIT_INDETERMINATE ; arrêt manuel explicite.

Même quand la présence est confirmée, aucune migration supplémentaire n'est exécutée
pendant cet appel : `{ reconciled: true, applied, pending, warning }` signale l'arrêt
de la série. `applied` décrit les versions exécutées/confirmées pour cet appel ;
`pending` tient compte de l'historique relu, éventuellement avancé par un autre runner.
Le déploiement doit vérifier pending avant de déclarer le schéma à jour.

La même réconciliation couvre le COMMIT du bootstrap technique. Un registre présent
et conforme confirme le bootstrap, sans appliquer ensuite de migration ; un registre
absent n'est déclaré non appliqué qu'après vérification d'une base entièrement vide.
Tout état partiel ou incohérent exige une intervention manuelle. Une erreur avant
la phase COMMIT du bootstrap produit REGISTRY_FAILED, sans reprise automatique.
Pas de promesse de rollback serveur lorsque COMMIT a pu réussir. Les tests simulent
une réponse COMMIT perdue après un vrai commit, puis terminent réellement la session
PostgreSQL et vérifient l'absence de double DML ou de recréation du registre.

## Search path, rôles et sauvegarde

Le runner impose `pg_catalog, public, pg_temp`, `standard_conforming_strings=on`
et `client_encoding=UTF8`. Les métadonnées sont toujours qualifiées. Les futures
migrations métier devront qualifier leurs objets explicitement.

Aucun rôle n'est provisionné par le runner. L'identité migrateur est explicitement
fournie ; le test non-superuser confirme que les privilèges suffisants permettent
l'initialisation et les migrations sans superuser. Modèle futur :

- securisite_owner : NOLOGIN, propriétaire des objets ;
- securisite_migrator : identité du job autorisée à prendre le rôle propriétaire ;
- securisite_app : runtime sans DDL, sans modification du registre ni appartenance owner.

L'application ne reçoit pas les credentials migrateur. Les grants/ownership complets
et les règles d'audit métier viendront dans leurs lots dédiés. Aucun RLS en PG-2.1.
Aucun backup dans le runner : le déploiement doit confirmer une sauvegarde/snapshot
et sa procédure de restauration AVANT le job migrateur. Aucun pg_dump lancé ici.

## Exécuter les tests

Exporter SECURISITE_TEST_DATABASE_URL vers une instance locale PostgreSQL 16 jetable,
avec un nom accepté par tests/helpers/postgres-test-config.js. Aucun repli sur
DATABASE_URL. Le compte de test doit pouvoir créer/supprimer les bases fixtures et
les rôles nécessaires au test de séparation des privilèges. Cela ne décrit pas les
privilèges exigés du migrateur de production. Ne jamais utiliser un cluster partagé
avec la production, même si le nom de base passe le garde-fou.

```sh
node --test tests/postgres-migrations.test.js
npm run test:pg
```

Chaque scénario crée une base securisite_test_pg21_<aléatoire> distincte et un
répertoire de fixtures temporaire ; les deux sont supprimés dans le nettoyage.
Le test de concurrence lance deux processus Node distincts : A applique 001/002,
B attend, relit le registre et n'exécute rien. Des assertions vérifient le verrou
après COMMIT et ROLLBACK. Les tests utilisent PostgreSQL réel ; les injections
ClientClass ciblent les fenêtres de perte de réponse autrement non déterministes.

Validation PG-2.1 avant ajout de PG-2.2 : PostgreSQL 16.13, SCRAM-SHA-256, cluster local jetable.
68/68 tests migrations ; PG-1 inchangé 47/47 (21 PostgreSQL + 26 configuration/fautes).
Test global : 218 succès / 230 résultats, 12 échecs historiques SQLite inchangés
(dix tests Alert Core bloqués par assertSchemaReady, hook final db.raw.close,
un test de démarrage des migrations SQLite). Notifications 34/34 ; migrations
SQLite 69/70. Aucun fichier de test historique modifié.

À la fin de la validation : zéro base fixture résiduelle, zéro table publique
sur la base de test principale ; cluster arrêté et supprimé. Aucune table métier.

Références :
- https://www.postgresql.org/docs/16/sql-syntax-lexical.html
- https://www.postgresql.org/docs/16/explicit-locking.html

## Validation des deux corrections de review

15 tests ajoutés : substitution symlink après inventaire, remplacement après
ouverture du FD, remplacement d'inode après catalogue, chaîne de symlinks externe,
substitution par répertoire, fermeture FD sur erreur de lecture, plateforme sans
O_NOFOLLOW ; FALSE rapide à budget 20 ms, TRUE réel reçu tard et unlock sur même
PID, FALSE puis TRUE avant/après deadline, erreur/résultat FALSE d'unlock tardif,
lecture réellement ralentie bornée par query_timeout ; concurrence à trois Node.
Le symlink statique et les fichiers réguliers sont aussi couverts par les tests
préexistants. Aucune fixture extérieure n'est exécutée après substitution symlink.

Pour le TRUE tardif, le test conserve la réponse d'une vraie acquisition PostgreSQL
pendant 60 ms avec un budget de 20 ms. Il vérifie LOCK_TIMEOUT, unlock confirmé sur
le même PID, absence de registre/DDL fixture, puis succès d'un runner suivant.
Un autre test ralentit une vraie requête serveur avec pg_sleep(0.4) : le timeout
client de 30 ms termine l'attente sans laisser démarrer le bootstrap.
Les scénarios checksum, réconciliation de COMMIT/bootstrap, PL/pgSQL, multi-statements,
crash et perte de session sont conservés. Deux et trois processus appliquent chaque
migration une seule fois. Aucun test PG-1 ou historique n'a été modifié.


## PG-2.2 — 001_core_legacy.sql

Fichier : `backend/db/postgresql/migrations/001_core_legacy.sql`.
Schéma de compatibilité uniquement : 13 tables dans `public`, aucun import,
aucun utilisateur/admin, mot de passe, paramètre ou autre seed.
Aucun portage de route/service/repository ni branchement au démarrage.
PG-1 et le runner PG-2.1 ne sont pas modifiés. Le catalogue de validation
PG-2.2 contient uniquement 001 ; il est fourni explicitement à migrate
comme en PG-2.1. Le catalogue applicatif complet inclut désormais 002 (PG-2.3).

La migration ne crée aucun rôle, base, schéma, extension, routine ni trigger
utilisateur. Aucun GRANT, RLS ou changement de permissions applicatives.
Aucune table Alert Core (`security_alerts`, `alert_audit`,
`alert_notifications`, `alert_config_audit`, `alert_rules`) ni
`tenants`, `sites`, `zones`, `memberships`.
`parking_zones` est la table de parking historique, pas le futur zonage multi-client.

### Types et contraintes

Toutes les colonnes métier restent TEXT sauf :

- `users.id` : INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY ;
- `employes.atlas_id`, `employes.site_id` : INTEGER nullable ;
- `parking_zones.total/reserve/handicap`, `parking_mouvements.duree`,
  `lapi_lectures.confiance` : INTEGER nullable.

Les 12 autres PK sont TEXT : id, sauf badges.ref, parking_zones.zone,
parking_places.num et parametres.cle. Chaque PK est implicitement NOT NULL
dans PostgreSQL. UNIQUE historiques : users.username, employes.matricule,
incidents.ref. Les deux derniers restent nullable, avec plusieurs NULL autorisés.
Seuls users.username et users.password_hash sont NOT NULL en plus des PK.
Aucun CHECK métier ajouté, aucune normalisation des valeurs et aucun enum.

Les defaults sont limités à users : role = 'agent' ; created_at =
`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
Le résultat est TEXT ISO UTC avec millisecondes, indépendant du fuseau de la
session. clock_timestamp représente l'instant d'insertion, sans figer l'heure
au début d'une transaction longue. nom_complet, role et created_at restent
nullable ; un NULL explicite n'est pas remplacé par le défaut.
Toutes les dates historiques restent TEXT ; même une ancienne valeur non ISO
est conservée à l'insertion explicite, sans conversion silencieuse.

created_by reste TEXT nullable sans FK dans les neuf tables concernées.
employes.site_id est une référence externe historique sans FK vers un futur site ;
atlas_id, site_nom, groupe, date_affectation sont conservés.
parking_mouvements.place/zone restent TEXT sans FK.
Seule FK métier : parking_places.zone (nullable) vers parking_zones.zone,
MATCH SIMPLE, ON UPDATE NO ACTION, ON DELETE NO ACTION, immédiate/non différable.
Un parent référencé ne peut être supprimé/renommé ; aucune cascade destructive.

### Comparaison historique vérifiée

Sources :

- PostgreSQL historique : `15d0198a70859e7b26bb1e5157b0887ef5697b17:backend/database.js`,
  tableau SCHEMA complet, y compris les ALTER ajoutant les champs Atlas ;
- SQLite actuelle : `backend/db/migrations/001_baseline.js` au HEAD
  `cde512915528c85b45072cc2ce7cdbb0f8bae10f`, SCHEMA plus ajout de created_by ;
- PostgreSQL PG-2.2 : catalogue réel après application de 001 via le runner.

La comparaison a exécuté uniquement le DDL historique dans une base PostgreSQL
jetable, le DDL SQLite des 13 tables en mémoire, et la nouvelle migration dans
une autre base jetable. Aucun init/seed historique exécuté. Colonnes, ordre,
types, nullabilité et defaults ont été comparés. Les listes suivantes incluent
toutes les colonnes, dans leur ordre physique.

| Table | Colonnes PG historique | Colonnes SQLite actuelle | Colonnes PG-2.2 | Écart volontaire |
| --- | --- | --- | --- | --- |
| badges | ref, nom, type, niveau, emis, validite, etat, societe | ref, nom, type, niveau, emis, validite, etat, societe, created_by | ref, nom, type, niveau, emis, validite, etat, societe, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| employes | id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation, atlas_id, site_id, site_nom, groupe, date_affectation | id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation, atlas_id, site_id, site_nom, groupe, date_affectation, created_by | id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation, atlas_id, site_id, site_nom, groupe, date_affectation, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| incidents | id, ref, datetime, type, lieu, gravite, statut, agent, description, actions | id, ref, datetime, type, lieu, gravite, statut, agent, description, actions, created_by | id, ref, datetime, type, lieu, gravite, statut, agent, description, actions, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| lapi_lectures | id, datetime, plaque_detectee, plaque_raw, confiance, image, statut, action | id, datetime, plaque_detectee, plaque_raw, confiance, image, statut, action, created_by | id, datetime, plaque_detectee, plaque_raw, confiance, image, statut, action, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| main_courante | id, datetime, poste, agent, type, lieu, description, priorite | id, datetime, poste, agent, type, lieu, description, priorite, created_by | id, datetime, poste, agent, type, lieu, description, priorite, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| parametres | cle, valeur | cle, valeur | cle, valeur | Aucun écart de colonnes |
| parking_mouvements | id, datetime, plaque, place, zone, action, duree | id, datetime, plaque, place, zone, action, duree, created_by | id, datetime, plaque, place, zone, action, duree, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| parking_places | num, zone, etat, plaque | num, zone, etat, plaque | num, zone, etat, plaque | Aucun écart de colonnes |
| parking_zones | zone, nom, total, reserve, handicap | zone, nom, total, reserve, handicap | zone, nom, total, reserve, handicap | Aucun écart de colonnes |
| pietons | id, datetime, nom, badge, type, point, sens, resultat, notes | id, datetime, nom, badge, type, point, sens, resultat, notes, created_by | id, datetime, nom, badge, type, point, sens, resultat, notes, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| users | id, username, password_hash, nom_complet, role, created_at | id, username, password_hash, nom_complet, role, created_at | id, username, password_hash, nom_complet, role, created_at | SERIAL / AUTOINCREMENT → identity ; TIMESTAMPTZ historique → TEXT ISO UTC |
| vehicules | id, plaque, type, conducteur, societe, motif, entree, sortie, statut, place_parking, lapi_photo | id, plaque, type, conducteur, societe, motif, entree, sortie, statut, place_parking, lapi_photo, created_by | id, plaque, type, conducteur, societe, motif, entree, sortie, statut, place_parking, lapi_photo, created_by | created_by ajouté depuis SQLite, absent du PG historique |
| visiteurs | id, prenom, nom, societe, hote, motif, arrivee, badge, statut | id, prenom, nom, societe, hote, motif, arrivee, badge, statut, created_by | id, prenom, nom, societe, hote, motif, arrivee, badge, statut, created_by | created_by ajouté depuis SQLite, absent du PG historique |


Écarts explicites transverses :

- Les PK TEXT de SQLite rowid peuvent techniquement accepter NULL, contrairement
  aux PK PostgreSQL historiques et PG-2.2. La migration garde de vraies PK ;
  PG-6 devra diagnostiquer/refuser ces éventuelles lignes avant import.
- INTEGER PostgreSQL est un entier signé 32 bits ; SQLite INTEGER peut contenir
  du 64 bits et son typage dynamique peut admettre d'autres types. PG-6 devra
  valider les plages et types avant import (aucune conversion/import dans PG-2.2).
- Aucun default supplémentaire : seuls les mécanismes de génération de users.id
  et de date users.created_at changent selon le contrat validé.
- Les historiques PostgreSQL et SQLite utilisaient CREATE IF NOT EXISTS ;
  001 utilise CREATE strict, le registre PG-2.1 assurant le no-op au redémarrage
  et refusant l'adoption d'une base non versionnée.
- Les tables/seed Alert Core présents dans la baseline SQLite restent exclus.

### Index

Les sept index non uniques btree historiques sont conservés, même clés et ordre
ASC par défaut, sans prédicat :

- idx_employes_atlas : employes(atlas_id) ;
- idx_employes_site : employes(site_id) ;
- idx_pietons_dt : pietons(datetime) ;
- idx_incidents_dt : incidents(datetime) ;
- idx_vehicules_entree : vehicules(entree) ;
- idx_mc_dt : main_courante(datetime) ;
- idx_lapi_dt : lapi_lectures(datetime).

Ajout explicite : idx_parking_places_zone sur parking_places(zone).
Le code historique backend/routes.js recherche les places avec WHERE zone=$1
puis ORDER BY num. L'index accélère le filtre et les recherches du côté référençant
de la FK (PostgreSQL n'y crée pas automatiquement d'index). Il ne modifie ni
l'unicité ni la sémantique de tri ; le planificateur reste libre de son utilisation.
Les index des 13 PK et des trois UNIQUE sont créés automatiquement par PostgreSQL.

### Identity et futur import PG-6

users est la seule table auto-incrémentée parmi les 13. BY DEFAULT accepte un id
explicite sans OVERRIDING SYSTEM VALUE. La séquence users_id_seq est possédée par
users.id (dépendance interne identity). Une insertion sans id génère 1, 2, etc.

Un id explicite ne fait PAS avancer la séquence. Les tests prouvent :

- auto 1, import explicite 1000, auto suivant 2 ;
- import explicite 1 dans une table neuve, puis auto : erreur UNIQUE 23505.

PG-2.2 n'appelle ni setval ni RESTART. PG-6 devra, à la fin de l'import et avant
réouverture des écritures, repositionner explicitement l'identity en tenant compte
des IDs importés, de la table vide, des bornes INTEGER et des écritures concurrentes.
Cela devra être testé dans le lot import ; aucun automatisme prématuré ici.

### Transactions et privilèges

Le SQL ne contient aucune commande BEGIN/COMMIT/ROLLBACK et reste transactionnel
PostgreSQL 16. Le runner conserve le contrôle transactionnel.
Une erreur d'exécution volontaire après le dernier index, uniquement dans une
copie fixture, annule les 13 tables, la séquence identity, tous les index et
l'inscription version 1. Le registre technique vide reste présent car son
bootstrap appartient à une transaction distincte. Une reprise explicite avec
le vrai fichier réussit ; une deuxième exécution devient un no-op.

Aucun privilège de table ou séquence n'est accordé à PUBLIC par 001.
Les objets appartiennent à l'identité qui exécute le DDL ; les privilèges
préexistants/default privileges d'un environnement restent sous la responsabilité
de son administrateur. Le futur lot owner/app devra attribuer précisément
USAGE sur schémas/séquences et les droits DML nécessaires, avec séparation du
migrateur ; ne pas accorder de DDL ou de droits sur le registre au runtime.
PG-2.2 ne provisionne aucun rôle et ne finalise pas cette politique.

### Validation PG-2.2

Nouvelle suite indépendante : tests/postgres-core-legacy.test.js.
Elle passe le vrai catalogue au runner, crée une base isolée
securisite_test_pg22_<aléatoire> par scénario, puis la supprime.
Les données des tests existent uniquement dans ces fixtures.
Les deux copies modifiées de migration (checksum/erreur SQL) sont temporaires ;
le vrai fichier reste identique, vérifié par comparaison d'octets.

Avec SECURISITE_TEST_DATABASE_URL explicitement fourni vers un cluster local
jetable accepté par le helper PG-1 (et SECURISITE_TEST_PGSSL=disable pour
l'instance locale SCRAM sans TLS de cette validation) :

```sh
node --test tests/postgres-core-legacy.test.js
node --test tests/postgres-migrations.test.js
npm run test:pg
NODE_ENV=test PGSSL="$SECURISITE_TEST_PGSSL" DATABASE_URL="$SECURISITE_TEST_DATABASE_URL" npm test
node --check tests/postgres-core-legacy.test.js
git diff --check
```

Pour la comparaison globale, le runtime historique reçoit aussi exclusivement
l'URL de la même base locale jetable, afin d'atteindre son blocage assertSchemaReady
plutôt qu'un simple refus de configuration. Sans DATABASE_URL runtime, les mêmes
tests échouent plus tôt avec « Configuration PostgreSQL requise ».
La suite des fichiers suivis au HEAD (230 résultats) est relancée séparément :
218 succès, 12 échecs, mêmes cas et erreurs que le global incluant PG-2.2.

Résultats sur PostgreSQL 16.13 / Node 22.22.2, authentification SCRAM-SHA-256 :

- PG-2.2 : 35/35 ;
- runner PG-2.1 inchangé : 68/68 ;
- PG-1 inchangé : 47/47 ;
- npm test : 253/265, les 12 échecs SQLite préexistants uniquement
  (10 tests Alert Core bloqués par assertSchemaReady, hook db.raw.close,
  1 test de démarrage SQLite), aucun nouveau cas en échec ;
- syntaxe du JS ajouté et diff --check : conformes.

Les 35 tests vérifient notamment les 13 structures via pg_attribute/pg_attrdef,
PK/UNIQUE/FK via pg_constraint et insertions réellement refusées, index via
pg_index, identity et dépendance de séquence, dates UTC sous un autre fuseau,
absence de seed et droits PUBLIC, restart sans perte de données, checksum exact,
rejet de divergence et rollback complet. Aucun test historique n'est modifié.

## PG-2.3 — 002_alert_core.sql

Schéma de compatibilité Alert Core uniquement. Le catalogue applicatif
backend/db/postgresql/migrations contient désormais 001 puis 002.
Le résultat sur une base vide est 18 tables métier dans public et le registre
securisite_meta.schema_migrations. Aucun démarrage automatique de migration,
portage de repository/service/routes, changement de frontend, lifecycle,
permissions fonctionnelles, visibilité ou règle d'escalade.

### Tables et compatibilité

| Table | Contrat |
| --- | --- |
| security_alerts | PK id TEXT ; dates, site/zone, type/origin, username/status/owner, commentaires, equipment et policy TEXT ; level INTEGER CHECK 1..4 ; created_by et indicateurs INTEGER ; latitude/longitude DOUBLE PRECISION |
| alert_audit | PK id INTEGER GENERATED BY DEFAULT AS IDENTITY ; alert_id, created_at, actor, action, detail TEXT NOT NULL |
| alert_notifications | PK id INTEGER GENERATED BY DEFAULT AS IDENTITY ; alert_id, created_at, message TEXT NOT NULL ; user_id INTEGER NOT NULL ; read_at TEXT nullable |
| alert_config_audit | PK id INTEGER GENERATED BY DEFAULT AS IDENTITY ; created_at, actor, previous, current TEXT NOT NULL ; aucune colonne action |
| alert_rules | PK id INTEGER CHECK id=1 ; config TEXT NOT NULL ; aucune identity |

Les colonnes, leur ordre physique, leur nullabilité et leurs defaults sont repris
de backend/db/migrations/001_baseline.js. security_alerts.comment reste placé
avant latitude/longitude comme dans la baseline ; aucune réorganisation silencieuse.
Les deux adaptations de types sont explicites : SQLite REAL vers DOUBLE PRECISION,
et les trois PK INTEGER d'audit/notification vers identity BY DEFAULT. Les PK
PostgreSQL impliquent NOT NULL ; les contrôles d'import PG-6 restent nécessaires.

Pour security_alerts : owner, acknowledged_at, resolved_at, latitude et longitude
sont nullable. comment et equipment ont pour défaut la chaîne vide ; les deux
indicateurs cancellation_requested/escalation_step ont pour défaut 0.
Les autres colonnes sont NOT NULL. Aucun enum, validation JSON, CHECK de statut,
contrainte booléenne sur l'indicateur INTEGER ou nouvelle règle métier.
Toutes les dates et tous les JSON restent TEXT, sans cast automatique.
La migration conserve les données brutes que le code historique consomme.

Deux FK seulement : alert_audit.alert_id et alert_notifications.alert_id vers
security_alerts.id, NOT NULL, MATCH SIMPLE, NO ACTION en UPDATE et DELETE,
non différables. Aucune cascade destructive.
Aucune FK sur security_alerts.created_by ou alert_notifications.user_id vers users :
la suppression historique d'un utilisateur laisse les références et traces intactes.

Les trois identities acceptent un ID explicite, sans avancer la séquence :
auto 1, explicite 1000, auto 2 vérifiés pour chaque table.
PG-6 devra repositionner explicitement ces séquences après import, comme users.id.
INTEGER reste signé 32 bits ; vérifier les plages avant import.

### Règle initiale

La seule donnée créée par 002 est exactement :

```json
{"escalation":[30,60,120],"incidentCritical":true,"badgeThreshold":3,"badgeWindowSeconds":120}
```

Une ligne, id=1. Le JSON est strictement identique à la baseline et aux clés
lues/validées par backend/alert-core/service.js : escalation, incidentCritical,
badgeThreshold, badgeWindowSeconds. Pas de clé delays inventée.
Délais 30/60/120 secondes, incidents graves activés, trois refus de badge dans
120 secondes. Aucun compte, alerte, notification, audit ou donnée client créé.
Le seed utilise INSERT strict, dans la transaction 002 ; aucun ON CONFLICT
masquant un état inattendu. Le restart conserve une règle modifiée et ne la duplique pas.

### Index

| Nom | Colonnes ordonnées |
| --- | --- |
| alert_status_idx | security_alerts(status, level, created_at) |
| alert_notification_user_idx | alert_notifications(user_id, id) |
| alert_audit_alert_id_idx | alert_audit(alert_id, id) |
| alert_notifications_alert_id_idx | alert_notifications(alert_id) |

Tous sont btree non uniques, ordre ASC par défaut, sans prédicat.
Les deux premiers sont historiques ; les deux ajouts servent les recherches
par alerte, la timeline ordonnée par id et les FK. Ils ne sont pas couverts
par les PK id ou l'index de notification commençant par user_id.

### Audit append-only et modèle de privilèges

Une fonction dédiée securisite_meta.reject_alert_audit_mutation() retourne trigger.
Elle est SECURITY INVOKER, sans élévation de privilèges, avec search_path=pg_catalog.
Elle ne fait aucun SQL dynamique et lève « Audit immuable », SQLSTATE 23514.
Son EXECUTE est retiré à PUBLIC. Elle appartient au migrateur qui exécute le DDL,
comme les tables. Le schéma securisite_meta est déjà créé par PG-2.1.

Quatre triggers :

| Table | Trigger | Moment et portée |
| --- | --- | --- |
| alert_audit | alert_audit_no_mutation | BEFORE UPDATE OR DELETE, FOR EACH ROW |
| alert_audit | alert_audit_no_truncate | BEFORE TRUNCATE, FOR EACH STATEMENT |
| alert_config_audit | alert_config_audit_no_mutation | BEFORE UPDATE OR DELETE, FOR EACH ROW |
| alert_config_audit | alert_config_audit_no_truncate | BEFORE TRUNCATE, FOR EACH STATEMENT |

Une insertion normale reste autorisée. Toute mutation d'une ligne existante,
y compris ON CONFLICT DO UPDATE, MERGE UPDATE et MERGE DELETE, est refusée.
TRUNCATE est bloqué même sur une table vide ; TRUNCATE de security_alerts CASCADE
ne peut pas contourner la protection d'alert_audit. Une commande échouée
conserve les lignes originales ; aucune modification partielle.
Les UPDATE/DELETE ne visant aucune ligne ne modifient rien et ne déclenchent pas
les triggers ligne. Notifications, read_at et états d'alerte restent modifiables
selon leurs futurs droits et services : aucune protection ajoutée à ces tables.

Aucun rôle PostgreSQL définitif ni GRANT applicatif n'est livré.
Le futur rôle APP devra recevoir uniquement SELECT/INSERT sur les audits,
USAGE sur les séquences identity et les accès schéma nécessaires.
Il ne devra recevoir ni UPDATE/DELETE/TRUNCATE, ni ownership, ni droits DDL,
ni appartenance au rôle propriétaire/migrateur.
Les privilèges des autres tables et du runtime seront définis dans leur lot dédié.

Les tests utilisent des rôles jetables non propriétaires :

- SELECT/INSERT et USAGE de séquence autorisés ; UPDATE/DELETE/TRUNCATE,
  UPSERT modifiant et MERGE modifiant refusés par ACL (42501) ;
- ajout artificiel de UPDATE/DELETE/TRUNCATE ; mêmes mutations refusées par
  les triggers (23514, « Audit immuable »), lignes originales intactes.

L'invocation des triggers existants fonctionne aussi sans accorder EXECUTE
de la fonction ou USAGE sur securisite_meta à APP, vérifié réellement.
Aucun privilège de table/séquence accordé à PUBLIC par la migration.
Les default privileges préexistants restent à contrôler lors du provisionnement
du futur environnement ; ces tests utilisent un cluster neuf.

Limite explicite : le propriétaire peut modifier/supprimer les triggers,
fonctions ou tables ; un superuser peut notamment désactiver les triggers
ou utiliser session_replication_role. Cette protection n'est pas inviolable
face à l'administrateur. La séparation APP/OWNER/MIGRATOR est indispensable.
Aucun stockage externe inviolable ni politique complète de rôles prétendu ici.

### Atomicité, checksum et restart

Le runner PG-2.1 reste inchangé. 002 ne contient pas de contrôle transactionnel
au niveau commande ; le BEGIN/END du corps PL/pgSQL est celui de la fonction.
CREATE strict pour tous les objets, sans IF NOT EXISTS et sans extension ajoutée.
Le registre enregistre les checksums exacts de 001 puis 002.

Test d'échec : 001 appliquée, 002 copiée dans une fixture avec SELECT 1/0 final,
après fonctions/triggers et seed. Aucun objet 002 ni version 2 ne survit :
cinq tables, index, trois séquences, fonction et quatre triggers annulés.
001 et ses données restent intacts. Reprise explicite avec le vrai catalogue :
002 appliquée. Copie 002 modifiée après succès : HISTORY_MISMATCH.
Restart normal : aucune réinitialisation de règle, audit, séquence ou registre.

### Suites et isolation du lot précédent

Nouvelle suite : tests/postgres-alert-core-schema.test.js.
Elle utilise les vrais 001 et 002, le runner réel et une base
securisite_test_pg23_<aléatoire> par fixture. Les roles de test et copies SQL
temporaires sont nettoyés après chaque scénario.

Ajustement nécessaire de tests/postgres-core-legacy.test.js :
sa fixture copie maintenant uniquement le vrai 001 dans un répertoire temporaire.
Avant cet ajustement, elle appliquait tout le catalogue en exigeant 13 tables ;
l'ajout de 002 aurait transformé ce test de 001 en test accidentel de 001+002.
Aucune assertion, donnée attendue ou vérification PG-2.2 n'est modifiée.
La nouvelle suite teste séparément le catalogue complet et ses 18 tables.
La migration 001, le runner PG-2.1 et tous les tests PG-1/PG-2.1 sont inchangés.

Avec une URL SECURISITE_TEST_DATABASE_URL explicitement dirigée vers un cluster
PostgreSQL 16 local jetable et SECURISITE_TEST_PGSSL=disable pour ce cluster SCRAM :

```sh
node --test tests/postgres-alert-core-schema.test.js
node --test tests/postgres-core-legacy.test.js
node --test tests/postgres-migrations.test.js
npm run test:pg
NODE_ENV=test PGSSL="$SECURISITE_TEST_PGSSL" DATABASE_URL="$SECURISITE_TEST_DATABASE_URL" npm test
node --check tests/postgres-alert-core-schema.test.js
node --check tests/postgres-core-legacy.test.js
git diff --check
```

Validation PostgreSQL 16.13, Node 22.22.2, cluster local jetable SCRAM-SHA-256 :

- PG-2.3 : 54/54 ;
- PG-2.2 : 35/35 ;
- PG-2.1 : 68/68 ;
- PG-1 : 47/47 ;
- npm test : 307/319, exactement les 12 échecs SQLite historiques
  (dix cas bloqués par assertSchemaReady, hook db.raw.close et un démarrage SQLite),
  aucun nouvel échec.

Catalogues vérifiés : colonnes/types/defaults/identities, PK/FK/CHECK, clés et ordre
des index, fonction invoker et ACL, search_path, propriétaire, quatre triggers.
Un migrateur non superuser, sans CREATEROLE, applique aussi tout le catalogue.
Comparaison supplémentaire à la baseline SQLite en mémoire : même ordre et
contrat de colonnes ; seed config identique octet pour octet.

Aucune table tenant/site/zone/membership, aucun RLS, SSE, push/mobile ou portage
métier. Les colonnes coordonnées déjà historiques sont seulement conservées ;
aucune fonctionnalité GPS ou IA n'est activée.
