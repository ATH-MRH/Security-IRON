# Migrations SQLite — A2.1

## Périmètre

La version `001_baseline.js` représente le schéma existant au commit `d77c0d4` :
tables métier, colonnes `created_by`, tables Alert Core, index, triggers et règle
initiale. Le seul nouvel objet persistant d'infrastructure est `schema_migrations`.
Aucun tenant, site, rôle, permission, événement métier ou mapping ATLAS n'est ajouté.
Les tables historiques `parking_zones` et les champs texte de site restent inchangés.

## Propriétaire et démarrage

`backend/database.js` ouvre la connexion, active WAL et les clés étrangères puis,
dans `init()`, appelle `backend/db/migrate.js`. Ce runner est l'unique propriétaire
du schéma. La baseline contient ses propres définitions figées ; elle ne réimporte
pas les modules métier actuels pour construire le schéma.

Ordre : connexion → migrations → initialisation historique des comptes si la table
users est vide → contrôle `alerts.init()` → écoute HTTP → timer d'escalade.
Le mécanisme historique de comptes initiaux n'est pas modifié par A2.1.
`repository.init()` conserve son point d'entrée et vérifie que toutes
les migrations connues sont enregistrées avec leurs checksums attendus, puis
contrôle les objets physiques attendus avec le validateur unique de la baseline.
Il ne contient plus de DDL. Toute erreur refuse le démarrage avant écoute/timer.

Il n'existe pas de nouvelle commande npm ou de migration manuelle automatique
distincte : le démarrage habituel passe par `database.init()`.

## Avant une mise à niveau réelle

1. Arrêter toutes les instances qui accèdent à la base (serveur et postes Electron).
2. Identifier la base via `SECURISITE_DB_PATH` ou `SECURISITE_DATA_DIR`. Ne pas tester
   une mise à niveau sur une base de production depuis un poste de développement.
3. Vérifier les droits d'écriture et l'espace disponible pour la sauvegarde et les
   fichiers temporaires SQLite. Garder les sauvegardes hors du dépôt Git.
4. Démarrer une seule instance du programme validé.
5. Confirmer le succès de l'initialisation et la version dans `schema_migrations`.

L'exclusivité opérationnelle est requise pendant la mise à niveau. `BEGIN IMMEDIATE`
sérialise les écritures de migration et l'historique est relu sous verrou ; ce n'est
pas une orchestration de déploiement multi-instance. Le backup précède ce verrou.

## Runner et checksums

Les fichiers sont nommés `001_baseline.js`, `002_description.sql`, etc. Les versions
doivent être uniques, consécutives et commencer à 1. Un nom invalide, une version
inconnue ou un historique discontinu bloque le démarrage.

Chaque entrée du journal contient `version`, `name`, `applied_at` UTC et `checksum`.
Le checksum est le SHA-256 des octets exacts du fichier, fins de ligne comprises.
Les mêmes octets sont exécutés ; le cache des modules CommonJS n'est pas utilisé.
Une migration appliquée n'est jamais rejouée. Un checksum absent/NULL, différent,
ou un nom/version inconnu est refusé explicitement avant backup et migration.
Ne pas modifier le journal à la main pour contourner une erreur.

Les migrations appliquées sont immuables. Une évolution se fait dans un nouveau
fichier. Les migrations JS sont autonomes : pas d'import de code métier mutable,
pas de calcul dépendant d'un fichier externe non inclus dans le checksum.
Le checksum contrôle la cohérence des fichiers, pas leur authenticité ni l'intégrité
exhaustive des données à chaque démarrage.

## Format et transactions

- SQL : DDL/DML simple, exécuté synchroniquement par le runner.
- JS : export `up(db)` synchrone pour les contrôles et backfills nécessaires.
- Aucun réseau, timer, Promise ou travail différé dans les migrations.
- Le runner possède seul `BEGIN IMMEDIATE`, `COMMIT` et `ROLLBACK`. Les fichiers
  de migration ne doivent pas émettre de commandes transactionnelles, fermer la
  connexion ou modifier les PRAGMA de connexion. Ce sont des scripts de confiance
  livrés et relus avec l'application, pas un environnement de code non fiable.
  Une migration JS exécutant elle-même BEGIN/COMMIT/ROLLBACK est invalide : ce
  comportement n'est pas supporté. Le contrôle `isTransaction` ne détecte pas
  nécessairement une transaction fermée puis rouverte ; aucune sandbox n'est ajoutée.
- `foreign_keys` doit être activé avant la transaction ; il n'est jamais désactivé
  pour la baseline. Un contrôle de clés étrangères précède l'enregistrement final.

Chaque migration et sa ligne de journal sont dans la même transaction. Si la
migration échoue, ses DDL/DML et sa ligne sont annulés. Les versions précédemment
validées restent appliquées. La première migration crée aussi le journal dans sa
transaction : un échec initial ne laisse pas de baseline partielle.
L'erreur contextualisée conserve l'erreur initiale dans `cause`. Si le rollback
échoue aussi, son erreur apparaît dans le message et dans `rollbackError` sans
remplacer la cause initiale. Le démarrage reste refusé ; l'état de la connexion
ne doit alors pas être considéré récupéré automatiquement.

