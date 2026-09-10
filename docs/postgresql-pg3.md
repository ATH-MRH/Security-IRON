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

## PG-3.2B — Sérialisation des décisions concurrentes

Cette étape ajoute uniquement les protections de concurrence au repository et au service. Les contrats des étapes précédentes restent inchangés hors sérialisation des décisions. Les limites de concurrence décrites dans la section PG-3.2A correspondent à cette étape antérieure ; les protections ci-dessous s'appliquent désormais. Les routes, serveur, frontend, migrations, dépendances et PG-1 ne sont pas modifiés.

### Primitives et transaction effective

Quatre nouveaux exports exigent un client transactionnel explicite, sans fallback au pool :

| Primitive | Acquisition / retour |
| --- | --- |
| `findAlertForUpdate(id, client)` | `SELECT * FROM public.security_alerts WHERE id=$1 FOR UPDATE` ; ligne ou null |
| `findNotificationForUpdate(id, userId, client)` | id et utilisateur, `FOR UPDATE` ; ligne ou null |
| `readConfigForUpdate(client)` | singleton id=1, `FOR UPDATE` ; TEXT ou erreur `ALERT_CONFIG_MISSING` |
| `lockBadge(badge, client)` | advisory transaction lock ; résolution sans valeur |

Les primitives ordinaires PG-3.1 restent inchangées. Le repository ne décide pas des transitions.

Avant chaque acquisition, le support compare deux observations successives du PID et de `pg_current_xact_id()` sur l'exécuteur fourni. Elles doivent correspondre à la même transaction. Cela refuse un exécuteur en autocommit avant toute requête de verrouillage, sans modifier PG-1 ni se contenter de tester la forme d'un objet pool. Ce contrôle alloue un identifiant transactionnel PostgreSQL ; ces primitives sont destinées aux transactions d'écriture, pas aux transactions READ ONLY. Le client doit rester exclusivement utilisé par l'appelant et exposer `query/get/all`.

L'isolation effective, lue via `current_setting('transaction_isolation')`, doit être exactement `read committed`. Sinon : `ALERT_ISOLATION_REQUIRED`, sans modification silencieuse de l'isolation. Client absent/incompatible ou observations transactionnelles différentes : `ALERT_TRANSACTION_REQUIRED`. Les protections PG-1 restent actives : pool interdit dans son callback, client inutilisable après expiration.

### Attente bornée et erreurs techniques

`SECURISITE_ALERT_LOCK_TIMEOUT_MS` : entier décimal de **1 à 60000 ms**, défaut **2000 ms**. Valeur invalide : `ALERT_LOCK_CONFIG_INVALID`, sans fallback silencieux.

Avant l'acquisition, lecture de `pg_settings.lock_timeout` en millisecondes. Le timeout retenu est le minimum entre la configuration Alert Core et un timeout parent non nul. Application par `set_config('lock_timeout', valeur liée, true)`, locale à la transaction. Après succès, restauration de la valeur précédente. Sur erreur SQL, aucun nettoyage SQL dans la transaction avortée : le rollback transactionnel/savepoint du propriétaire rétablit le contexte.

Seul SQLSTATE `55P03` provenant des instructions d'acquisition contrôlées est converti en erreur technique :

- `code = ALERT_LOCK_TIMEOUT` ;
- `message = Opération temporairement indisponible` ;
- `cause` conserve l'erreur PostgreSQL ;
- **aucun `status` HTTP attribué**.

Les acquisitions n'utilisent pas NOWAIT. `statement_timeout` est distinct : s'il est plus court, il peut interrompre la commande avant le lock timeout ; son erreur n'est pas remappée en conflit métier. Le réglage PG-1 reste inchangé. Aucun retry automatique de deadlock (`40P01`), timeout, erreur réseau, commit incertain ou erreur métier.

### Actions et escalades : même verrou décisionnel

`act` utilise `findAlertForUpdate` avant visibilité, terminal, permission et transition. Toutes les décisions portent sur cette ligne, jamais sur une ancienne lecture. Mutation, audit, notifications, touch et relecture restent dans la transaction. Deux acquittements successivement sérialisés produisent une réussite puis `409 Transition interdite`, sans double audit ni notification.

`escalateDue` conserve la lecture ordinaire des candidats. Dans chaque opération atomique, il recharge l'alerte par le même `findAlertForUpdate`, ignore proprement une absence, puis revérifie niveau >=3, acquittement NULL et statut NOTIFIEE. Politique, date et palier sont ceux de la ligne courante ; le paramètre `time` du passage reste inchangé. Aucun palier committé n'est répété. Les boucles demeurent séquentielles, sans UPDATE conditionnel supplémentaire.

