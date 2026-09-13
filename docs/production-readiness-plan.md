# SécuriSite — plan de préparation production (exécutable, non exécuté)

Document de préparation uniquement. **Aucune action production n'a été
effectuée pour produire ce plan** — aucun serveur réel contacté, aucune
base réelle modifiée, aucun secret réel créé ou changé. Référence :
branche `main`, HEAD `f412d449b3f5dcf3407097f43e330d8bb7ea1299`, validé en
staging local (voir rapport de charge — 20/50/100 utilisateurs simultanés,
0 échec, 0 fuite cross-tenant).

Ce document synthétise et relie les runbooks déjà écrits et testés
lot par lot — il ne les duplique pas. Chaque section renvoie au document
source pour le détail complet et la preuve (tests) qui l'accompagne.

---

## 1. Architecture production recommandée

**Modèle retenu : serveur Node.js unique (`node server.js`) + PostgreSQL
dédié, derrière Coolify (reverse proxy géré par la plateforme).** C'est le
modèle que tout le roadmap PG-6→PG-30 a construit, durci et testé (RLS,
scope, audit, rate-limit, SSRF) — pas une hypothèse. Détail Coolify complet :
`docs/production-coolify.md`.

```
Internet
   │  HTTPS (443, security.irongs.com)
   ▼
Coolify (reverse proxy géré par la plateforme — TLS, certificat, domaine,
         aucun Nginx/Caddy/Traefik déclaré à la main)
   │  réseau Docker interne
   ▼
node server.js (rôle securisite_app, conteneur `app`) ──► PostgreSQL (conteneur `db`, rôle securisite_app)
   │
   └─ sert aussi le frontend statique (express.static) : pas de serveur
      frontend séparé, pas de build à déployer à part
```

- **Un seul processus applicatif** aujourd'hui : `backend/realtime.js`
  (bus SSE) est en mémoire, mono-processus (documenté,
  `docs/realtime.md`). **Ne pas** faire tourner plusieurs instances
  `server.js` derrière un même load-balancer sans upgrade préalable
  (PostgreSQL LISTEN/NOTIFY pour partager le bus) — sinon un abonné SSE
  connecté à l'instance B ne recevra jamais un événement émis par
  l'instance A. Un seul processus, redémarré par le superviseur en cas de
  crash, est le modèle actuellement supporté et testé.
- **PostgreSQL** : un cluster séparé (managé ou auto-géré), jamais
  co-localisé avec un autre produit sur le même rôle `securisite_app`
  (RLS/`REVOKE ALL FROM PUBLIC` supposent une base dédiée).
- **Docker** : `docker-compose.prod.yml` a été réécrit (services
  `db`/`migrate`/`app`, réseau interne, aucun port public, healthchecks
  `/api/ready`) — voir §18. `Dockerfile` mis à jour (`postgresql16-client`
  ajouté pour `pg_dump`/`pg_restore`, répertoire `data/` de l'ancien modèle
  SQLite retiré). Les deux ont été vérifiés par un déploiement local
  complet et jetable (db → provisioning rôles → migrations → app →
  création admin → login réel → `GET /api/alerts` 200), jamais contre le
  serveur réel — voir le rapport final de cette session pour le détail.
- **Electron (`electron/`)** : distribution desktop existante, séparée,
  non affectée par ce plan — hors périmètre (ce plan couvre le
  déploiement serveur multi-utilisateurs).

## 2. PostgreSQL production

- Version : PostgreSQL 16 (celle testée tout au long du roadmap et en
  staging) — une version antérieure n'est pas exclue mais n'a jamais été
  testée sur ce code base.
- Base dédiée, TLS activé (`PGSSL=verify-full` — jamais `disable` en
  production, contrairement au staging local).
- Dimensionnement : voir §16 (bcrypt/capacité) — le pool applicatif
  (`PGPOOL_MAX`, défaut 10) n'a jamais été le facteur limitant, même à 100
  utilisateurs simultanés en staging (jamais plus de 5 connexions actives
  observées). Point de départ raisonnable, à réviser seulement si un volume
  réel démontre le contraire (`db.stats()`, `docs/postgresql-deployment.md`
  §6).
- Détail complet : `docs/postgresql-deployment.md`.

