# PG-3.1 — Repository Alert Core PostgreSQL async

## Périmètre et état d'intégration

Ce lot porte uniquement `backend/alert-core/repository.js`, avec son test dédié. Il conserve ses 25 exports et les prédicats, paramètres, tris et limites métier historiques. Les migrations 001/002 et PG-1 restent inchangés. Aucun changement de lifecycle, destinataires, permissions, visibilité, règles incidents/badges ou escalades ; aucun multitenant, RLS, SSE, push, GPS ou IA.

**État à la fin de PG-3.1 : application complète non fonctionnelle.** Le service et les routes étaient encore synchrones. Le portage du service réalisé dans PG-3.2A est décrit ci-dessous ; les routes et le serveur restent à porter. Le serveur n'attend pas encore `alerts.init()` : une erreur de readiness peut devenir un rejet non géré après le début de l'écoute. Ce lot n'autorise donc pas une mise en service et ne garantit pas la readiness du serveur. Ces intégrations restent hors PG-3.1.

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

## PG-3.2A — Orchestration async du service, parité uniquement

`backend/alert-core/service.js` attend désormais les opérations du repository PG-3.1. Les exports sont conservés ; les helpers internes ne sont pas ajoutés à l'API publique. Le repository, PG-1, les migrations, les routes, le serveur et le frontend restent inchangés.

### Clients et transactions

Les helpers `audit`, `config`, `notify`, `get`, `list`, `detail` reçoivent un dernier argument `client = db`. Les opérations `create`, `escalateDue`, `updateRules`, `readNotification`, `act`, `fromIncident`, `fromBadge` acceptent un dernier argument `transactionClient = null`. Les aliases `init`, `currentUser`, `configAudit`, `notifications` exposent directement les fonctions async du repository et leur client optionnel.

Sans parent, `atomic` ouvre la transaction PG-1. Avec parent explicite, il utilise un savepoint PG-3.1 sur ce client. Toutes les lectures et écritures internes, y compris les helpers indirects, reçoivent ce même client. Aucune détection implicite du contexte transactionnel et aucun retour au pool. Un appel avec parent se résout après RELEASE, mais la durabilité attend encore le COMMIT parent.

`fromIncident` et `fromBadge` lisent avec le parent s'il existe et attendent `create(..., origin, parent)`. Ils conservent un retour `undefined`. Sans parent, leurs lectures préalables restent hors de la transaction de création : aucun élargissement transactionnel ni antidoublon concurrent n'est ajouté dans A.

### Ordre historique conservé

- Création : validations et génération avant transaction ; configuration lors de la préparation de l'INSERT ; INSERT, audit CREATION, relecture/visibilité, destinataires, notifications puis audit NOTIFICATION_INTERNE. Aucun retour avant ces effets.
- Notification : destinataires admin OU créateur, fabrique capturant le client, `for...of` avec chaque insertion attendue, puis audit du nombre exact. Zéro destinataire reste possible et audité.
- Escalade : candidats chargés une fois, une transaction attendue par alerte, paliers séquentiels à partir des valeurs du candidat. Politique copiée dans l'alerte, mêmes bornes, timestamps et messages.
- Règles : validation, lecture/parsing, audit previous/current re-sérialisés, mise à jour, puis retour de l'objet nettoyé.
- Lecture notification : même recherche id/utilisateur, même test `!read_at` incluant la chaîne vide, mutation puis audit. Une seconde lecture séquentielle ne réécrit rien.
- Actions : visibilité, état terminal, branche, permission, transition, mutation/audit/notification, touch et relecture. Les COALESCE restent dans le repository inchangé.
- Incident : mêmes gravités `critique`/`majeur`, drapeau configuration, niveau 3, origine INCIDENT, champs et valeurs de repli. Le nettoyage historique trimme le commentaire final.
- Badge : même garde, configuration, fenêtre inclusive, comptage, recherche récente seulement au seuil, puis création. Aucun filtre site/statut ajouté.

Les instants `now()` restent aux emplacements historiques, notamment le timestamp d'audit des règles évalué avant sa lecture de configuration. Les boucles de destinataires, candidats et paliers sont séquentielles. Aucun savepoint frère parallèle, aucun `Promise.all` sur un client partagé.

