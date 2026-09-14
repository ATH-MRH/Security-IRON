#!/usr/bin/env bash
# SécuriSite — provisioning initial de la base production (rôles + base +
# migrations). À exécuter UNE SEULE FOIS, sur le serveur cible, avant le
# tout premier `docker compose -f docker-compose.prod.yml up -d app`.
# Réexécutable sans dommage (chaque étape est idempotente ou vérifiée),
# mais n'a besoin d'être lancé qu'une fois par base neuve.
#
# Encode exactement la procédure documentée
# (docs/postgresql-deployment.md §1-§2), y compris un piège rencontré et
# corrigé pendant la mise en place du staging local : la base cible DOIT
# être créée avec OWNER=securisite_owner (jamais le superutilisateur),
# sinon les GRANT du rôle MIGRATOR échouent ensuite ("permission denied
# for database"). Corrige aussi un effet de bord découvert au même
# moment : la première passe de provisioning (avant que la base cible
# existe) tourne forcément contre la base `postgres` neutre du cluster, et
# y révoque CONNECT pour PUBLIC comme effet de bord (REVOKE ALL ON
# DATABASE ... FROM PUBLIC, dans backend/db/postgresql/provision-roles.js)
# — restauré explicitement ici pour ne jamais laisser la base
# administrative `postgres` dans un état modifié.
#
# Ne fait PLUS de second passage de GRANT après les migrations (superuser) :
# backend/db/postgresql/migrate-cli.js le fait désormais lui-même,
# automatiquement, avec la connexion MIGRATOR (voir provision-roles.js
# #finalizeGrants) — corrige le piège production où cette étape, seulement
# manuelle, était facile à oublier (APP se retrouvait sans USAGE/SELECT/
# EXECUTE sur securisite_meta → 42501 sur alerts/incidents/visiteurs/
# notifications/realtime malgré /api/ready au vert).
#
# Prérequis (Coolify) :
#   - Le service `db` de la stack Coolify est démarré et "Healthy" dans
#     l'interface (équivaut à `docker compose up -d db`).
#   - Toutes les variables d'environnement (voir .env.production.example)
#     sont déjà renseignées côté Coolify (onglet "Environment Variables"
#     de la ressource) — Coolify les injecte dans l'environnement des
#     conteneurs, donc dans celui-ci si vous l'exécutez depuis le terminal
#     Coolify de la ressource ; sinon, les exporter manuellement dans le
#     shell avant de lancer ce script.
#   - À exécuter depuis le terminal Coolify de la ressource (onglet
#     "Terminal"), ou en SSH sur le serveur dans le répertoire où Coolify a
#     cloné ce dépôt (`docker compose -f docker-compose.prod.yml ps` doit y
#     fonctionner tel quel).
#   - Ce script ne demande, n'affiche et ne journalise AUCUN secret.
#
# N'EST PAS exécuté automatiquement par Coolify ni par CI — action humaine
# explicite requise, sur le serveur réel, une fois les secrets en place.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD requis (dans .env, jamais en argument de commande)}"
: "${SECURISITE_DB_NAME:=securisite}"
: "${SECURISITE_OWNER_ROLE:=securisite_owner}"
: "${SECURISITE_MIGRATOR_ROLE:=securisite_migrator}"
: "${SECURISITE_MIGRATOR_PASSWORD:?SECURISITE_MIGRATOR_PASSWORD requis}"
: "${SECURISITE_APP_ROLE:=securisite_app}"
: "${SECURISITE_APP_PASSWORD:?SECURISITE_APP_PASSWORD requis}"
: "${PGSSL:=disable}"

echo "[provision] 1/5 — vérification que 'db' est prêt…"
"${COMPOSE[@]}" exec -T db pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null \
  || { echo "[provision] ERREUR : le service 'db' n'est pas prêt — lancer d'abord : docker compose -f $COMPOSE_FILE up -d db" >&2; exit 1; }

echo "[provision] 2/5 — création des rôles OWNER/MIGRATOR/APP (base neutre 'postgres')…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/postgres" \
  -e PGSSL="$PGSSL" \
  -e SECURISITE_OWNER_ROLE -e SECURISITE_MIGRATOR_ROLE -e SECURISITE_APP_ROLE \
  -e SECURISITE_MIGRATOR_PASSWORD -e SECURISITE_APP_PASSWORD \
  app node backend/db/postgresql/provision-roles.js

echo "[provision] 3/5 — restauration de l'état de la base 'postgres' (effet de bord de l'étape précédente)…"
"${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
  psql -h db -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "GRANT CONNECT, TEMP ON DATABASE postgres TO PUBLIC;"

echo "[provision] 4/5 — création de la base '${SECURISITE_DB_NAME}' (OWNER=${SECURISITE_OWNER_ROLE})…"
DB_EXISTS="$("${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
  psql -h db -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${SECURISITE_DB_NAME}'" | tr -d '[:space:]')"
if [ "$DB_EXISTS" = "1" ]; then
  echo "[provision]     déjà présente, inchangée."
else
  "${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db \
    psql -h db -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${SECURISITE_DB_NAME}\" OWNER \"${SECURISITE_OWNER_ROLE}\";"
fi

echo "[provision] 5/5 — migrations 001->010 (rôle MIGRATOR) puis GRANT runtime d'APP…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e DATABASE_URL="postgres://${SECURISITE_MIGRATOR_ROLE}:${SECURISITE_MIGRATOR_PASSWORD}@db:5432/${SECURISITE_DB_NAME}" \
  -e PGSSL="$PGSSL" \
  -e SECURISITE_OWNER_ROLE -e SECURISITE_APP_ROLE \
  app node backend/db/postgresql/migrate-cli.js

echo "[provision] terminé. Prochaine étape : ./scripts/create-first-admin.sh puis docker compose -f $COMPOSE_FILE up -d app"
