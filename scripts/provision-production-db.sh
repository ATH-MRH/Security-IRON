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
# Prérequis :
#   - `docker compose -f docker-compose.prod.yml up -d db` déjà lancé et
#     en bonne santé (`docker compose ps` -> db "healthy").
#   - `.env` (à côté de ce script, jamais committé) rempli avec de vrais
#     secrets — voir .env.production.example.
#   - Ce script ne demande, n'affiche et ne journalise AUCUN secret.
#
# N'EST PAS exécuté automatiquement par ce dépôt ni par CI — action
# humaine explicite requise, sur le serveur réel, une fois les secrets en
# place.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

: "${POSTGRES_SUPERUSER:=postgres}"
: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD requis (dans .env, jamais en argument de commande)}"
: "${SECURISITE_DB_NAME:=securisite}"
: "${SECURISITE_OWNER_ROLE:=securisite_owner}"
: "${SECURISITE_MIGRATOR_ROLE:=securisite_migrator}"
: "${SECURISITE_MIGRATOR_PASSWORD:?SECURISITE_MIGRATOR_PASSWORD requis}"
: "${SECURISITE_APP_ROLE:=securisite_app}"
: "${SECURISITE_APP_PASSWORD:?SECURISITE_APP_PASSWORD requis}"
: "${PGSSL:=disable}"

echo "[provision] 1/6 — vérification que 'db' est prêt…"
"${COMPOSE[@]}" exec -T db pg_isready -U "$POSTGRES_SUPERUSER" -d postgres >/dev/null \
  || { echo "[provision] ERREUR : le service 'db' n'est pas prêt — lancer d'abord : docker compose -f $COMPOSE_FILE up -d db" >&2; exit 1; }

echo "[provision] 2/6 — création des rôles OWNER/MIGRATOR/APP (base neutre 'postgres')…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://${POSTGRES_SUPERUSER}:${POSTGRES_SUPERUSER_PASSWORD}@db:5432/postgres" \
  -e PGSSL="$PGSSL" \
  -e SECURISITE_OWNER_ROLE -e SECURISITE_MIGRATOR_ROLE -e SECURISITE_APP_ROLE \
  -e SECURISITE_MIGRATOR_PASSWORD -e SECURISITE_APP_PASSWORD \
  app node backend/db/postgresql/provision-roles.js

echo "[provision] 3/6 — restauration de l'état de la base 'postgres' (effet de bord de l'étape précédente)…"
"${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" db \
  psql -h db -U "$POSTGRES_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "GRANT CONNECT, TEMP ON DATABASE postgres TO PUBLIC;"

echo "[provision] 4/6 — création de la base '${SECURISITE_DB_NAME}' (OWNER=${SECURISITE_OWNER_ROLE})…"
DB_EXISTS="$("${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" db \
  psql -h db -U "$POSTGRES_SUPERUSER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${SECURISITE_DB_NAME}'" | tr -d '[:space:]')"
if [ "$DB_EXISTS" = "1" ]; then
  echo "[provision]     déjà présente, inchangée."
else
  "${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" db \
    psql -h db -U "$POSTGRES_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${SECURISITE_DB_NAME}\" OWNER \"${SECURISITE_OWNER_ROLE}\";"
fi

echo "[provision] 5/6 — migrations 001->010 (rôle MIGRATOR)…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e DATABASE_URL="postgres://${SECURISITE_MIGRATOR_ROLE}:${SECURISITE_MIGRATOR_PASSWORD}@db:5432/${SECURISITE_DB_NAME}" \
  -e PGSSL="$PGSSL" \
  app node backend/db/postgresql/migrate-cli.js

echo "[provision] 6/6 — finalisation des GRANT (schéma désormais présent)…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://${POSTGRES_SUPERUSER}:${POSTGRES_SUPERUSER_PASSWORD}@db:5432/${SECURISITE_DB_NAME}" \
  -e PGSSL="$PGSSL" \
  -e SECURISITE_OWNER_ROLE -e SECURISITE_MIGRATOR_ROLE -e SECURISITE_APP_ROLE \
  -e SECURISITE_MIGRATOR_PASSWORD -e SECURISITE_APP_PASSWORD \
  app node backend/db/postgresql/provision-roles.js

echo "[provision] terminé. Prochaine étape : ./scripts/create-first-admin.sh puis docker compose -f $COMPOSE_FILE up -d app"
