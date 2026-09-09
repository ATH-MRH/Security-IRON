# PG-3.1 — Repository Alert Core PostgreSQL async

## Périmètre et état d'intégration

Ce lot porte uniquement `backend/alert-core/repository.js`, avec son test dédié. Il conserve ses 25 exports et les prédicats, paramètres, tris et limites métier historiques. Les migrations 001/002 et PG-1 restent inchangés. Aucun changement de lifecycle, destinataires, permissions, visibilité, règles incidents/badges ou escalades ; aucun multitenant, RLS, SSE, push, GPS ou IA.

**L'application complète n'est pas encore fonctionnelle.** Le service et les routes restent synchrones ; ils devront attendre chaque résultat et transmettre le client transactionnel. Le serveur n'attend pas encore `alerts.init()` : une erreur de readiness peut devenir un rejet non géré après le début de l'écoute. Ce lot n'autorise donc pas une mise en service et ne garantit pas la readiness du serveur. Ces intégrations restent hors PG-3.1.

## Client et contrats de retour

Chaque fonction SQL accepte `client = db` en dernier argument. Le client expose les méthodes PG-1 `query`, `get`, `all`. Toutes les requêtes passent exclusivement par lui, sans repli sur le pool. En transaction, l'appelant doit transmettre le client reçu du callback PG-1 à chaque opération. PG-1 refuse les appels pool dans ce contexte et l'utilisation du client après expiration.

Les tables sont qualifiées `public`, les paramètres sont liés avec `$1`, `$2`, etc., dans leur ordre historique. Aucun parseur global `pg` n'est modifié : TEXT/string, INTEGER/number, DOUBLE PRECISION/number, NULL/null.

| Exports | Retour attendu après await |
| --- | --- |
| `init` | `undefined`, ou erreur explicite |
| `findAlert`, `findUser`, `findNotification`, `recentBadgeAlert` | ligne ou `null` |
| `notificationRecipients`, `pendingEscalations`, `configAudit`, `notifications`, `allAlerts`, `alertsByCreator`, `timeline` | tableau |
| `readConfig` | TEXT brut |
| `insertAlert`, `updateEscalation`, `updateConfig`, `markNotificationRead`, `requestCancellation`, `updateState`, `touchAlert` | `{ rowCount }` |
| `appendAudit`, `appendConfigAudit` | `{ rowCount, id }`, via `RETURNING id` |
| `badgeRefusalCount` | entier JavaScript sûr et positif ou nul |
| `atomic` | résultat du callback, après validation transactionnelle |
| `prepareNotificationInsert` | fabrique synchrone sans I/O ; retourne une fonction async renvoyant `{ rowCount, id }` |

La fabrique capture son client et conserve les arguments `(alertId, userId, stamp, message)`. Aucun `RunResult` SQLite n'est émulé.

## Transactions et savepoints

`atomic(asyncCallback, transactionClient = null)` utilise `db.transaction` sans parent : PG-1 gère BEGIN, attente du callback, COMMIT, ROLLBACK et libération. Avec un parent, ce même client exécute SAVEPOINT, attend réellement le callback, puis RELEASE SAVEPOINT. Il ne committe jamais la transaction parente.

Sur erreur, ROLLBACK TO SAVEPOINT puis RELEASE SAVEPOINT sont tentés, avant propagation de l'erreur primaire. Les erreurs de nettoyage sont attachées comme `rollbackError` et `releaseError`. Si l'erreur primaire est gelée ou non extensible, elle est conservée dans `cause` d'une enveloppe ; son code éventuel est conservé. Une erreur de création du savepoint est propagée immédiatement sans tenter un nettoyage d'un savepoint inexistant.

Les noms internes `alert_` suivis des 32 chiffres hexadécimaux d'un UUID ne proviennent jamais d'une entrée HTTP. Aucune interpolation métier. Les savepoints peuvent être imbriqués ; les opérations sœurs partageant un même client parent doivent être séquencées, et non lancées par `Promise.all`. Les transactions indépendantes peuvent s'exécuter simultanément. Aucun ordonnanceur de savepoints concurrents n'est ajouté.

L'appelant doit laisser remonter une erreur de nettoyage pour annuler la transaction parente, sans poursuivre et committer un état dont le rollback n'est plus garanti. Aucun retry implicite, notamment après une réponse COMMIT incertaine. Le client parent doit provenir de PG-1, pas d'un pool libre.

## Readiness et configuration

`init(client)` ne fait que lire les catalogues et la configuration. Il vérifie les cinq tables `security_alerts`, `alert_audit`, `alert_notifications`, `alert_config_audit`, `alert_rules` dans `public`, puis la ligne `alert_rules.id=1`.

