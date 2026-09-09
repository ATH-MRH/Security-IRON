# PG-1 — Infrastructure PostgreSQL minimale

## Périmètre

PostgreSQL est la cible de SécuriSite 2.0. Ce lot remplace seulement la couche
`backend/database.js` et ajoute le driver `pg`, sa configuration et ses tests.
Aucun schéma métier, migration PostgreSQL, import SQLite, ORM ou compte initial.
Les migrations et scripts SQLite existants restent des éléments legacy non portés.
Ne pas lancer `init-db` pour préparer PostgreSQL.

Le commit historique `15d0198a70859e7b26bb1e5157b0887ef5697b17` a été consulté
par `git show` : principes Pool/query/get/all/DATABASE_URL repris, sans restaurer
les credentials de secours, TLS non vérifié, DDL ou comptes démo automatiques.

## Configuration

Le module lit l'environnement à sa première utilisation ; son import ne connecte
pas la base. Il ne charge pas de fichier `.env`. Le serveur possède déjà son
chargeur `.env` ; le harness de test attend des variables exportées.

Utiliser une `DATABASE_URL` PostgreSQL complète fournie par le gestionnaire de
secrets, ou explicitement `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` et
`PGPORT` (5432 par défaut). Aucun hôte, utilisateur ou nom de base implicite.
Un mot de passe non vide est requis hors `NODE_ENV=test` ou `development`.
Dans ces modes locaux explicites, un mot de passe vide ne déclenche pas de
recherche automatique dans pgpass. Ne jamais journaliser la configuration.

Les paramètres de requête et fragments de DATABASE_URL sont refusés : TLS et
options de connexion se configurent séparément, sans surcharge par l'URL.

| Variable | Défaut | Contrat |
| --- | --- | --- |
| PGSSL | verify-full | TLS avec validation du certificat et du nom ; disable uniquement explicite |
| PGSSLROOTCERT | absent | Fichier PEM d'autorité de confiance optionnel ; nécessite verify-full |
| PGPOOL_MAX | 10 | Connexions maximum, entier 1 à 1000 |
| PGCONNECT_TIMEOUT_MS | 5000 | Acquisition/connexion bornée |
| PGIDLE_TIMEOUT_MS | 30000 | Expiration des connexions inactives du pool |
| PGSTATEMENT_TIMEOUT_MS | 15000 | Limite serveur par instruction SQL |
| PGTRANSACTION_IDLE_TIMEOUT_MS | 60000 | Limite serveur d'inactivité dans une transaction |

Les durées sont des entiers strictement positifs, au plus 2147483647 ms.
Aucun mode TLS `rejectUnauthorized:false`. Aucune désactivation automatique de
TLS, même en développement. Le harness local choisit explicitement `disable`.
Pas de timeout JavaScript global du callback transactionnel : toutes ses promesses
doivent être attendues. Les limites serveur ne remplacent pas une deadline métier.

## API et Pool

- `query(sql, params)` : Promise du résultat brut `pg` (rows, rowCount, command, fields).
- `get(sql, params)` : Promise de la première ligne ou null.
- `all(sql, params)` : Promise du tableau rows, éventuellement vide.
- Paramètres positionnels PostgreSQL `$1`, `$2`, etc. ; aucun remplacement de `?`.
- `init()` : uniquement `SELECT 1 AS ok`. Aucune table ni donnée créée.
- `close()` : fermeture idempotente du pool, attend les connexions en cours ;
  ne pas l'appeler dans une transaction. Les appels ultérieurs sont refusés.
- `createDatabase(env)` : instance isolée pour les tests/outils, avec `stats()`
  (total, idle, waiting). Aucun accès public au pool brut.

Un singleton paresseux sert les exports usuels. Les erreurs de connexions inactives
ont un message générique sans URL ni SQL. Les erreurs SQL sont propagées intactes
pour permettre le traitement de leur code ; ne pas exposer leurs détails aux API
ou journaux sans filtrage. `init()` fournit un message contrôlé et conserve cause.

## Transactions

