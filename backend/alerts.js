const express = require('express');
const service = require('./alert-core/service');
const scope = require('./scope');
const { sendError } = require('./http-errors');
const router = express.Router();

// Express 4 ne relaie pas les rejets d'une promesse : chaque handler async est encapsulé.
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.use(wrap(async (req, res, next) => {
  const user = await service.currentUser(req.user.id);
  if (!user) return res.status(401).json({ error: 'Session révoquée' });
  req.user = user; next();
}));
// PG-8 : le périmètre (memberships actifs PG-7) remplace le rôle brut comme
// autorité. own/scope pilote la visibilité (service.js) ; le rôle memberships
// « soc » pilote les actions réservées — jamais une exception username/role JWT.
// security_alerts ne porte aucune colonne site/zone : l'accès est résolu au
// niveau du tenant dans son ensemble (voir backend/scope.js#tenantAccess).
router.use(wrap(async (req, res, next) => {
  const s = await scope.resolveScope(req.user.id);
  const tenantId = s.resolveTenant();
  if (!s.hasAccess || tenantId == null) return res.status(403).json({ error: 'Accès au périmètre refusé' });
  req.user.alertAccess = s.tenantAccess(tenantId);
  req.user.isSoc = s.hasRole(tenantId, 'soc');
  next();
}));
const admin = (req, res, next) => req.user.isSoc ? next() : res.status(403).json({ error: 'Action réservée au SOC (administrateur)' });
router.get('/rules', admin, wrap(async (req, res) => res.json(await service.config())));
router.put('/rules', admin, wrap(async (req, res) => res.json(await service.updateRules(req.body, req.user))));
router.get('/rules/audit', admin, wrap(async (req, res) => res.json(await service.configAudit())));
router.get('/notifications', wrap(async (req, res) => res.json(await service.notifications(req.user.id))));
router.post('/notifications/:id/read', wrap(async (req, res) => res.json(await service.readNotification(req.params.id, req.user))));
router.get('/', wrap(async (req, res) => res.json(await service.list(req.user))));
router.post('/', wrap(async (req, res) => res.status(201).json(await service.create(req.body, req.user))));
router.get('/:id', wrap(async (req, res) => res.json(await service.detail(req.params.id, req.user))));
router.post('/:id/actions', wrap(async (req, res) => res.json(await service.act(req.params.id, req.body, req.user))));
router.use((req, res) => res.status(404).json({ error: 'Route Alert Core introuvable' }));

// Mapping transport unifié (backend/http-errors.js) : métier verbatim ; conflit
// transitoire PostgreSQL ou expiration de verrou Alert Core -> 503 rejouable ;
// schéma/config Alert Core indisponible -> 503 ; tout le reste -> 500 générique.
// Terminal : ne rappelle jamais next(err), donc n'atteint pas le gestionnaire global.
router.use((err, req, res, next) => { // signature à 4 arguments : gestionnaire d'erreurs Express
  sendError(res, err, 'ALERTS');
});

// Preserve the integration entry points used by server.js and backend/routes.js.
const { init, create, escalateDue, fromIncident, fromBadge } = service;
module.exports = { router, init, create, escalateDue, fromIncident, fromBadge };
