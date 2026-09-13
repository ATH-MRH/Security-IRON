# SécuriSite — journal de sécurité global (PG-10)

Migration `006_security_audit.sql`. Table `public.security_audit` : QUI a
fait QUOI, QUAND, sur QUELLE RESSOURCE, dans QUEL PÉRIMÈTRE, avec QUEL
RÉSULTAT. Ne remplace pas `alert_audit` / `alert_config_audit` /
`membership_audit`, qui restent l'autorité de leur domaine (before/after
détaillé) — `security_audit` n'enregistre que l'événement de sécurité
synthétique. Point d'écriture unique : `backend/security-audit.js#record`.

## Schéma

`id BIGINT identity` · `created_at TIMESTAMPTZ DEFAULT clock_timestamp()` ·
`request_id` / `correlation_id` (TEXT, nullables — voir « Limites ») ·
`actor_user_id` / `actor_username` / `actor_role` (nullables : un login
échoué n'a pas d'utilisateur résolu) · `tenant_id` / `site_id` / `zone_id`
(UUID nullables, **sans** clé étrangère — posés par le périmètre résolu côté
serveur, jamais le corps de la requête ; nullables car de nombreux
événements — login, refus avant résolution de périmètre — n'ont pas de
tenant) · `event_type` / `resource_type` / `action` (TEXT libres, **pas** de
CHECK figé : de nouveaux types apparaîtront avec PG-15/19+ sans migration) ·
`outcome` (`CHECK IN ('success','denied','failure')`) · `origin` (`CHECK IN
('http','system','migration','automation')` — une origine `ia` viendra par
migration dédiée si nécessaire, PG-19+) · `ip_address INET` · `user_agent
TEXT` · `detail JSONB` (sanitisé, voir plus bas).

Index : `(tenant_id, created_at DESC)`, `(actor_user_id, created_at DESC)`,
`(event_type, created_at DESC)`, `(resource_type, resource_id, created_at
DESC)`.

## Append-only et RLS

Mêmes garde-fous que les journaux existants : `securisite_meta.
reject_alert_audit_mutation()` (réutilisée) rejette `UPDATE`/`DELETE`/
`TRUNCATE` (23514). `PRIVILEGES.security_audit = 'SELECT,INSERT'` — jamais
`UPDATE`/`DELETE` pour le rôle applicatif.

RLS (migration 006) : **lecture** réservée aux memberships **actifs de rôle
`soc`** sous leur propre tenant (`securisite_meta.
current_actor_soc_tenant_ids()`, distincte de la fonction PG-9 qui couvre
tout rôle) — un membership `agent` n'a **aucun** accès général au journal,
même sous son propre tenant. **Écriture** non filtrée par RLS
(`WITH CHECK (true)`) : le tenant posé par l'application peut légitimement
être `NULL` (login, refus avant résolution de périmètre) ; le GRANT
(`INSERT` seul, jamais `SELECT` libre en écriture) est la vraie porte côté
rôle — RLS ne restreint ici que la **lecture**.

## `backend/security-audit.js`

`record(event, client = db)` — insère une ligne, propage toute erreur SQL
comme n'importe quel appel repository (aucun try/catch interne).
`recordBestEffort(event, client)` — enveloppe `record`, avale l'erreur et la
journalise (code seul, jamais l'événement complet), retourne `null` en cas
d'échec. `sanitizeDetail(detail)` — objet plat uniquement (les tableaux de
valeurs simples sont acceptés, pas les valeurs imbriquées) ; toute clé ou
valeur (chaîne longue) correspondant à un motif interdit (mot de passe, hash,
JWT, token, secret, clé API, cookie, session, `Authorization`,
`DATABASE_URL`/DSN, `sql`, `stack`) est retirée silencieusement, jamais
journalisée « au cas où ».

### Fail-closed vs best-effort — décision du site d'appel

`record()` ne décide jamais lui-même : c'est l'appelant qui choisit.

- **Mutation métier critique** (`user.create/update/delete`,
  `membership.create`, `alert.create`, `alert.action`,
  `alert.rules.update`) : l'audit `success` est écrit **dans la même
  transaction** que la mutation, avec `client` explicite, jamais `db` par
  défaut. Un échec d'écriture de l'audit fait échouer/rollback la mutation
  elle-même — jamais de faux `success`. `tests/postgres-security-audit.test.js`
  le prouve en injectant une erreur sur l'INSERT `security_audit` lui-même.
