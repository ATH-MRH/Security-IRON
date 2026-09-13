#!/usr/bin/env bash
# SécuriSite — création du premier administrateur production, avec un
# véritable accès SOC (pas seulement /api/admin/*). Chaîne les deux outils
# existants (aucun mot de passe codé en dur ; SECURISITE_ADMIN_PASSWORD
# vient de l'environnement/.env, jamais d'un argument de commande ni de ce
# script) :
#   1. backend/db/postgresql/create-admin.js       — crée le compte
#   2. backend/db/postgresql/bootstrap-admin-membership.js — lui donne un
#      membership SOC (scope) réel, sans quoi il ne verrait jamais le
#      tableau de bord/les alertes/les incidents (scope.requireScope()).
#
# Idempotent : rejouable sans risque (les deux étapes le sont).
# À exécuter APRÈS scripts/provision-production-db.sh (rôles + migrations),
# depuis le terminal Coolify de la ressource (ou en SSH sur le serveur,
# dans le répertoire où Coolify a cloné ce dépôt) — mêmes prérequis que
# scripts/provision-production-db.sh. N'affiche ni ne journalise aucun
# secret au-delà de ce que create-admin.js affiche déjà lui-même (rien :
# il ne journalise jamais le mot de passe).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

: "${SECURISITE_MIGRATOR_ROLE:=securisite_migrator}"
: "${SECURISITE_MIGRATOR_PASSWORD:?SECURISITE_MIGRATOR_PASSWORD requis}"
: "${SECURISITE_DB_NAME:=securisite}"
: "${SECURISITE_ADMIN_USERNAME:=admin}"
: "${SECURISITE_ADMIN_PASSWORD:?SECURISITE_ADMIN_PASSWORD requis (dans .env, jamais en argument de commande)}"
: "${PGSSL:=disable}"

DATABASE_URL="postgres://${SECURISITE_MIGRATOR_ROLE}:${SECURISITE_MIGRATOR_PASSWORD}@db:5432/${SECURISITE_DB_NAME}"

echo "[create-first-admin] 1/2 — compte…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PGSSL="$PGSSL" \
  -e SECURISITE_ADMIN_PASSWORD \
  app node backend/db/postgresql/create-admin.js "$SECURISITE_ADMIN_USERNAME"

echo "[create-first-admin] 2/2 — membership SOC…"
"${COMPOSE[@]}" run --rm --no-deps \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PGSSL="$PGSSL" \
  app node backend/db/postgresql/bootstrap-admin-membership.js "$SECURISITE_ADMIN_USERNAME"

echo "[create-first-admin] terminé."