`await db.transaction(async client => { ... })` acquiert une connexion, exécute
BEGIN, attend le callback puis COMMIT. `client.query/get/all` utilisent exactement
cette connexion. La valeur du callback est rendue après le commit.

Sur erreur : ROLLBACK, propagation de l'erreur initiale, release en finally.
Si le rollback échoue, la connexion est détruite ; l'erreur initiale est conservée,
avec rollbackError non énumérable ; si l’objet ne peut recevoir cette propriété,
un wrapper conserve l’erreur originale dans cause. Un échec BEGIN détruit
également la connexion. Un COMMIT répondu ROLLBACK après erreur SQL absorbée
par le callback ne peut pas être annoncé comme succès.

AsyncLocalStorage interdit les appels au pool, les transactions imbriquées et la
fermeture dans le contexte transactionnel, y compris via une autre instance DB.
Le client est refusé après la fin du callback. Utiliser exclusivement le client
fourni et attendre toutes ses opérations ; ne pas lancer de tâche détachée, ni
émettre manuellement BEGIN/COMMIT/ROLLBACK. Les futurs services composables devront
recevoir ce client explicitement. Des savepoints nommés pourront être ajoutés
plus tard via un contrat dédié, sans ouvrir une transaction indépendante implicite.

## Tests isolés

Installer les dépendances avec `npm install --ignore-scripts --no-audit --no-fund`
si nécessaire. Les scripts de téléchargement Electron/ffmpeg ne sont pas requis
pour tester cette couche.

Préparer un serveur PostgreSQL local jetable (version validée : 16.13) et une base
vide dédiée nommée `securisite_test` ou `securisite_test_<suffixe>`. Fournir son URL
via `SECURISITE_TEST_DATABASE_URL`, sans l'afficher ni la committer, puis lancer :

```sh
npm run test:pg
```

Le harness refuse l'absence de cette variable, toute cible distante, tout nom
ambigu/production et les options d'URL. Aucun repli sur DATABASE_URL.
Seuls localhost, 127.0.0.1 et ::1 sont admis. Le nom ne suffit pas à prouver
l'absence de données sensibles : utiliser réellement une instance jetable.
`SECURISITE_TEST_PGSSL` vaut explicitement disable pour ce harness local ; pour
un serveur TLS, choisir verify-full et éventuellement SECURISITE_TEST_PGSSLROOTCERT.
Les tests ne créent que des tables TEMP, jamais de schéma métier permanent.

Validation PG-1 corrigé : 47 tests, dont 21 exécutés sur PostgreSQL 16.13 réel et 26 tests
configuration/garde-fous/injection de fautes. L'injection vérifie notamment les
échecs BEGIN, COMMIT, acquisition et rollback ; elle complète les tests réels.
Cluster de validation créé sur un port loopback distinct, avec secret aléatoire,
authentification SCRAM, puis arrêté et supprimé. Zéro table publique persistante.
Le contrôle syntaxique couvre les cinq fichiers JavaScript PG-1.

## Compatibilité restante et démarrage

Le serveur reste inchangé : `server.js` attend `db.init()` avant `alerts.init()`
puis listen. Avec PG-1, même une connexion PostgreSQL valide ne rend PAS encore
l'application exploitable : le repository appelle `db.assertSchemaReady()`, absent
du nouveau contrat. Le démarrage reste bloqué avant listen et avant le timer.
Le libellé fatal historique mentionne encore SQLite ; il sera ajusté au portage.

| Fichier | Travail restant |
| --- | --- |
| backend/alert-core/repository.js | db.raw, prepare/run synchrones, savepoints et dialecte SQLite ; init/assertSchemaReady |
| backend/alert-core/service.js | Enchaînements synchrones dépendant du repository et de ses résultats immédiats |
| backend/alerts.js | Appels synchrones au service, réponses HTTP et erreurs à adapter avec await |
| backend/routes.js | db.run, placeholders ?, transactions synchrones, résultat immédiat |
| backend/auth.js, backend/sync.js, backend/seed.js | Audit/portage des appels DB et du dialecte avant utilisation PostgreSQL |
| server.js | Attendre la future initialisation métier async et adapter le timer d'escalade |
| tests/alerts.test.js | db.raw.close/prepare, démarrage et fixtures SQLite incompatibles |
| tests/migrations.test.js | Migrations SQLite autonomes conservées ; test de démarrage couplé à l'ancien database.js incompatible |

