# SécuriSite — sauvegarde / restauration PostgreSQL (PG-27)

Runbook + outils testés (MASTER ROADMAP §31). Aucune opération de
production : ce lot ne touche que des bases de test/développement
jetables ; l'usage sur une base réelle reste une décision humaine, hors
périmètre de ce lot.

## Outils

`pg_dump`/`pg_restore` — déjà installés avec toute distribution
PostgreSQL, aucune nouvelle dépendance, aucun service externe.

- `backend/db/postgresql/backup.js` (`backup({databaseUrl, outFile})`) —
  `pg_dump -Fc` (format custom, compressé, seul format compatible avec les
  garanties de `pg_restore` testées ici). Lecture seule par construction :
  aucune restriction de cible, sauvegarder une base réelle est sans risque
  en soi.
- `backend/db/postgresql/restore.js` (`restore({databaseUrl, targetName,
  inFile})`) — `pg_restore --clean --if-exists --no-owner`. **Destructif** :
  réutilise **exactement** la même garde que
  `backend/db/postgresql/import-sqlite.js#assertTargetAllowed` (PG-5) —
  jamais une cible dont le nom ne contient pas « test » sans confirmation
  explicite (`SECURISITE_IMPORT_CONFIRM=<nom de la base>` après validation
  humaine), une cible « prod »/« production » toujours refusée.
- CLI directes : `node backend/db/postgresql/backup-cli.js <fichier.dump>`,
  `node backend/db/postgresql/restore-cli.js <fichier.dump>` (utilisent
  `DATABASE_URL` de l'environnement, même convention que
  `migrate-cli.js`/`create-admin.js`).

## Runbook — restauration après perte d'une base de test/développement

1. **Sauvegarder** : `node backend/db/postgresql/backup-cli.js backup.dump`
   (ou `backup({databaseUrl, outFile})` par programme).
2. **Recréer une cible propre** : `CREATE DATABASE <nom>` (une base neuve,
   sans migration préalable — `pg_restore` restaure le schéma complet,
   `securisite_meta` compris).
3. **Restaurer** : `node backend/db/postgresql/restore-cli.js backup.dump`
   avec `DATABASE_URL` pointé sur la cible — refusé si le nom ne contient
   pas « test » et que `SECURISITE_IMPORT_CONFIRM` ne correspond pas
   exactement.
4. **Attester la readiness** : `backend/db/postgresql/readiness.js#assertReady`
   (déjà le contrôle utilisé par `server.js` au démarrage, PG-3) — schéma,
   migrations (versions + empreintes), tables, triggers append-only, RLS,
   privilèges runtime.
5. **Vérifier les comptes/relations/audits** : `SELECT` de contrôle sur
   `users`/`memberships`/`security_alerts`/`alert_audit`/`security_audit`
   — comparaison avec un inventaire pris avant sinistre si disponible.

Ce runbook est **prouvé de bout en bout**, pas seulement décrit : voir
`tests/postgres-backup-restore.test.js`.

## Ce qui est prouvé par test (PostgreSQL réel)

- `backup()` refuse sans `databaseUrl`/`outFile` ; `restore()` refuse une
  cible qui n'est ni « test » ni explicitement confirmée, ou marquée
  « prod »/« production » — jamais une restauration silencieuse au
  mauvais endroit.
- **Scénario complet** : peuplement réaliste (comptes admin/agent,
  memberships, une alerte avec sa chronologie `alert_audit`, un événement
  `security_audit`) → `pg_dump` → **destruction réelle** de la base de
  test (`DROP DATABASE` puis `CREATE DATABASE` vide) → `pg_restore` →
  - `assertReady()` réussit exactement comme sur une base fraîchement
    migrée (schéma, migrations, triggers, RLS, privilèges) ;
  - le registre `securisite_meta.schema_migrations` (versions + empreintes
    SHA-256) est restauré à l'identique ;
  - comptes, memberships, alerte, chronologie `alert_audit` et événement
    `security_audit` sont restaurés **exactement** (comparaison ligne à
    ligne, pas seulement un décompte) ;
  - les triggers append-only (PG-9/PG-10) protègent toujours
    `security_audit` **après** la restauration — une restauration ne
    réintroduit jamais de faille sur un journal immuable.

## RPO / RTO — délibérément non promis

Aucun chiffre de RPO (perte de données maximale tolérée) ni de RTO (durée
de restauration) n'est avancé ici : ce lot mesure un aller-retour complet
sur un jeu de données minuscule (quelques lignes), sur une seule machine
de développement partagée — un chiffre extrapolé à un volume ou un
environnement réel serait inventé, pas mesuré (§30/§31 : « ne pas inventer
de chiffre »). Pour un RPO/RTO réel, mesurer `backup()`/`restore()` sur
une copie du volume et de l'infrastructure réels visés — cet outil s'y
prête tel quel (mêmes fonctions, mêmes garanties testées), seule
l'extrapolation vers un chiffre non mesuré est refusée ici.

## Portée non couverte ici

Sauvegarde/restauration automatisée planifiée (cron, rétention, stockage
distant chiffré), bascule vers une réplique, PITR (`pg_basebackup` +
archivage WAL continu) restent hors périmètre de ce lot — non entrepris
faute de nécessité démontrée pour cette étape.