## 3. Rôles OWNER / MIGRATOR / APP

```
docker compose -f docker-compose.prod.yml up -d db
./scripts/provision-production-db.sh
```

`scripts/provision-production-db.sh` (nouveau) encode et automatise
exactement la procédure documentée (`docs/postgresql-deployment.md`
§1-§2) — six étapes vérifiées par un déploiement local jetable complet
(rôles → correction de l'effet de bord sur la base `postgres` → création
de la base → migrations → finalisation des `GRANT`) :

1. Rôles + `CONNECT` (base neutre `postgres`, la base cible n'existe pas
   encore).
2. Restauration explicite de `GRANT CONNECT, TEMP ON DATABASE postgres TO
   PUBLIC` — l'étape 1 le révoque comme effet de bord
   (`REVOKE ALL ... FROM PUBLIC` dans `provision-roles.js`, qui s'applique
   à la base courante quelle qu'elle soit) ; sans cette restauration,
   d'autres rôles/outils du cluster perdraient l'accès par défaut à la
   base administrative `postgres`.
3. `CREATE DATABASE securisite OWNER securisite_owner;` — **l'ordre
   compte** : la base doit appartenir à `securisite_owner` dès sa
   création, sinon les `GRANT` du rôle MIGRATOR échouent ensuite
   (`permission denied for database`) — piège rencontré et corrigé
   pendant la mise en place du staging, encodé ici pour ne plus jamais
   être refait à la main.
4. Migrations (rôle MIGRATOR, `docker compose run migrate`).
5. `provision-roles.js` de nouveau — complète les `GRANT` sur le schéma
   maintenant existant.
6. Démarrage applicatif (rôle APP uniquement — jamais MIGRATOR/OWNER au
   runtime, jamais interchangés) : `docker compose up -d app`.

`securisite_app` : `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
NOBYPASSRLS`, jamais membre d'OWNER — vérifié explicitement en staging ET
sur ce nouveau déploiement jetable (`rolbypassrls=false` confirmé par
requête directe).

## 4. Variables d'environnement nécessaires

Reprend `.env.example` (le fichier existant du dépôt) — checklist complète
`docs/postgresql-deployment.md` §3 :

| Variable | Production |
|---|---|
| `DATABASE_URL` | rôle `securisite_app`, jamais MIGRATOR/OWNER |
| `PGSSL` | `verify-full` (jamais `disable`) ; `PGSSLROOTCERT` si CA privée |
| `JWT_SECRET` | ≥32 caractères aléatoires réels (voir §5) |
| `PGPOOL_MAX`, `PGCONNECT_TIMEOUT_MS`, `PGIDLE_TIMEOUT_MS`, `PGSTATEMENT_TIMEOUT_MS`, `PGTRANSACTION_IDLE_TIMEOUT_MS` | valeurs explicites (défauts de `.env.example` = point de départ raisonnable) |
| `PORT` | port d'écoute interne (derrière le reverse proxy) |
| `NODE_ENV` | `production` (active le fail-closed `JWT_SECRET`, `backend/auth.js`) |
| `ALLOWED_ORIGIN` | **laisser vide** si frontend+API sur le même domaine (cas normal ici, `express.static` sert déjà le frontend) — ne le renseigner que si un domaine séparé consomme l'API |
| `SECURISITE_CAMERAS_CONFIG_FILE` | voir §12 — optionnel, absent = aucune caméra (fail-closed, jamais une erreur) |

## 5. Secrets à créer (jamais dans Git, jamais dans un log)

- Mot de passe `securisite_migrator`
- Mot de passe `securisite_app`
- `JWT_SECRET` (≥32 octets aléatoires — `openssl rand -hex 32` ou
  équivalent du gestionnaire de secrets de la plateforme)
- `SECURISITE_ADMIN_PASSWORD` (premier compte admin, changé/retiré après
  premier login réel si la plateforme le permet)
- Si HTTPS géré par l'application plutôt que le reverse proxy : certificat
  TLS (généralement pas nécessaire — voir §11, le reverse proxy porte TLS
  dans le modèle recommandé)
- Si un fournisseur push/IA réel est activé un jour (voir §15) : ses
  propres clés — **hors périmètre de ce plan**, décision humaine séparée.

Aucun de ces secrets n'a été généré ici pour un usage réel — uniquement
des valeurs staging locales, jetables, déjà utilisées et non réutilisables
pour la production.

## 6. Migrations 001→010

Procédure, compatibilité de rollback migration par migration, et
avertissements exacts (RLS/`tenant_id NOT NULL`) déjà écrits et vérifiés :
`docs/postgresql-deployment.md` §8 (« Rollback »). Exécuter **avant** tout
rollout applicatif, jamais par l'application elle-même au démarrage
(`server.js` ne fait qu'une attestation readiness, jamais de DDL).

```
DATABASE_URL='postgres://securisite_migrator:…@HOST/securisite' PGSSL=verify-full \
  npm run db:migrate
```

Sortie attendue : `[migrate] appliquées : 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`
(ou `aucune` si déjà à jour — idempotent, sûr à rejouer).

## 7. Création du premier administrateur

```
./scripts/create-first-admin.sh
```

Corrigé depuis le tour précédent : `create-admin.js` crée le compte
(`role='admin'`) mais **ne provisionnait aucun membership** — sans
membership, ce compte n'avait accès qu'aux routes `/api/admin/*` (JWT
`role`), jamais au tableau de bord SOC/alertes (`scope.requireScope()`,
PG-8). Nouveau : `backend/db/postgresql/bootstrap-admin-membership.js`
(testé, 6/6, `tests/postgres-bootstrap-admin-membership.test.js`) complète
`create-admin.js` avec un membership `soc`/`scope` réel sous le tenant
« local ». `scripts/create-first-admin.sh` enchaîne les deux, avec
`SECURISITE_ADMIN_PASSWORD` fourni uniquement par l'environnement/`.env`
(jamais un mot de passe codé en dur, jamais en argument de commande).
Vérifié de bout en bout sur un déploiement jetable : compte créé,
membership provisionné, login réel réussi, `GET /api/alerts` → 200.

## 8. Procédure d'import des anciennes données (éventuelle)

Outillé et testé, mais **conditionné à une information que je n'ai pas** :
existe-t-il des données SQLite réelles à reprendre ? Si oui :
`backend/db/postgresql/import-sqlite.js` (`npm run db:import`) — garde de
sécurité `assertTargetAllowed` intégrée (refuse une cible qui ressemble à
de la production sans confirmation explicite). Si aucune donnée
historique n'existe (déploiement neuf), cette étape est simplement
absente du plan d'exécution — à confirmer (voir §21, information humaine
requise).

## 9. Backup obligatoire avant migration (et automatique en continu)

Base neuve confirmée (aucune donnée à migrer) : sans objet pour le tout
premier déploiement. **Obligatoire à partir du second déploiement**
(dès que la base contient des données réelles), avant toute nouvelle
migration :

```
./scripts/backup-production.sh
```

`scripts/backup-production.sh` (nouveau, vérifié par un cycle complet
sauvegarde → `pg_restore --list` réel sur un déploiement jetable — 224
entrées de schéma confirmées) : écrit un fichier daté
(`securisite-<horodatage>.dump`) via l'outil testé
`backend/db/postgresql/backup-cli.js` (jamais un `pg_dump` nu — mêmes
garanties que le runbook), purge les fichiers de plus de
`SECURISITE_BACKUP_RETENTION_DAYS` (7 par défaut). N'installe aucune tâche
planifiée lui-même — exemple de cron fourni en commentaire dans le script,
à ajouter manuellement sur le serveur si une sauvegarde automatique
régulière est voulue.

Runbook complet, restauration prouvée de bout en bout (comparaison ligne à
ligne après un cycle destruction/restauration réel) : `docs/postgresql-backup-restore.md`.
Aucun chiffre de RPO/RTO n'est promis dans ce dépôt — non mesuré à
l'échelle réelle (délibéré, voir ce document, §« RPO/RTO »). À mesurer sur
l'infrastructure production réelle si un engagement chiffré est requis.

## 10. Procédure de rollback

- **Schéma** : restauration depuis la sauvegarde de §9
  (`restore-cli.js`) — jamais de migration descendante automatique (les
  migrations sont *forward-only*).
- **Applicatif** : redéployer la version précédente compatible avec le
  schéma **courant** (ne jamais rétrograder le schéma pour un rollback
  applicatif).
- **Deux migrations à connaître avant un rollback applicatif** (détail
  exact, `docs/postgresql-deployment.md` §8) :
  - `005` (RLS) : une version antérieure à PG-9 verrait les tables
    protégées silencieusement **vides** sous le rôle réel (pas une
    erreur — un comportement dégradé silencieux).
  - `009` (`security_alerts.tenant_id NOT NULL`) : une version antérieure
    à PG-16 échouerait à créer une alerte (contrainte `NOT NULL`) —
    rollback au-delà de PG-16 non compatible sans intervention.

## 11. HTTPS / domaine / reverse proxy

Domaine confirmé : `security.irongs.com`. Plateforme confirmée : Coolify
— gère domaine/HTTPS/certificat/reverse proxy lui-même, aucun
Nginx/Caddy/Traefik déclaré dans `docker-compose.prod.yml`. Détail complet
et étapes exactes de l'interface Coolify : `docs/production-coolify.md`
(`docs/production-reverse-proxy.md` reste comme référence générale, non
spécifique à Coolify). Rappel des points structurants :

- **TLS côté reverse proxy**, jamais dans le processus Node en production
  — modèle standard, cohérent avec `PGSSL=verify-full` déjà exigé côté
  base.
- **SSE (temps réel, §13) doit passer sans buffering** : un proxy qui
  bufferise la réponse casse `/api/realtime/stream` (les événements
  n'arriveraient jamais, ou en bloc à la fermeture). Nginx :
  `proxy_buffering off; proxy_read_timeout 3600s;` sur ce chemin précis
  (ou plus long — la connexion reste ouverte indéfiniment côté serveur,
  heartbeat 15 s).
- **`trust proxy` non configuré dans `server.js`** (limite déjà documentée,
  `docs/postgresql-security-audit.md`) : `req.ip` restera l'IP du reverse
  proxy, pas celle du client réel, tant que `app.set('trust proxy', …)`
  n'est pas ajouté avec la topologie exacte du proxy — impacte l'exactitude
  de `ip_address` dans `security_audit` et le rate-limit par IP
  (`postgres-auth-ip-rate-limit.test.js`). **Non corrigé dans ce plan**
  (changement de code, hors périmètre "aucune action") — à traiter avant
  mise en production si l'IP réelle du client compte pour la conformité.
- **Domaine unique recommandé** (frontend + API) : `ALLOWED_ORIGIN` reste
  vide, aucune configuration CORS supplémentaire nécessaire.
- **HTTPS obligatoire pour la PWA** : le service worker
  (`frontend/sw.js`) ne s'enregistre que dans un « contexte sécurisé »
  (HTTPS, ou `localhost`) — sans TLS, l'app continue de fonctionner mais
  sans mode hors-ligne ni installabilité (`docs/pwa.md`).
- **CSP** : aucune n'est posée par l'application (décision PG-25 documentée
  — une CSP mal calibrée casserait des scripts existants sans audit
  préalable du contenu réel). Une CSP peut être ajoutée au niveau du
  reverse proxy si souhaité, sans changement de code applicatif.

## 12. Configuration caméra sécurisée

Modèle complet, durci contre la SSRF trouvée et corrigée en PG-30 :
`docs/camera-proxy.md`. Résumé actionnable :

- Aucune caméra n'est joignable par défaut (`SECURISITE_CAMERAS_CONFIG_FILE`
  absent → registre vide, fail-closed).
- Pour activer une/des caméra(s) réelle(s) : fichier JSON local sur le
  serveur (jamais committé), un enregistrement par caméra
  (`id`, `name`, `type`, `url`, `tenantId`, `siteId`/`zoneId` optionnels,
  `authUser`/`authPass` optionnels, `insecureTls` optionnel).
- Adresses réseau autorisées : tout LAN privé normal (RFC1918) — jamais
  loopback/link-local (métadonnées cloud incluses)/multicast, refusé
  **au chargement** du fichier si une IP littérale interdite y figure.
- `tenantId`/`siteId`/`zoneId` doivent correspondre aux **vrais**
  identifiants de la base production (`SELECT id FROM public.tenants`) —
  information que je n'ai pas encore pour un déploiement réel (voir §21).
- **Information humaine requise** : URL/identifiants des caméras réelles
  à déclarer, et le tenant/site/zone réel auquel chacune appartient.

## 13. Realtime / SSE

Fonctionne tel quel derrière le reverse proxy configuré comme au §11.
Rappel de la limite structurelle (déjà notée en §1) : un seul processus
Node porte le bus en mémoire — un scale-out horizontal (plusieurs
instances `server.js`) nécessiterait un upgrade (PostgreSQL LISTEN/NOTIFY)
non construit dans ce dépôt. Détail : `docs/realtime.md`.

## 14. PWA

Fonctionne telle quelle une fois HTTPS en place (§11) — manifest et
service worker déjà servis, testés (`tests/postgres-pwa.test.js`). Limite
connue déjà documentée : pas encore de jeu d'icônes 192/512/maskable
dédié (une seule icône 550×550 réutilisée) — cosmétique, sans impact
fonctionnel, à affiner si l'installation PWA devient un canal de
distribution prioritaire (`docs/pwa.md`).

## 15. Providers push et IA

**Conservés fake/local, comme demandé — aucun changement fait ici.**

- Push : `backend/push/fake-provider.js` reste actif tant qu'aucune paire
  de clés VAPID réelle n'est fournie (HUMAN CHECKPOINT explicite,
  `docs/push.md`). Les notifications navigateur resteront inertes en
  production tant que cette décision n'est pas prise — comportement
  normal, pas un bug.