Résultats historiques : notifications 34/34 ; migrations 69/70, échec du test
« startup: failed migration prevents listen, escalation timer and user seeding »
qui attend le diagnostic SQLite et db.raw. Les tests historiques ne sont ni
supprimés ni modifiés. `npm test` conserve sa commande existante et ne constitue
pas une suite verte PG-1 : elle inclut ces tests legacy et exige désormais aussi
la cible PostgreSQL explicite pour la suite réelle. Utiliser la suite dédiée pour
valider PG-1 ; ne pas présenter ce lot comme une application complète portable.

## Lots suivants

PG-2 : cadrer et introduire le mécanisme de migrations PostgreSQL versionnées,
sans exécuter les migrations SQLite contre PostgreSQL. PG-3 : schéma métier puis
portage async des repositories/services/routes et tests d'intégration, par petits
lots. Aucun tenant/site/zone/membership, Alert Core, RLS, SSE, mobile, push, GPS,
IA ou import de données ajouté dans PG-1. Aucun changement de production.

## Corrections après review PG-1

Le client emprunté reçoit immédiatement un listener `error`, distinct du handler
du pool. Le premier événement est mémorisé dans `clientError` et marque la
connexion à détruire. Le listener reste installé pendant BEGIN, le callback,
COMMIT et ROLLBACK. Il est retiré immédiatement avant release, sans await entre
les deux ; pg-pool réinstalle alors son propre listener et retire le client
si release reçoit true (implémentation installée pg 8.23.0).

Un événement pendant une attente JavaScript n'interrompt pas arbitrairement le
callback : ses promesses restent attendues. Toute nouvelle requête du client est
refusée après l'événement. Les vérifications après BEGIN, avant et après COMMIT
interdisent d'annoncer un succès lorsque l'erreur est déjà connue. Une perte de
connexion pendant COMMIT entraîne un rejet ; elle ne permet pas d'affirmer que
PostgreSQL n'a pas validé la transaction. Aucun retry automatique.

L'erreur rejetée par le callback ou l'opération SQL est primaire. Sans rejet,
l'événement client mémorisé devient primaire. Les erreurs distinctes de client
et rollback sont conservées dans `clientError` et `rollbackError`, non énumérables.
Une erreur primaire modifiable conserve son identité ; si elle est figée, primitive
ou possède une propriété non configurable, un wrapper garde l'original dans
`cause` et conserve son code éventuel. Les erreurs secondaires ne remplacent
jamais silencieusement l'original. Une erreur survenue pendant le rollback est
également capturée avant la libération.

Le singleton mémorise sa fermeture même avant création du pool. Tous les appels
init/query/get/all/transaction ultérieurs rejettent ; close reste idempotent.
createDatabase conserve le même contrat, avec un pool construit explicitement
mais sans connexion ouverte avant utilisation. Les tests en processus séparés
vérifient notamment qu'une fermeture précoce du singleton ne crée aucun pool.

Tests ajoutés : sept scénarios d'événement client (requête, attente JS, avant
COMMIT, pendant COMMIT, ROLLBACK, échec ROLLBACK et erreur callback), six scénarios
de fermeture singleton/factory, et deux expirations réelles pendant une attente
JS, avec ou sans erreur callback. PostgreSQL 16.13 / SCRAM-SHA-256, base jetable
securisite_test_fix : rejet contrôlé 25P03, client retiré, PID différent pour la
transaction suivante. Avant correction, la même expiration terminait Node avec
Unhandled error event (code de sortie 1), reproduit pendant la review.

Après correction : notifications 34/34, migrations 69/70. npm test : 150 succès,
12 échecs sur 162 résultats TAP. Les échecs restent les dix tests Alert Core
bloqués par assertSchemaReady, leur hook final db.raw.close, et le test de
démarrage SQLite des migrations. Aucun test historique modifié.