Sans parent : une transaction par candidat. Avec parent : préacquisition des lignes candidates dans l'ordre stable des IDs JavaScript, puis traitement dans l'ordre historique des candidats avec relecture verrouillée. Les préacquisitions appartiennent directement au parent : leur échec doit faire annuler le parent. RELEASE ne libère pas les verrous détenus par celui-ci. Un parent ne doit pas arriver avec un ordre de verrous antérieur incompatible.

### Notifications et règles

Lecture notification : verrou id/utilisateur avant le test historique `!read_at`, incluant la chaîne vide. Le premier lecteur met à jour et audite ; le second voit une date non vide et retourne `{ok:true}` sans nouvelle écriture. Aucune condition de concurrence ajoutée à l'UPDATE ordinaire.

Modification des règles : validation d'entrée conservée, puis singleton verrouillé, JSON parsé et audit previous/current re-sérialisé avant UPDATE. Le timestamp reste pris avant la lecture de configuration, conformément à l'ordre précédent. Le second audit référence la configuration réellement remplacée. Les lectures `config()` et la création ordinaire ne prennent aucun nouveau verrou explicite sur les règles.

### Badge : clé et frontière de décision

La clé correspond à : SHA-256 de `UTF8("securisite:alert-core:badge:v1") + NUL + UTF8(badge exact)`, huit premiers octets interprétés en entier signé 64 bits big-endian, transmis comme **chaîne décimale** à `pg_advisory_xact_lock($1::bigint)`. Aucune conversion en Number, aucun trim, changement de casse ou normalisation Unicode. Le domaine fait partie de l'empreinte. Une collision cryptographique théorique ne ferait que sérialiser deux badges ; les prédicats métier continuent de distinguer leurs valeurs.

Après les gardes historiques, `fromBadge` ouvre une transaction ou un savepoint sur le parent explicite. Il acquiert le verrou, puis lit la configuration, calcule une seule borne, compte les refus, cherche l'alerte récente et attend l'éventuel `create` sur ce même client. Aucune lecture décisionnelle n'a lieu avant l'acquisition. Seuils, fenêtre inclusive et absence de filtre site/statut restent inchangés. Aucun UNIQUE sur equipment.

Le verrou transactionnel reste détenu après RELEASE jusqu'au COMMIT/ROLLBACK parent. Deux badges distincts peuvent avancer simultanément. Les horloges des producteurs doivent rester cohérentes puisque la borne historique est toujours calculée avec l'heure du processus Node.

### Ordre global et responsabilité des parents composés

Ordre : clés advisory badge triées numériquement comme int64 signé → singleton règles → notifications existantes triées par ID numérique → alertes existantes triées par ID. Pour une opération simple, ne prendre que son verrou nécessaire.

Une composition doit préacquérir ses verrous dans cet ordre. En particulier, éviter alerte puis notification existante : l'audit de lecture référence l'alerte et peut prendre un verrou implicite via sa FK. La création de nouvelles notifications dans une action n'est pas le verrouillage d'une notification existante concurrente. Les préacquisitions ordonnées peuvent être réutilisées par les appels de service sur le même parent.

Pas d'ordonnanceur global ni de détection de tous les ordres arbitraires d'un parent externe. Ne pas partager le client entre tâches parallèles ; ne pas lancer de savepoints frères en parallèle. Après échec d'une primitive utilisée directement, le parent doit annuler sa transaction ou son savepoint avant toute poursuite. Un test volontairement hors ordre démontre un deadlock réellement propagé, sans faux succès ni retry.

### Incident, transport et limites

`fromIncident` est inchangé depuis PG-3.2A : aucune déduplication nouvelle. Un rejeu producteur peut encore créer une autre alerte. Les verrous de B ne constituent pas une idempotence HTTP générale et ne couvrent pas des producteurs qui contournent le service.

**Application complète toujours non fonctionnelle avant PG-3.3.** Restent : middleware/handlers async, mapping transport des erreurs techniques, attente d'init, timer async sans chevauchement local, transactions des routes incidents/piétons et tests HTTP. Aucun mapping 503 figé ici, aucun déploiement autorisé par ce lot.

### Tests de concurrence

