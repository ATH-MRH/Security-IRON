const express = require('express');
const service = require('./alert-core/service');
const scope = require('./scope');
const securityAudit = require('./security-audit');
const { sendError } = require('./http-errors');
const aiSummaries = require('./ai/summaries');
const aiAssistant = require('./ai/assistant');
const aiCorrelation = require('./ai/correlation');
const aiSearch = require('./ai/search');
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
  // PG-24 : posé par backend/observability.js (PG-18), monté avant ce
  // routeur — relie un événement d'audit IA à sa ligne de télémétrie
  // opérationnelle, jamais recalculé ici.
  req.user.correlationId = req.correlationId || null;
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
// PG-25 (hardening) : « abus SOS » — seuil volontairement TRÈS généreux et
// PAR COMPTE : jamais un frein pour un vrai appel de détresse, y compris
// une main qui presse plusieurs fois par doute ou plusieurs urgences
// réelles rapprochées ; bloque seulement un flot automatisé (des dizaines
// à la seconde) capable de noyer le tableau de bord SOC sous de faux
// signaux. Jamais un silence : toujours une réponse explicite (429),
// jamais un SOS avalé sans réponse ni indication à l'appelant.
const SOS_WINDOW_MS = 60 * 1000;
const SOS_MAX_PER_WINDOW = 20;
const sosCounts = new Map(); // userId -> { count, windowStart }
function sosLimited(userId) {
  const now = Date.now();
  const entry = sosCounts.get(userId);
  if (!entry || now - entry.windowStart > SOS_WINDOW_MS) { sosCounts.set(userId, { count: 1, windowStart: now }); return false; }
  entry.count++;
  return entry.count > SOS_MAX_PER_WINDOW;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sosCounts) if (now - entry.windowStart > SOS_WINDOW_MS) sosCounts.delete(key);
}, SOS_WINDOW_MS).unref();
router.post('/sos', wrap(async (req, res) => {
  if (sosLimited(req.user.id)) {
    return res.status(429).json({ error: 'Trop de signaux SOS envoyés. Si l’urgence persiste, contactez directement le poste de sécurité.' });
  }
  res.status(201).json(await service.sos(req.body, req.user));
}));
// PG-20 : résumé de shift SOC — avant /:id (sinon capturé comme un id
// d'alerte littéral 'shift-summary'), réservé au SOC (summarizeShift le
// vérifie déjà, mais l'ordre de montage seul ne protège rien : la
// vérification métier reste dans backend/ai/summaries.js).
router.get('/shift-summary', wrap(async (req, res) => {
  const hours = req.query.since_hours ? Number(req.query.since_hours) : undefined;
  res.json(await aiSummaries.summarizeShift(req.user, undefined, hours === undefined ? {} : { sinceHours: hours }));
}));
// PG-22 : corrélation explicable — avant /:id (même raison que
// /shift-summary), réservée au SOC (backend/ai/correlation.js le
// vérifie déjà). Chaque signal porte sa propre preuve (evidence) —
// jamais une conclusion sans les alertes exactes qui la justifient.
router.get('/correlations', wrap(async (req, res) => {
  const minutes = req.query.window_minutes ? Number(req.query.window_minutes) : undefined;
  res.json(await aiCorrelation.correlate(req.user, undefined, minutes === undefined ? {} : { windowMinutes: minutes }));
}));
// PG-23 : recherche scoped — avant /:id (même raison). Ouverte aux accès
// "own" (contrairement à /shift-summary et /correlations, réservés SOC) :
// chercher dans ce qu'on voit déjà n'est pas un usage réservé au SOC, même
// principe que GET /alerts lui-même.
router.get('/search', wrap(async (req, res) => res.json(await aiSearch.search(req.query.q, req.user))));
// PG-21 : assistant SOC contextualisé — lecture seule (service.list(),
// own/scope déjà appliqués). Les suggestions renvoyées ne sont jamais
// exécutées ici : voir backend/ai/assistant.js pour la double garantie
// (structurelle + liste blanche) que l'IA ne peut ni clôturer, ni annuler,
// ni toucher aux permissions/audit.
router.post('/assistant', wrap(async (req, res) => res.json(await aiAssistant.ask(req.body?.question, req.user))));
// PCS01 (Lot C) : liste des comptes ciblables individuellement pour une
// diffusion — avant /:id (même raison que /search etc.), réservée au SOC
// (service.js#recipientCandidates le revérifie).
router.get('/recipients/candidates', wrap(async (req, res) => res.json(await service.recipientCandidates(req.user))));
router.get('/:id', wrap(async (req, res) => res.json(await service.detail(req.params.id, req.user))));
router.post('/:id/actions', wrap(async (req, res) => res.json(await service.act(req.params.id, req.body, req.user))));
// PCS01 (Lot C) : diffuser une alerte déjà créée vers des destinataires
// explicites (SOC uniquement, service.js#broadcastAlert le revérifie).
router.post('/:id/broadcast', wrap(async (req, res) => res.status(201).json(await service.broadcastAlert(req.params.id, req.body, req.user))));
// L'utilisateur ne peut jamais accuser réception au nom d'un autre :
// req.user.id vient du JWT déjà vérifié par authMiddleware, jamais du corps
// de la requête.
router.post('/:id/receipt', wrap(async (req, res) => res.json(await service.receiptAlert(req.params.id, req.user.id, req.body?.status))));
router.get('/:id/receipts', wrap(async (req, res) => res.json(await service.alertReceipts(req.params.id, req.user))));
// PG-20 : résumés IA — lisent via service.detail() (own/scope déjà
// appliqués, PG-8), jamais un accès parallèle à la base. Toujours identifiés
// comme générés (generated_by_ai: true, backend/ai/summaries.js#label).
router.get('/:id/summary', wrap(async (req, res) => res.json(await aiSummaries.summarizeAlert(req.params.id, req.user))));
router.get('/:id/timeline-summary', wrap(async (req, res) => res.json(await aiSummaries.summarizeTimeline(req.params.id, req.user))));
router.get('/:id/closing-report', wrap(async (req, res) => res.json(await aiSummaries.closingReport(req.params.id, req.user))));
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
