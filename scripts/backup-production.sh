#!/usr/bin/env bash
# SécuriSite — sauvegarde PostgreSQL production (pg_dump -Fc, via l'outil
# testé backend/db/postgresql/backup.js — jamais un pg_dump nu, pour
# garder les mêmes garanties que le runbook, docs/postgresql-backup-restore.md).
#
# N'exécute rien tout seul : à déclencher manuellement, ou par une tâche
# planifiée existante sur le serveur (cron/systemd timer — non installée
# par ce script). Chaque appel écrit un fichier daté et purge les
# sauvegardes plus vieilles que SECURISITE_BACKUP_RETENTION_DAYS (7 par
# défaut) dans le même répertoire.
#
# Exemple de tâche planifiée (à ajouter manuellement, jamais par ce
# dépôt) :
#   0 3 * * * cd /opt/securisite && ./scripts/backup-production.sh >> /var/log/securisite-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

: "${SECURISITE_MIGRATOR_ROLE:=securisite_migrator}"
: "${SECURISITE_MIGRATOR_PASSWORD:?SECURISITE_MIGRATOR_PASSWORD requis}"
: "${SECURISITE_DB_NAME:=securisite}"
: "${PGSSL:=disable}"
: "${SECURISITE_BACKUP_DIR:=$(pwd)/backups}"
: "${SECURISITE_BACKUP_RETENTION_DAYS:=7}"

mkdir -p "$SECURISITE_BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="securisite-${STAMP}.dump"

echo "[backup] écriture de ${SECURISITE_BACKUP_DIR}/${FILE}…"
"${COMPOSE[@]}" run --rm --no-deps \
  -v "${SECURISITE_BACKUP_DIR}:/backups" \
  -e DATABASE_URL="postgres://${SECURISITE_MIGRATOR_ROLE}:${SECURISITE_MIGRATOR_PASSWORD}@db:5432/${SECURISITE_DB_NAME}" \
  -e PGSSL="$PGSSL" \
  app node backend/db/postgresql/backup-cli.js "/backups/${FILE}"

SIZE="$(du -h "${SECURISITE_BACKUP_DIR}/${FILE}" 2>/dev/null | cut -f1)"
echo "[backup] terminé : ${FILE} (${SIZE:-taille inconnue})"

echo "[backup] purge des sauvegardes de plus de ${SECURISITE_BACKUP_RETENTION_DAYS} jour(s)…"
find "$SECURISITE_BACKUP_DIR" -maxdepth 1 -name 'securisite-*.dump' -mtime "+${SECURISITE_BACKUP_RETENTION_DAYS}" -print -delete

echo "[backup] restauration : voir docs/postgresql-backup-restore.md — jamais sans validation humaine explicite de la cible."