- IA : `LocalAIProvider` (déterministe, aucun réseau) reste actif tant
  qu'aucun fournisseur réel (clé API) n'est fourni (`docs/ai.md`). Les
  résumés/l'assistant/la corrélation/la recherche restent fonctionnels
  mais avec un texte simulé, jamais un vrai modèle de langage.

Activer l'un ou l'autre reste une décision humaine séparée, hors
périmètre de ce plan (clé/compte tiers = HUMAN CHECKPOINT REQUIRED).

## 16. Health / readiness — et l'analyse bcrypt (limite de capacité, non corrigée)

- `GET /api/health` (liveness, jamais bloqué par PostgreSQL) et
  `GET /api/ready` (readiness continue, `SELECT 1`) — à câbler sur les
  sondes de l'orchestrateur/du reverse proxy. Attestation exhaustive
  (`assertReady`) déjà bloquante **une seule fois**, au démarrage, avant
  toute écoute. Détail : `docs/postgresql-deployment.md` §5,
  `docs/observability.md`.

- **Analyse de la latence bcrypt observée en staging (non corrigée, comme
  demandé)** : sous 100 connexions simultanées, la latence de connexion a
  atteint p50 4,7 s / p95 5,4 s, sans **aucun échec** (0/982 requêtes en
  échec sur l'ensemble de la campagne). Cause identifiée : `bcryptjs`
  (dépendance actuelle, implémentation pur JavaScript — pas de thread
  natif) hache chaque mot de passe sur le thread principal Node ; sous une
  rafale de connexions simultanées, ces calculs se sérialisent entre eux,
  et les autres routes (dashboard, liste alertes) ralentissent en cascade
  pendant que le thread principal est occupé — PostgreSQL, lui, n'a jamais
  été le facteur limitant (jamais plus de 5 connexions actives sur un pool
  de 10, 0 attente, 0 verrou).
  **Classée comme limite de capacité connue, pas un défaut fonctionnel** :
  aucune requête n'a échoué, aucune donnée n'a été corrompue ou mal
  isolée, à aucun palier testé. Pertinent pour le dimensionnement
  production si des rafales de connexion de cet ordre (100+ logins dans la
  même seconde) sont réellement attendues — sinon sans conséquence
  pratique. Aucune correction appliquée dans ce plan, conformément à la
  demande.

## 17. Logs

Une ligne JSON structurée par requête HTTP, allowlist stricte de champs
(jamais de secret, jamais de contenu de requête/réponse) — déjà prouvé par
test qu'un jeton Bearer réel n'y fuite jamais, même sérialisé. Sondes
santé explicitement exclues du bruit. Sur stdout : un collecteur de
plateforme (Docker/journald/agrégateur managé) l'ingère tel quel, aucune
bibliothèque supplémentaire nécessaire. Détail : `docs/observability.md`.
Journal de sécurité/conformité séparé (`security_audit`, interrogeable par
un rôle `soc` via RLS, jamais par simple lecture de logs) :
`docs/postgresql-security-audit.md`.

## 18. Démarrage automatique du service

`server.js#start()` gère lui-même l'ordre correct (connexion → readiness
→ écoute → timer) et un arrêt gracieux borné sur `SIGTERM`/`SIGINT`
(`docs/postgresql-deployment.md` §7) — un superviseur externe n'a qu'à
lancer `node server.js` et le laisser gérer son propre cycle de vie.