`tests/postgres-alert-core-concurrency.test.js` applique 001/002 dans des bases PostgreSQL 16 jetables avec utilisateurs de fixture explicites. Deux connexions distinctes sont identifiées par PID ; `pg_blocking_pids` prouve l'attente réelle. Les barrières conservent le premier parent ouvert pendant l'observation. Workers escalation et badge : processus Node séparés, code transmis en mémoire, aucun fichier auxiliaire. Les tests vérifient états committés, nombres d'audits et notifications, rollback, timeout, isolation et clé stable interprocessus. Aucun mock ne remplace le mécanisme de verrouillage PostgreSQL.

Résultats sur PostgreSQL **16.13**, authentification SCRAM, cluster local jetable :

| Suite | Résultat |
| --- | --- |
| PG-3.2B concurrence | 50/50 |
| PG-3.2A service | 70/70 |
| PG-3.1 repository | 61/61 |
| PG-2.3 | 54/54 |
| PG-2.2 | 35/35 |
| PG-2.1 | 68/68 |
| PG-1 | 47/47 |
| `npm test` | 500 tests, 488 réussites, 12 échecs, aucun ignoré |

Comparaison automatique des noms d'échecs globaux avec PG-3.2A : mêmes dix tests HTTP Alert Core, même hook de fermeture historique et même test de démarrage SQLite ; aucun nouvel emplacement. Les tests antérieurs n'ont pas été modifiés. Syntaxe des trois JS du lot et contrôles de whitespace conformes. Cluster de test arrêté et données supprimées après exécution. Aucun commit ni push.


### Parité historique des badges numériques

Le nombre `123` et le texte `"123"` partagent la même représentation de verrou advisory. Seules les entrées de type `number` sont converties par `String(badge)` avant le hash ; les chaînes conservent leurs octets UTF-8. Cette représentation correspond à la comparaison PostgreSQL avec `pietons.badge TEXT` et à l’équipement `badge:123`. Aucun autre traitement du service ne change. `null` et `undefined` restent ignorés par `fromBadge`, comme au HEAD `5219313f91b68637021f4f1387e38a6d749e8234` ; un appel direct à `lockBadge` avec ces valeurs reste rejeté.

Onze tests supplémentaires couvrent la comparaison TEXT, la déduplication, les identités de clés distinctes et la parité directe avec le service historique chargé en mémoire : trois refus TEXT, création avec le nombre `123`, rollback, puis même résultat fonctionnel avec le service corrigé. Les producteurs texte/texte, nombre/nombre et nombre/texte sont exécutés dans des processus distincts ; `pg_blocking_pids` confirme leur attente réelle, la clé est identique et une seule alerte est créée. Avant correction, les nouveaux tests reproduisent `ERR_INVALID_ARG_TYPE` dès le passage numérique.

## PG-3.3A — Intégration transport Alert Core async

Ce lot porte uniquement la couche HTTP Alert Core et le démarrage serveur au service async de PG-3.2. Il ne modifie ni le repository, ni le service, ni PG-1, ni les migrations, ni les dépendances, ni le frontend. Restent explicitement hors périmètre : multitenant, memberships, RLS, SOS, push, IA, l'A2.3 SQLite (référence historique conservée dans le worktree `feature/securisite-alert-core`), et les transactions des routes incidents/piétons de `backend/routes.js` — encore synchrones, prévues pour un lot suivant.

### `backend/alerts.js`

- **Encapsulation async.** Express 4 ne relaie pas les rejets de promesse : `wrap(handler)` résout `handler(req, res, next)` puis renvoie tout rejet — synchrone ou asynchrone — à `next`. Le middleware de revalidation utilisateur et les neuf handlers passent par `wrap` et attendent leur appel de service. L'ordre d'enregistrement des routes est conservé (`/rules`, `/rules/audit`, `/notifications`, `/notifications/:id/read`, `/`, `POST /`, `/:id`, `/:id/actions`), ainsi que le 404 JSON `Route Alert Core introuvable` et le garde `admin` synchrone.
- **Revalidation utilisateur.** `service.currentUser(req.user.id)` est désormais attendu ; identité inconnue → `401 Session révoquée` ; erreur technique → `next`.
- **Mapping transport sécurisé.** Le gestionnaire d'erreurs du routeur est terminal : il ne rappelle jamais `next(err)` et n'atteint donc pas le gestionnaire global. Une erreur métier (`err.status` entier 400–499, message rédigé par `fail`) est renvoyée telle quelle. `ALERT_LOCK_TIMEOUT`, `ALERT_SCHEMA_UNAVAILABLE` et `ALERT_CONFIG_MISSING` deviennent `503 Centre d’alertes momentanément indisponible`. Toute autre erreur — SQL, `SyntaxError` de configuration, invariant interne — devient `500 Erreur serveur`. Aucun message pilote, SQL, `err.stack` ni `err.detail` n'est exposé ni journalisé ; seul `err.code`/`err.name` est tracé côté serveur. `ALERT_LOCK_TIMEOUT` n'avait « aucun status HTTP attribué » en PG-3.2B : le transport lui en attribue un ici.

