# SécuriSite — déploiement Coolify (security.irongs.com)

Coolify confirmé comme plateforme cible. Ce document remplace, pour ce
qui concerne le reverse proxy, `docs/production-reverse-proxy.md` (gardé
pour référence générale SSE/timeout, utile si Coolify change un jour) :
**aucun Nginx/Caddy/Traefik n'est déclaré dans `docker-compose.prod.yml`**
— Coolify gère domaine, HTTPS, certificat et reverse proxy lui-même, à
partir du port que vous lui indiquez dans son interface.

## Architecture

```
GitHub (main) ──► Coolify (build + déploie docker-compose.prod.yml)
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
        db          migrate           app  ◄── Coolify route
   (PostgreSQL 16   (une exécution,   (port 3000 interne,      security.irongs.com
    volume nommé     rôle MIGRATOR,    healthcheck /api/ready,      ici (HTTPS,
    persistant,      bloque app tant   volume caméra nommé          certificat,
    aucun port       qu'elle n'a pas   persistant)                  Traefik : gérés
    public)          réussi)                                        par Coolify)
```

`db`/`migrate`/`app` communiquent via le réseau `internal` déclaré dans
`docker-compose.prod.yml`. Coolify attache **lui-même** son propre réseau
de routage à `app` au déploiement (jamais déclaré à la main ici — le nom
exact dépend de l'installation Coolify et n'a pas besoin d'être connu).

## 1. Compatibilité SSE/realtime avec le proxy Coolify

Coolify (v4) route le trafic via un Traefik qu'il gère — Traefik ne
bufferise pas les réponses en streaming par défaut (contrairement à
certaines configurations Nginx par défaut), donc `/api/realtime/stream`
devrait fonctionner sans réglage supplémentaire. **À vérifier une fois le
domaine actif** (aucune connexion au serveur faite pour produire ce
document) :

```
curl -N -H "Authorization: Bearer <token réel>" \
  https://security.irongs.com/api/realtime/stream
```

La connexion doit rester ouverte, un commentaire `:heartbeat` doit
apparaître toutes les 15 secondes, sans que la commande ne se termine ni
ne bloque en silence jusqu'à un timeout. Si Coolify expose un réglage de
timeout de proxy par ressource (versions récentes), s'assurer qu'il est
supérieur à quelques minutes — sinon signaler l'écart pour ajustement.

Rappel structurel (inchangé, indépendant du proxy) : un seul conteneur
`app` — le bus temps réel (`backend/realtime.js`) est en mémoire,
mono-processus. Ne jamais faire tourner deux instances `app` derrière la
même route Coolify sans upgrade préalable (PostgreSQL LISTEN/NOTIFY, non
construit ici) — `docs/realtime.md`.

## 2. Variables à créer dans Coolify (aucune valeur réelle ici)

Déclarées dans l'onglet **Environment Variables** de la ressource
Coolify — liste complète et commentée : `.env.production.example`.

| Variable | Rôle |
|---|---|
| `POSTGRES_USER` | superutilisateur du cluster `db` — bootstrap des rôles uniquement |
| `POSTGRES_PASSWORD` | idem |
| `SECURISITE_DB_NAME` | nom de la base (défaut `securisite`) |
| `SECURISITE_OWNER_ROLE` | défaut `securisite_owner` (NOLOGIN) |
| `SECURISITE_MIGRATOR_ROLE` | défaut `securisite_migrator` |
| `SECURISITE_MIGRATOR_PASSWORD` | mot de passe du rôle MIGRATOR |
| `SECURISITE_APP_ROLE` | défaut `securisite_app` |
| `SECURISITE_APP_PASSWORD` | mot de passe du rôle APP — **le seul utilisé par le runtime** |
| `PGSSL` | `disable` (PostgreSQL colocalisé dans ce même compose) |
| `JWT_SECRET` | ≥32 caractères aléatoires réels |
| `ALLOWED_ORIGIN` | laisser vide (même domaine pour API et frontend) |
| `SECURISITE_ADMIN_USERNAME` | défaut `admin` |
| `SECURISITE_ADMIN_PASSWORD` | mot de passe du premier administrateur |
| `IMAGE_TAG` | optionnel, défaut `latest` |

`DATABASE_URL` n'est **pas** une variable Coolify séparée : composée
automatiquement dans `docker-compose.prod.yml` à partir des rôles/mots de
passe ci-dessus, pour chaque service (`migrate` avec MIGRATOR, `app` avec
APP) — une seule source de vérité par mot de passe, jamais recopié à la
main dans une URL.

## 3. Port applicatif à configurer dans Coolify

`app` écoute sur `3000` (interne — `expose: ["3000"]` dans le compose,
jamais publié sur l'hôte). Dans l'interface Coolify, assigner le domaine
`security.irongs.com` au service **`app`**, port **`3000`** — c'est ce
mapping (domaine → service → port), fait dans l'UI Coolify, qui remplace
entièrement ce qu'un Nginx/Traefik écrit à la main ferait ailleurs.

## 4. Volumes — persistance à travers un redéploiement

Deux volumes nommés déclarés dans `docker-compose.prod.yml` :
`securisite_pgdata` (données PostgreSQL) et `securisite_cameras`
(configuration caméra, §7 ci-dessous). Les volumes nommés Docker
survivent normalement à un redéploiement Coolify (nouvelle image
applicative construite et démarrée, le volume n'est pas recréé) — **à
vérifier une fois dans l'interface Coolify** (onglet Stockage de chaque
service) qu'aucune option de la ressource ne les marque comme éphémères
ou ne les recrée à chaque déploiement (aucun accès serveur pour le
confirmer depuis ce document).

## 5. Ordre exact du premier déploiement

1. **Créer la ressource Coolify** : nouvelle application, source GitHub
   (dépôt SécuriSite, branche `main`), type **Docker Compose**, fichier
   `docker-compose.prod.yml`.
2. **Renseigner toutes les variables** (§2) dans l'onglet Environment
   Variables — aucune valeur par défaut sensible, tout doit être rempli
   avant le premier déploiement.
3. **Assigner le domaine** `security.irongs.com` au service `app`, port
   `3000` (§3).
4. **Premier déploiement partiel** : démarrer uniquement `db` (Coolify
   permet généralement de cibler un service, sinon laisser `migrate`
   échouer une première fois est sans risque — il ne fait qu'attendre
   `db`, aucune donnée n'est en jeu). Attendre que `db` soit *Healthy*.
5. **Provisioning rôles + base** (une fois, depuis le terminal Coolify de
   la ressource ou en SSH) :
   ```
   ./scripts/provision-production-db.sh
   ```
6. **Migrations 001→010** — soit via le déploiement normal (le service
   `migrate` du compose s'exécute automatiquement avant `app`), soit
   explicitement :
   ```
   docker compose -f docker-compose.prod.yml up migrate
   ```
7. **Premier administrateur** (une fois) :
   ```
   ./scripts/create-first-admin.sh
   ```
8. **Démarrage applicatif** : déploiement complet depuis Coolify (bouton
   *Deploy*) — démarre/redémarre `app`, qui attend `db` sain et `migrate`
   réussi (`depends_on`, §"Vérifications" ci-dessous).
9. **Readiness** : Coolify ne doit marquer le déploiement réussi (bascule
   du trafic) qu'après que le healthcheck Docker de `app` passe au vert —
   voir §6.
10. **Domaine HTTPS** : Coolify émet/renouvelle le certificat pour
    `security.irongs.com` automatiquement une fois le domaine assigné et
    le service en ligne — vérifier `https://security.irongs.com/api/health`
    répond `200` avec un certificat valide.
11. **Smoke tests** (§8).

## 6. Coolify ne doit jamais marquer "healthy" avant `/api/ready`

Déjà garanti structurellement : `app` déclare un `healthcheck:` Docker
natif (`wget -qO- http://localhost:3000/api/ready || exit 1`) — Coolify,
comme tout orchestrateur basé sur l'état de santé Docker, lit **cet état
Docker natif**, pas un simple "le process a démarré". `/api/ready` fait un
aller-retour PostgreSQL réel (`backend/health.js`) : un conteneur qui
démarre mais dont la base devient injoignable ensuite est détecté (503,
healthcheck rouge), jamais annoncé sain à tort. Vérifié en local (§"Preuve"
plus bas) : `app` reste "starting" jusqu'à ce que `migrate` ait réussi et
que PostgreSQL réponde, jamais marqué sain avant.

## 7. Configuration caméra — volume persistant, hors Git

`docker-compose.prod.yml` monte un volume nommé `securisite_cameras` sur
`app`, et fixe `SECURISITE_CAMERAS_CONFIG_FILE=/run/securisite/cameras/cameras.json`
en permanence. **Vide au premier déploiement** (aucun fichier dedans) :
`backend/camera-registry.js` traite un fichier absent comme "aucune
caméra" — registre vide, fail-closed, **jamais une erreur** (corrigé et
testé pendant cette préparation — vérifié aussi en conditions réelles :
`GET /api/camera/list` répond `200 []`, jamais 500, sur un volume vide).

Pour déclarer des caméras réelles : déposer un `cameras.json` (format,
`docs/camera-proxy.md`) dans ce volume — via le terminal Coolify de la
ressource, ou `docker cp cameras.json <conteneur_app>:/run/securisite/cameras/cameras.json`
en SSH. **Redémarrer ensuite le conteneur `app`** (bouton Restart Coolify)
— le registre est chargé une seule fois au démarrage et mis en cache,
vérifié explicitement : déposer le fichier à chaud sans redémarrer n'a
aucun effet.

## 8. Smoke tests après déploiement

Mêmes deux couches que pour le staging (`docs/production-readiness-plan.md`
§19), à rejouer contre `https://security.irongs.com` une fois le domaine
actif : suite automatisée (`node --test tests/*.test.js`, jamais contre la
base production) et smoke HTTP réel (login, dashboard, incident → alerte
auto, badges, cycle de vie complet d'une alerte, SOS, realtime, PWA,
caméra si configurée, IA locale, audit admin, négatifs).

## 9. Push / IA

Inchangés, fake/local (`backend/push/fake-provider.js`,
`LocalAIProvider`) — aucune variable Coolify à ajouter pour l'instant.
Activation future = décision humaine séparée (`docs/push.md`, `docs/ai.md`).

## 10. Stratégie de sauvegarde compatible Coolify (préparée, non exécutée)

`scripts/backup-production.sh` (existant, vérifié par un cycle réel
sauvegarde → `pg_restore --list`) fonctionne à l'identique sous Coolify —
à lancer depuis le terminal Coolify de la ressource, ou en SSH. Point
Coolify spécifique : écrire les fichiers de sauvegarde **en dehors** du
volume `securisite_pgdata` et en dehors du répertoire de checkout que
Coolify peut recréer à chaque déploiement — soit un volume Coolify dédié
supplémentaire (à ajouter dans `docker-compose.prod.yml` si retenu, non
fait ici faute de connaître l'espace disque/la politique de rétention
réels du serveur), soit un chemin hôte fixe hors de la gestion de Coolify.
**Aucun backup n'a été exécuté contre un environnement réel** — la
commande reste `./scripts/backup-production.sh` une fois `SECURISITE_BACKUP_DIR`
pointé vers un emplacement réellement persistant.

## 11. Arrêt / redéploiement

- **Redéploiement Coolify normal** (nouveau commit sur `main`) : rejoue
  `migrate` (idempotent, "aucune" migration si déjà à jour) puis remplace
  `app` — bascule sans interruption grâce au healthcheck (§6), jamais un
  arrêt brutal de l'ancienne version avant que la nouvelle soit prête.
- **Arrêt manuel** : `SIGTERM` (Coolify l'envoie normalement lui-même à
  l'arrêt/au redéploiement d'un service) — `server.js#start()` gère
  l'ordre : plus de nouveau cycle → attend le cycle en cours (10 s max) →
  ferme l'écoute HTTP → ferme le pool PostgreSQL en dernier
  (`docs/postgresql-deployment.md` §7).
- **`db`** : `restart: unless-stopped` — redémarre seul après un
  redémarrage du serveur hôte ; les données survivent (volume nommé, §4).

## Preuve (avant ce déploiement, jamais contre un serveur réel)

Séquence complète vérifiée sur un déploiement Docker local jetable,
démonté ensuite : build → `db` sain → `provision-production-db.sh` →
`migrate` → `app` sain (healthcheck `/api/ready`) → `create-first-admin.sh`
→ login réel → `GET /api/alerts` 200 → `GET /api/camera/list` 200 `[]`
(volume caméra vide, aucune erreur) → dépôt d'un `cameras.json` dans le
volume → confirmé sans effet à chaud → redémarrage du conteneur → caméra
visible. Aucune connexion à `security.irongs.com` ni au serveur réel.