- **Docker + Coolify (retenu)** : `docker-compose.prod.yml` adapté à
  Coolify — services `db` (PostgreSQL 16, aucun port publié), `migrate`
  (une exécution, `restart: "no"`, bloque `app` tant qu'il n'a pas réussi),
  `app` (`restart: unless-stopped`, healthcheck `/api/ready`, `expose:
  3000` jamais publié sur l'hôte — Coolify route `security.irongs.com`
  vers ce port via son interface, aucun label de proxy écrit à la main,
  voir `docs/production-coolify.md`). `Dockerfile` mis à jour
  (`postgresql16-client` ajouté). Séquence vérifiée de bout en bout sur un
  déploiement local jetable :
  ```
  docker compose -f docker-compose.prod.yml build
  docker compose -f docker-compose.prod.yml up -d db
  ./scripts/provision-production-db.sh      # une fois
  docker compose -f docker-compose.prod.yml up migrate
  ./scripts/create-first-admin.sh           # une fois
  docker compose -f docker-compose.prod.yml up -d app
  ```
- **systemd** (alternative sans conteneur, non retenue ici) :
  `Restart=on-failure`, `ExecStart=/usr/bin/node server.js`, variables via
  `EnvironmentFile=` (jamais en clair dans l'unit file) — pas de fichier
  `.service` dans ce dépôt ; à écrire selon la distribution cible si ce
  chemin est retenu plutôt que Docker.

## 19. Smoke tests après déploiement

Deux couches déjà écrites et exercées en staging, réutilisables telles
quelles contre l'URL réelle :

1. **Suite automatisée** (`node --test tests/*.test.js`, 982 tests) — à
   rejouer contre une base de TEST dédiée, jamais contre la base
   production (`SECURISITE_TEST_DATABASE_URL` refuse structurellement tout
   nom qui n'est pas `securisite_test[_suffixe]`).
2. **Smoke HTTP réel** (`smoke-staging.js`, 39 assertions — health/ready,
   login bon/mauvais mot de passe, dashboard, incident → alerte auto,
   badges, cycle de vie complet d'une alerte, SOS, realtime (ticket +
   flux SSE), PWA, caméra (liste/ticket/proxy + refus sans auth + `src=`
   client ignoré), IA locale (5 endpoints), audit admin, négatifs sans
   token/tenant forgé) — à adapter avec l'URL et les identifiants réels,
   à exécuter juste après le rollout, avant de considérer le déploiement
   terminé. Le script existe (répertoire de travail de cette session,
   hors dépôt) ; à copier/adapter pour la cible réelle le moment venu.

## 20. Procédure d'arrêt / reprise

- **Arrêt** : `SIGTERM` au processus (`stop()` gère l'ordre : plus de
  nouveau cycle → attend le cycle en cours (10 s max) → ferme l'écoute
  HTTP → ferme le pool PostgreSQL en dernier). Idempotent, sûr à rappeler.
- **Reprise** : redémarrer `node server.js` avec les mêmes variables
  d'environnement — `start()` refait l'attestation readiness avant
  d'écouter ; si la base est indisponible, le processus ne démarre pas
  (fail-closed), jamais un démarrage partiel silencieux.
- **Vérification post-reprise** : `GET /api/health` puis `GET /api/ready`
  avant de rebasculer le trafic.

---

## Checklist

### A. À préparer
- [x] Hébergement : serveur dédié — confirmé
- [x] Domaine : `security.irongs.com` — confirmé
- [x] Décision données existantes : base neuve, aucun import (§8 sans objet)
- [x] `docker-compose.prod.yml` / `Dockerfile` corrigés et adaptés à
      Coolify (§1/§18) — vérifiés par un déploiement local jetable complet
- [x] Plateforme confirmée : Coolify — `docs/production-coolify.md`
- [ ] Configuration caméra réelle si applicable (§21, §12)

### B. À sauvegarder
- [ ] Sans objet pour ce premier déploiement (base neuve) — `scripts/backup-production.sh`
      prêt et vérifié pour les déploiements suivants (§9)

### C. À configurer
- [ ] Toutes les variables d'environnement — modèle prêt : `.env.production.example` (§4)
- [ ] Tous les secrets réels, générés côté serveur uniquement, jamais
      transmis dans ce chat (§5)
- [ ] Domaine + port assignés au service `app` dans l'interface Coolify
      (`docs/production-coolify.md` §3) — `trust proxy` si l'IP client
      réelle est exigée (§11)
- [ ] Dépôt de `cameras.json` dans le volume `securisite_cameras` si des
      caméras réelles existent, puis redémarrage du conteneur `app` (§12,
      `docs/production-coolify.md` §7)

### D. À migrer
- [x] Outillage prêt et vérifié : `scripts/provision-production-db.sh`
      (rôles OWNER/MIGRATOR/APP + migrations 001→010, §3/§6)
- [ ] Sans objet : import de données existantes (base neuve confirmée)
- [x] Outillage prêt et vérifié : `scripts/create-first-admin.sh`
      (compte + membership SOC, §7)
- [ ] **Exécution réelle sur le serveur** — non faite (accès serveur requis)

### E. À démarrer
- [x] `docker-compose.prod.yml` prêt (db/migrate/app, §18) — vérifié en local
- [ ] **Démarrage réel sur le serveur** — non fait (accès serveur requis)

### F. À tester
- [x] Suite automatisée (982 tests) — déjà verte sur `main` (§19)
- [x] Séquence complète vérifiée en local jetable : provisioning → migrations
      → admin → login réel → `GET /api/alerts` 200 (§19)
- [ ] Smoke HTTP réel contre `https://security.irongs.com` — à rejouer une
      fois le serveur réel accessible (§19)
- [ ] PWA installable (nécessite HTTPS réel, §11/§14)

### G. Rollback
- [x] Procédure et script de sauvegarde/restauration prêts et vérifiés (§9)
- [x] Compatibilité de version applicative documentée (§10 — attention aux
      migrations 005 et 009)
- [x] Procédure d'arrêt/reprise documentée (§20)

---

## 21. Informations que je ne peux pas connaître — à fournir

Résolu par ce tour et le précédent : hébergement (serveur dédié), domaine
(`security.irongs.com`), données existantes (aucune, base neuve),
plateforme (Coolify). Restant :

- **Accès SSH / accès à l'infrastructure cible, ou au terminal Coolify de
  la ressource** : je n'ai aucun accès réseau à ce serveur — toute
  exécution réelle des commandes/scripts de ce plan devra être faite par
  vous, une fois les secrets en place.
- **PostgreSQL** : conteneurisé dans ce même compose (modèle par défaut de
  ce plan) ou instance managée séparée ? Version disponible si séparée.
- **Secrets** : gestionnaire de secrets du serveur (fichier `.env` local
  suffit-il, ou un coffre-fort de secrets est-il déjà en place) — aucun
  secret réel n'a été ni ne sera généré ou demandé dans ce chat.
- **Configuration caméra** : URL/identifiants des caméras physiques
  réelles, et le tenant/site/zone réel de chacune (`GET /api/... tenants`
  une fois la base provisionnée, pour connaître les identifiants réels).
- **Fournisseur push/IA réel** : à activer un jour ou rester fake/local
  indéfiniment ? Si activation prévue, quel fournisseur (§15) ?
- **Contrainte de conformité sur l'IP client réelle** dans les journaux
  d'audit (`trust proxy`, §11) — s'applique-t-elle ici ?
- **Fenêtre de bascule / gel de service acceptable** pour la mise en
  production initiale.

---

**PRODUCTION PRÊTE À ÊTRE CONFIGURÉE — INFORMATIONS HUMAINES REQUISES**