Une table absente donne `ALERT_SCHEMA_UNAVAILABLE`. Une configuration absente donne `ALERT_CONFIG_MISSING`, également pour `readConfig`. Aucun CREATE, ALTER, seed, migration, réparation ou fallback. Ce contrôle minimal ne remplace pas le validateur de schéma PG-2. Le JSON de configuration reste du TEXT brut ; sa validation métier demeure au service.

## Sémantique SQL conservée

- `insertAlert` conserve ses 16 colonnes et arguments explicites, sans nouveau défaut métier.
- Destinataires : `role='admin' OR id=$1`, sans membership ni scope ajouté ; un créateur admin n'est pas dupliqué.
- Escalades : `level>=3 AND acknowledged_at IS NULL AND status='NOTIFIEE'`, sans tri ni verrou ajouté.
- Notifications : utilisateur, `id DESC`, limite 200 ; recherche par notification et utilisateur. La lecture met `read_at` à jour par ID, même si déjà renseigné.
- Alertes : `level DESC, created_at DESC`, avec uniquement le filtre créateur pour `alertsByCreator`.
- Audit configuration : `id DESC` ; timeline : ID d'alerte puis `id ASC`.
- Audit : INSERT uniquement, sans UPDATE/DELETE/upsert ; les triggers PG-2.3 restent l'autorité de défense.
- Annulation : INTEGER `cancellation_requested=1`. `updateState` conserve les six paramètres et les COALESCE de propriétaire, acquittement et résolution.
- Refus badges : badge exact, résultat `refus`, date inclusive. Alerte badge récente : équipement, date inclusive, origine `REGLE_BADGE`, sans filtre site/statut/tenant ni tri ajouté.

`COUNT(*)` arrive comme chaîne bigint avec `pg`. Le repository vérifie une chaîne décimale non négative et une borne `Number.MAX_SAFE_INTEGER` via BigInt avant conversion en Number. Sinon : `ALERT_COUNT_RANGE`. Aucun cast SQL en INTEGER ni parseur global.

Les primitives de verrouillage sont différées à PG-3.2 : elles ne sont pas nécessaires pour tester ce portage isolé. La résolution des courses métier reste à intégrer dans le service ; les lectures ordinaires ne prennent pas de verrou ajouté ici.

## Validation exécutée

PostgreSQL **16.13** local jetable, authentification SCRAM, bases dédiées préfixées `securisite_test_`. Les fixtures appliquent les migrations existantes 001 et 002, ferment leurs connexions et suppriment leurs bases. Aucun accès production. Le test de réouverture ferme/recrée le pool ; il ne simule pas un crash du processus PostgreSQL.

Configurer `SECURISITE_TEST_DATABASE_URL` et `SECURISITE_TEST_PGSSL` pour une instance exclusivement jetable, avec un rôle pouvant créer/supprimer les bases de test. Pour le test global, `DATABASE_URL` doit également cibler une base jetable et `NODE_ENV=test` ; ne jamais utiliser une URL de production. Le helper de test existant valide la configuration de test.

| Commande | Résultat |
| --- | --- |
| `node --test tests/postgres-alert-core-repository.test.js` | 61/61 |
| `node --test tests/postgres-alert-core-schema.test.js` | 54/54 |
| `node --test tests/postgres-core-legacy.test.js` | 35/35 |
| `node --test tests/postgres-migrations.test.js` | 68/68 |
| `npm run test:pg` | 47/47 |
| `npm test` | 380 tests, 368 réussites, 12 échecs, aucun ignoré |

Les tests repository vérifient les retours et données réellement persistées, tris, limites, filtres, types, transactions et PID commun. Ils couvrent callback différé, transactions indépendantes, savepoints imbriqués, rollback mutation/audit/config/notification et refus d'évasion vers le pool. Les grandes valeurs COUNT impossibles à constituer raisonnablement sont injectées par un client contrôlé. Les erreurs de nettoyage sont injectées sur un client enveloppant une vraie transaction PostgreSQL ; l'annulation finale est vérifiée en base.

Les 12 échecs globaux restent dans les mêmes emplacements historiques : 10 tests Alert Core, leur hook de fermeture SQLite, et le test SQLite de démarrage après migration invalide. Leurs messages ont évolué : absence de tables/comptes dans la fixture historique, réponses 401, Promise traitée comme liste (`pending is not iterable`), fermeture via `db.raw`, démarrage non bloqué par l'ancien mécanisme SQLite. Les rejets non gérés de readiness et d'escalade reflètent les appels async non attendus du serveur/service. Aucun nouvel emplacement en échec hors ces incompatibilités de portage ; ce résultat n'est pas une validation fonctionnelle de l'application.
