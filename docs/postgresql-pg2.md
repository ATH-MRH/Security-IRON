# PG-2.1 — Runner PostgreSQL versionné

## Périmètre

Ce lot ajoute uniquement `backend/db/postgresql/migrate.js`, sa suite de tests
et ce contrat. Aucune migration métier n'est livrée. Aucun users, employes,
visiteurs, véhicules, Alert Core, tenant/site/zone, membership ou RLS créé par
le runner. Les objets `pg21_*` des tests sont des fixtures dans des bases jetables.
PG-2.2 et PG-2.3 livreront les migrations métier après review séparée.

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

Validation : PostgreSQL 16.13, SCRAM-SHA-256, cluster local jetable.
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