### Retours et erreurs

Après `await`, les structures historiques sont conservées : alerte pour `create`/`act`, alerte et timeline résolue pour `detail`, tableaux pour `list`/notifications/audit configuration, configuration pour `config`/`updateRules`, utilisateur ou null pour `currentUser`, `{ok:true}` pour `readNotification`. `init`, producteurs, escalade et helpers audit/notification se résolvent avec `undefined`. Aucun résultat contient une Promise imbriquée.

Les erreurs métier conservent `.status` et `.message`, ainsi que l'ordre de validation. Aucun catch ne les transforme en 500. Les erreurs SQL, de configuration et de parsing JSON restent techniques et sont propagées. Une erreur d'audit ou de notification annule la mutation dans la même transaction ; les règles de propagation des erreurs de nettoyage PG-3.1 restent applicables.

### Limites volontaires

PG-3.2A valide la parité séquentielle, pas la concurrence. Aucun verrou de ligne, UPDATE conditionnel, advisory lock métier, idempotence, nouvelle contrainte, scope ou changement de lifecycle. Les candidats d'escalade peuvent rester obsolètes ; deux décisions concurrentes peuvent encore produire doublons d'audit/notification ou mises à jour incohérentes. Les corrections appartiennent à PG-3.2B.

**L'application complète reste non fonctionnelle avant le portage d'intégration PG-3.3.** Les handlers, middleware utilisateur et timer n'attendent pas encore correctement le service ; l'initialisation serveur reste non attendue. PG-3.2A ne constitue pas une autorisation de déploiement. PG-3.2B reste également requis pour les garanties concurrentes.

### Tests du service

`tests/postgres-alert-core-service.test.js` utilise PostgreSQL 16 jetable et les migrations 001/002, avec des utilisateurs explicitement insérés. Les fixtures sont isolées et supprimées. Les tests passent par les fonctions publiques du service ; les helpers internes sont exercés via création, actions et producteurs.

Les erreurs d'audit/notification sont provoquées par des violations NOT NULL réelles, en adaptant un paramètre sur un client enveloppé. Les tests différés bloquent une vraie opération via une Promise contrôlée pour vérifier l'absence de retour/RELEASE anticipé. Ils instrumentent le client/PID et la séquence, sans prétendre valider les courses multiprocessus reportées à B. Un contrôle statique complémentaire vérifie l'absence de SQL et de parallélisation ajoutés dans le service ; il ne remplace pas les tests comportementaux.

Commandes : `node --test tests/postgres-alert-core-service.test.js`, puis les suites PG-3.1, PG-2.3, PG-2.2, PG-2.1, `npm run test:pg` et `npm test`, avec les variables de test exclusivement locales décrites plus haut.

Résultats PG-3.2A sur PostgreSQL **16.13**, authentification SCRAM, base racine locale `securisite_test_pg32a` et fixtures isolées :

| Suite | Résultat |
| --- | --- |
| PG-3.2A service | 70/70 |
| PG-3.1 repository | 61/61 |
| PG-2.3 | 54/54 |
| PG-2.2 | 35/35 |
| PG-2.1 | 68/68 |
| PG-1 | 47/47 |
| `npm test` | 450 tests, 438 réussites, 12 échecs, aucun ignoré |

Les 12 emplacements d'échec globaux sont identiques à PG-3.1 : dix tests de `tests/alerts.test.js`, son hook de fermeture, et `startup: failed migration prevents listen, escalation timer and user seeding` dans les tests SQLite. Le message du cas escalade devient `undefined !== 3`, les appelants HTTP/tests historiques n'attendant toujours pas le service. Les réponses 401, accès `.body.find` et fermeture `db.raw` restent des incompatibilités d'intégration. Aucun nouvel emplacement d'échec. Aucun test antérieur modifié.

Les deux JS du lot passent `node --check` ; `git diff --check` est conforme. Les bases des fixtures ont été supprimées, puis le cluster local arrêté et ses données supprimées. Aucune utilisation de production, aucun commit ni push.
