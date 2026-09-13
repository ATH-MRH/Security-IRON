const express = require('express');
const service = require('./alert-core/service');
const scope = require('./scope');
const securityAudit = require('./security-audit');
const { sendError } = require('./http-errors');
const router = express.Router();

// Express 4 ne relaie pas les rejets d'une promesse : chaque handler async est encapsulé.
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
// PG-10 : dénis explicites audités en best-effort (jamais de blocage
// supplémentaire si le journal est momentanément indisponible).
const auditDenied = (req, resourceType, actorUserId, detail) => securityAudit.recordBestEffort({
  requestId: req.requestId || null, origin: 'http',
  actorUserId: actorUserId ?? null,
  eventType: resourceType === 'session' ? 'auth.session.revoked' : 'auth.access.denied',
  resourceType, action: 'access', outcome: 'denied',
  ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null, detail,
});

router.use(wrap(async (req, res, next) => {
  const claimedId = req.user.id;
  const user = await service.currentUser(claimedId);
  if (!user) { await auditDenied(req, 'session', claimedId); return res.status(401).json({ error: 'Session révoquée' }); }
  req.user = user; next();
}));
// PG-8 : le périmètre (memberships actifs PG-7) remplace le rôle brut comme
// autorité. own/scope pilote la visibilité (service.js) ; le rôle memberships
// « soc » pilote les actions réservées — jamais une exception username/role JWT.
// security_alerts ne porte aucune colonne site/zone : l'accès est résolu au
// niveau du tenant dans son ensemble (voir backend/scope.js#tenantAccess).
// PG-16 : scope.requireScope() — le même middleware que backend/routes.js —
// remplace la résolution ad hoc précédente : ?tenant_id=/site_id=/zone_id=
// sont désormais acceptés (et un identifiant forgé refusé) sur toutes les
// routes Alert Core, pas seulement les routes métier historiques. Toujours
// une intersection avec le périmètre réel, jamais une autorisation du client.
router.use(scope.requireScope());
router.use((req, res, next) => {
  req.user.alertAccess = req.scope.tenantAccess(req.tenantId);
  req.user.isSoc = req.scope.hasRole(req.tenantId, 'soc');
  // PG-10 : contexte pour les audits success posés par alert-core/service.js,
  // dans la même transaction que la mutation qu'ils décrivent (règle 13).
  req.user.tenantId = req.tenantId;
  req.user.requestId = req.requestId || null;
  req.user.ipAddress = req.ip || null;
  req.user.userAgentHeader = req.headers['user-agent'] || null;
  next();
});
const admin = (req, res, next) => {
  if (req.user.isSoc) return next();
  // recordBestEffort n'échoue jamais (avale sa propre erreur) : .then() suffit,
  // pas besoin d'un handler async ici (cf. requireAdmin dans backend/routes.js).
  auditDenied(req, 'alert_rules', req.user.id)
    .then(() => res.status(403).json({ error: 'Action réservée au SOC (administrateur)' }));
};
router.get('/rules', admin, wrap(async (req, res) => res.json(await service.config())));
router.put('/rules', admin, wrap(async (req, res) => res.json(await service.updateRules(req.body, req.user))));
router.get('/rules/audit', admin, wrap(async (req, res) => res.json(await service.configAudit())));
router.get('/notifications', wrap(async (req, res) => res.json(await service.notifications(req.user.id))));
router.post('/notifications/:id/read', wrap(async (req, res) => res.json(await service.readNotification(req.params.id, req.user))));
router.get('/', wrap(async (req, res) => res.json(await service.list(req.user))));
router.post('/', wrap(async (req, res) => res.status(201).json(await service.create(req.body, req.user))));
// PG-15 : bouton de détresse — aucun champ requis, niveau/type jamais au
// choix de l'appelant (toujours 4/'SOS'). Avant la route /:id pour ne jamais
// prêter à confusion, même si la méthode HTTP suffit déjà à les distinguer.
router.post('/sos', wrap(async (req, res) => res.status(201).json(await service.sos(req.body, req.user))));
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
