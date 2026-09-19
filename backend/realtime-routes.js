'use strict';
/**
 * PG-12 — HTTP surface du bus temps réel : émission de ticket (authentifiée
 * normalement) et le flux SSE lui-même (Bearer OU ticket — voir realtime.js).
 */
const express = require('express');
const auth = require('./auth');
const scope = require('./scope');
const realtime = require('./realtime');

const router = express.Router();
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.post('/ticket', auth.authMiddleware, wrap(async (req, res) => {
  const { ticket, expiresInMs } = realtime.issueTicket(req.user.id);
  res.json({ ticket, expiresIn: Math.round(expiresInMs / 1000) });
}));

router.get('/stream', wrap(async (req, res, next) => {
  let userId;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { userId = auth.verifyToken(h.slice(7)).id; }
    catch { return res.status(401).json({ error: 'Token invalide ou expiré' }); }
  } else if (typeof req.query.ticket === 'string' && req.query.ticket) {
    userId = realtime.consumeTicket(req.query.ticket);
    if (!userId) return res.status(401).json({ error: 'Ticket invalide ou expiré' });
  } else {
    return res.status(401).json({ error: 'Authentification requise' });
  }

  // Même autorité que backend/alerts.js (PG-8) : périmètre résolu côté
  // serveur, jamais un tenant/site/zone fourni par le client. Sans périmètre
  // actif, pas de flux — cohérent avec le refus 403 des autres routes.
  const s = await scope.resolveScope(userId);
  const tenantId = s.resolveTenant();
  if (!s.hasAccess || tenantId == null) return res.status(403).json({ error: 'Accès au périmètre refusé' });
  const alertAccess = s.tenantAccess(tenantId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // un reverse proxy ne doit pas retenir le flux en tampon
  });
  res.write(':ok\n\n');

  // PCS01 (Lot C) : un événement de diffusion porte aussi
  // recipientUserIds (jamais le contenu de l'alerte, juste des ids) — un
  // compte "own" explicitement ciblé le reçoit même s'il n'est ni créateur
  // ni de périmètre 'scope'. Narrow à dessein : n'élargit rien d'autre que
  // ce que service.js#broadcastAlert a déjà résolu et inséré en base.
  const matches = event => (alertAccess === 'scope'
    ? event.payload.tenantId === tenantId
    : event.payload.createdBy === userId || (event.payload.recipientUserIds || []).includes(userId));
  // Audit SOS bout-en-bout : bus.emit() (realtime.js) appelle chaque
  // abonné de façon SYNCHRONE — un res.write() qui lève (connexion d'un
  // AUTRE client déjà fermée/détruite, entre la fermeture réelle du socket
  // et le nettoyage asynchrone via req.on('close')) remontait jusqu'à
  // l'appelant de emit(), c.-à-d. jusqu'à la requête qui vient de créer
  // l'alerte (service.js#create, après le COMMIT). Un SOS déjà enregistré
  // avec succès en base recevait alors une réponse 500 — un faux « échec »
  // pour un abonné SANS RAPPORT avec l'émetteur. Ce flux n'est qu'un
  // rechargement best-effort (le client ne fait jamais confiance au
  // contenu, voir realtime.js) : une écriture ratée ne doit jamais faire
  // échouer autre chose que ce seul flux, jamais la mutation qui l'a émis.
  const send = event => {
    try { res.write(`event: ${event.type}\ndata: ${JSON.stringify({ id: event.payload.id, at: event.at })}\n\n`); }
    catch { cleanup(); }
  };
  const unsubscribe = realtime.subscribe(matches, send);
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 15000);
  heartbeat.unref();

  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  res.on('error', cleanup);
}));

module.exports = router;
