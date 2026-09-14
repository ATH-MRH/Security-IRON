#!/bin/sh
# SécuriSite — création du premier administrateur production, avec un
# véritable accès SOC (pas seulement /api/admin/*). Lance
# backend/db/postgresql/create-first-admin-cli.js, qui chaîne dans un seul
# processus Node create-admin.js (compte) puis bootstrap-admin-membership.js
# (membership SOC, sans quoi le compte ne verrait jamais le tableau de
# bord/les alertes/les incidents — scope.requireScope()).
#
# Idempotent : rejouable sans risque.
#
# Portable POSIX sh (pas de bashisme) : utilisable tel quel avec `sh` ou
# `bash`. Nécessite `docker compose`, donc un shell HÔTE (ou tout shell ayant
# accès au socket Docker) — pas le conteneur applicatif lui-même (image
# node:22-alpine, sans docker compose). Si le seul terminal disponible est
# DANS le conteneur `app` (rencontré sur le premier déploiement Coolify :
# aucun accès docker compose ni bash à cet endroit), lancer directement,
# avec `sh`, le fichier que ce script invoque :
#   export DATABASE_URL='postgres://securisite_migrator:...@db:5432/securisite'
#   export SECURISITE_ADMIN_PASSWORD='...'
#   node backend/db/postgresql/create-first-admin-cli.js "$SECURISITE_ADMIN_USERNAME"
#
# À exécuter APRÈS scripts/provision-production-db.sh (rôles + migrations),
# depuis le terminal Coolify de la ressource (ou en SSH sur le serveur, dans
# le répertoire où Coolify a cloné ce dépôt) — mêmes prérequis que
# scripts/provision-production-db.sh. N'affiche ni ne journalise aucun secret
# (SECURISITE_ADMIN_PASSWORD vient de l'environnement/.env, jamais d'un
# argument de commande ni de ce script).
set -eu
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

: "${SECURISITE_MIGRATOR_ROLE:=securisite_migrator}"
: "${SECURISITE_MIGRATOR_PASSWORD:?SECURISITE_MIGRATOR_PASSWORD requis}"
: "${SECURISITE_DB_NAME:=securisite}"
: "${SECURISITE_ADMIN_USERNAME:=admin}"
: "${SECURISITE_ADMIN_PASSWORD:?SECURISITE_ADMIN_PASSWORD requis (dans .env, jamais en argument de commande)}"
: "${PGSSL:=disable}"

DATABASE_URL="postgres://${SECURISITE_MIGRATOR_ROLE}:${SECURISITE_MIGRATOR_PASSWORD}@db:5432/${SECURISITE_DB_NAME}"

echo "[create-first-admin] compte + membership SOC…"
compose run --rm --no-deps \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PGSSL="$PGSSL" \
  -e SECURISITE_ADMIN_PASSWORD \
  app node backend/db/postgresql/create-first-admin-cli.js "$SECURISITE_ADMIN_USERNAME"

echo "[create-first-admin] terminé."
