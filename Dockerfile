FROM node:22-alpine

WORKDIR /app

# pg_dump/pg_restore : nécessaires à backend/db/postgresql/backup.js et
# restore.js (backup/restore production, docs/postgresql-backup-restore.md)
# — ils exécutent ces binaires directement (child_process.spawn), absents
# de l'image node:22-alpine de base. Version alignée sur le cluster
# PostgreSQL 16 utilisé partout dans ce dépôt (migrations, tests, staging).
RUN apk add --no-cache postgresql16-client

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

ENV NODE_ENV=production
EXPOSE 3000
USER node

CMD ["node", "server.js"]
