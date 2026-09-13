'use strict';
/**
 * PG-18 — health/readiness HTTP, distincts et non authentifiés (sondes
 * d'orchestration standard : health-check Docker/k8s, load balancer).
 *
 * GET /api/health (liveness) : le processus répond, sans aucune dépendance
 * externe — jamais bloqué par PostgreSQL. Une sonde de vivacité qui
 * dépendrait de la base ferait redémarrer le processus pour un problème qui
 * n'est PAS le sien (confusion classique liveness/readiness).
 *
 * GET /api/ready (readiness) : un aller-retour PostgreSQL minimal
 * (SELECT 1) — pas l'audit exhaustif de schéma/permissions/RLS
 * (backend/db/postgresql/readiness.js#assertReady, déjà exécuté une fois au
 * démarrage et bloquant avant toute écoute HTTP, voir server.js). Une sonde
 * interrogée en continu (souvent chaque seconde par un orchestrateur) ne
 * doit pas répéter un audit coûteux à chaque appel — seulement confirmer
 * que la connexion est toujours vivante.
 *
 * Aucune authentification : ce sont des sondes d'infrastructure, jamais des
 * routes métier. Aucun détail technique renvoyé (jamais un message
 * d'erreur PostgreSQL) — seulement `status`.
 */
const express = require('express');
const db = require('./database');
const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok' }));

router.get('/ready', (req, res) => {
  db.query('SELECT 1')
    .then(() => res.json({ status: 'ready' }))
    .catch(() => res.status(503).json({ status: 'unavailable' }));
});

module.exports = router;