### `server.js`

- **Démarrage ordonné.** `start()` enchaîne `db.init()` (SELECT 1) → `alerts.init()` (lecture seule des catalogues et de `alert_rules.id=1`) → `app.listen`. Un échec de readiness rejette la promesse renvoyée **avant** tout `app.listen` et avant toute programmation de timer. Le message fatal du lancement direct passe de « base SQLite » à « PostgreSQL ».
- **Timer d'escalade async sans chevauchement.** `setInterval` conserve la cadence d'une seconde et `unref()`. Un garde `running`/`stopping` fait ignorer un tic tant que le cycle précédent n'est pas résolu ou qu'un arrêt est demandé ; l'erreur d'un cycle est tracée sans interrompre le timer. La promesse du cycle courant est retenue dans `inflight`.
- **Arrêt gracieux minimal.** `start()` résout désormais `{ server, port, stop }`. `stop()` marque l'arrêt, annule le timer, attend le cycle d'escalade en cours, ferme l'écoute puis le pool via `db.close()`. Il est idempotent et ne rejette pas. Le lancement direct câble `SIGTERM`/`SIGINT` sur `stop()` puis `process.exit(0)`.
- **Normalisation de fin de ligne.** `server.js` était en CRLF mixte au HEAD ; il est normalisé en LF, conformément aux fichiers déjà portés (`database.js`, `alert-core/*.js`, `db/*.js`) et pour garder `git diff --check` conforme. Les fichiers legacy non portés (`auth.js`, `routes.js`, `seed.js`, `sync.js`) restent inchangés.

### Tests

`tests/postgres-alert-core-http.test.js` démarre le vrai serveur Express sur une base PostgreSQL 16 jetable (migrations 001/002, comptes `admin`/`agent` avec empreintes bcrypt réelles) et exerce, via HTTP : authentification et visibilité par utilisateur, validation d'entrée, workflow critique avec acquittements concurrents sérialisés et audit immuable (rejet `Audit immuable` vérifié en base), rétention de la demande d'annulation, règles réservées au SOC avec politique figée à la création, lecture de notification cadrée et auditée une seule fois, escalade async rejouée sans doublon puis stoppée par l'acquittement, mapping d'erreurs (métier verbatim, 500/503 génériques sans fuite), 404 JSON limité à Alert Core, revalidation d'une session révoquée.

`tests/postgres-alert-core-startup.test.js` couvre la readiness et l'arrêt : un schéma Alert Core absent, une ligne de configuration absente et une base injoignable sont refusés dans un processus enfant qui instrumente `app.listen` et `setInterval` — aucun des deux n'est appelé, et l'erreur porte le code attendu ; un démarrage sain écoute puis `stop()` ferme l'écoute et le pool, est idempotent.

Résultats sur PostgreSQL **16.13** (Homebrew), authentification locale, base racine jetable `securisite_test` :

| Suite | Résultat |
| --- | --- |
| PG-3.3A HTTP | 9/9 |
| PG-3.3A démarrage/readiness | 4/4 |
| PG-3.2B concurrence | 50/50 |
| PG-3.2A service | 70/70 |
| PG-3.1 repository | 61/61 |
| PG-2.3 | 54/54 |
| PG-2.2 | 35/35 |
| PG-2.1 | 68/68 |
| PG-1 | 47/47 |
| `npm test` | 513 tests, 501 réussites, 12 échecs, aucun ignoré |

Les 12 échecs globaux sont exactement ceux des lots précédents : les dix tests de `tests/alerts.test.js` (HTTP SQLite legacy), son hook de fermeture via `db.raw`, et `startup: failed migration prevents listen…` des migrations SQLite. Aucun nouvel emplacement ; aucun test antérieur modifié. `node --check` et `git diff --check` conformes sur les quatre fichiers. Cluster de test laissé tel quel (service Homebrew partagé) ; bases jetables supprimées. Aucun push.

**L'application fonctionne désormais de bout en bout sur PostgreSQL pour Alert Core** : readiness au démarrage, handlers async, escalade périodique non chevauchante et arrêt propre. Les routes métier `incidents`/`pietons` de `backend/routes.js` restent à porter avant une mise en service complète.