- **Login, session révoquée, refus d'accès (`auth.*`)** : aucune donnée
  métier n'est en jeu — `recordBestEffort` en dehors de toute transaction de
  mutation. Un journal momentanément indisponible ne doit ni bloquer un login
  légitime, ni transformer un 401/403 correct en 500. Chaque site d'appel
  **attend** la promesse (jamais fire-and-forget) avant d'écrire la réponse
  HTTP, pour que l'écriture ait eu l'occasion de se terminer — mais son échec
  éventuel reste invisible au client (avalé par `recordBestEffort`).

## Câblage

- `backend/auth.js` — `auth.login.success` / `auth.login.failure`
  (`actor_username` = valeur soumise pour un échec, jamais le mot de passe).
- `backend/scope.js#requireScope` et `backend/alerts.js` — `auth.access.denied`
  (périmètre, `/admin/*`, actions réservées SOC) et `auth.session.revoked`.
- `backend/routes.js` — `user.create` / `user.update` / `user.delete` (même
  transaction que la mutation ; `DELETE` reste 409 métier — pas d'audit —
  quand `memberships` bloque la suppression, cf. `docs/postgresql-scope.md`).
- `backend/db/postgresql/provision-membership.js` — `membership.create`,
  `origin='automation'` (outil de provisioning, pas un handler HTTP).
  `membership.update/suspend/archive` : **aucun chemin de mutation n'existe
  encore** au runtime pour ces actions (PG-8 n'a délibérément rien câblé) —
  seront audités le jour où un tel endpoint existera.
- `backend/alert-core/service.js` — `alert.create` (`origin` de l'audit =
  `'http'` pour une création directe `COMMAND`, `'system'` pour un
  déclenchement automatique `INCIDENT`/`REGLE_BADGE` — à ne pas confondre
  avec le champ métier `security_alerts.origin`, qui porte ces trois mêmes
  valeurs pour un usage différent), `alert.action`, `alert.rules.update`.
  Contexte (tenant/request/IP/UA) posé sur `user` par `backend/alerts.js`,
  jamais recalculé dans `service.js` (même convention que `alertAccess`/
  `isSoc`, PG-8) — `service.js` garde son contrat testé (aucun SQL propre,
  exports inchangés).

### Ce qui n'est délibérément PAS audité

Chaque `GET`, chaque lecture réussie banale, chaque rafraîchissement de
tableau de bord, chaque notification lue : aucun événement `security_audit`.
Un refus RLS silencieux (une ligne existante mais invisible pour l'acteur
courant) n'est pas non plus journalisé — un filtre RLS invisible n'est pas
nécessairement une erreur, et le journaliser systématiquement exploserait le
volume sans valeur de sécurité claire.

## `GET /api/admin/security-audit`

`requireAdmin` (rôle JWT) est une première porte grossière ; l'enforcement
réel est la RLS via `backend/scope.js#withActorContext` (PG-9) — un « admin »
JWT sans membership `soc` reçoit une liste vide, pas une erreur. Filtres :
`event_type`, `resource_type`, `actor` (= `actor_username`), `from`/`to`
(ISO, 400 si invalide), `limit` (défaut 50, borné à 500). Pas d'export
massif, pas de pagination par curseur dans PG-10.

## Limites connues (documentées, pas des trous silencieux)

- **`correlation_id`** : colonne présente, acceptée par `record()`, mais
  **rien ne la peuple encore automatiquement** — aucun mécanisme de
  propagation entre requêtes n'a été construit (« ne pas imposer une
  architecture distribuée complexe »). Un futur flux multi-requêtes (SOS,
  PG-15) devra la poser explicitement.
- **`request_id`** : posé par `backend/request-context.js` pour toute requête
  HTTP (`X-Request-Id` en réponse) ; absent pour les événements
  `system`/`automation` déclenchés hors requête HTTP (ex. `membership.create`
  via l'outillage de déploiement).
- **`ip_address`** : `req.ip`, jamais `X-Forwarded-For` — `server.js` ne
  configure aucun `trust proxy`. Un déploiement derrière un reverse proxy
  réel devra le configurer explicitement avant que cet en-tête ne devienne
  fiable (sinon un client pourrait forger son adresse apparente).
- **Rétention** : aucune purge automatique en PG-10, aucun `DELETE`/cron —
  décision opérationnelle future, hors périmètre ici.