## Sauvegardes

Le runner détermine d'abord les migrations manquantes, sans créer le journal.
Une base vide (aucune table utilisateur) est considérée neuve : pas de backup.
Une base à jour ne déclenche ni checkpoint ni backup, même après redémarrage.
Une base existante avec au moins une migration à appliquer est sauvegardée une
fois avant la série. Une erreur de backup empêche toute écriture de migration.
Le chemin de sauvegarde est contrôlé avant toute écriture : le répertoire des
migrations et ses descendants sont interdits, y compris via un lien symbolique.
Les parents existants sont résolus même si le répertoire de backup n'existe pas
encore. Le chemin par défaut reste `backups/` à côté de la base lorsqu'il est sain.

Le backup réalise :

1. `PRAGMA wal_checkpoint(FULL)` hors transaction ; un checkpoint occupé/incomplet
   bloque la migration.
2. Création exclusive d'un sous-dossier horodaté avec UUID, sous `backups/` à côté
   de la base ; aucun chemin de sauvegarde existant n'est réutilisé.
3. `VACUUM main INTO ?` vers un nouveau fichier : snapshot SQLite cohérent, incluant
   les données WAL, sans copie naïve du seul fichier principal.
4. Ouverture en lecture seule, `quick_check`, fermeture et synchronisation du fichier.

Le dossier est créé avec mode 0700 et le fichier avec mode 0600 sur les plateformes
qui les prennent en charge. Exemple :
`backups/source.db-2026-09-09T10-20-30-000Z-<uuid>/source.db`.
Une sortie incomplète peut rester après échec pour diagnostic ; elle n'est jamais
retournée comme backup réussi. Ne pas l'utiliser comme sauvegarde validée.

`VACUUM INTO` produit une copie logique cohérente, pas une copie binaire identique.
Les identifiants métier sont conservés ; les ROWID implicites ne sont pas un contrat
de restauration. Voir [SQLite — VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)
et [SQLite — checkpoint WAL](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).

Il n'y a pas de suppression automatique, de rétention ni d'export hors machine des
sauvegardes en A2.1. Les opérateurs doivent prévoir espace et conservation.

## Adoption des bases historiques

- **Neuve** : création de tout le schéma actuel et version 1.
- **Pré-Alert-Core** : conservation des tables métier, ajout des `created_by`
  manquants, création des objets Alert Core et initialisation de la règle absente.
- **Post-Alert-Core** : adoption sans recréation des tables ni réécriture des lignes.
  Les règles personnalisées, audits, lectures, dates et rôles existants restent intacts.

La baseline valide les définitions des objets attendus après les créations manquantes.
Une définition incompatible ou une violation de clé étrangère provoque un rollback,
sans réparation silencieuse. La comparaison ignore les espaces et `IF NOT EXISTS` ;
elle reste volontairement stricte et peut refuser un DDL équivalent écrit autrement.
Les objets étrangers au périmètre baseline ne sont pas supprimés.
Le même validateur est utilisé après l'exécution d'une migration (avant commit),
au démarrage sans migration à appliquer et par `assertCurrent()` / `alerts.init()`.
Il contrôle les 18 tables métier/Alert Core, les 9 index explicites, les 4 triggers
et la présence/type de `schema_migrations`. Les noms réels des triggers de
configuration sont `alert_config_no_update` et `alert_config_no_delete`.
Les définitions existantes de la baseline sont réutilisées ; aucune seconde liste
indépendante d'objets métier n'est maintenue.

Une table, un index ou un trigger absent, ou un type d'objet incorrect, entraîne
une erreur nommant l'objet et refuse le démarrage. Sur une base déjà versionnée,
aucune recréation/réparation n'est exécutée. Le contrôle ne modifie pas les données,
n'ajoute aucune ligne de migration et ne déclenche pas de backup sur une base saine
à jour.

## En cas d'échec et restauration

Conserver le message complet, le fichier de migration et la sauvegarde éventuelle.
Une erreur SQL/JS ordinaire laisse la version précédente utilisable ; un défaut
de checksum exige de retrouver le code exact attendu, pas de recalculer le journal.

La restauration est une opération manuelle à autoriser séparément : arrêter tous
les processus, archiver ensemble la base actuelle et ses éventuels fichiers WAL/SHM,
vérifier la copie de sauvegarde, puis la restaurer à l'emplacement attendu avec une
version d'application compatible. Ne jamais associer la sauvegarde à un ancien WAL.
Tester cette procédure sur une copie avant toute intervention réelle. Aucun outil
de restauration automatique ou downgrade n'est inclus dans A2.1.

## Validation locale

Utiliser le runtime déjà validé, Node 22.22.2 (support `node:sqlite`).

```sh
node --test tests/migrations.test.js
npm test
```

Les tests de migration utilisent des bases mémoire ou des répertoires temporaires
supprimés en fin de test. Les fixtures historiques sont figées indépendamment de
la migration. Les tests de backup utilisent de vraies bases WAL et vérifient leurs
copies. Les tests mémoire peuvent injecter un backup de test ; aucune option
d'environnement de désactivation du backup n'est ajoutée à l'application.

Aucun test ne doit viser la base applicative existante ni la production.
