const express = require('express');
const service = require('./alert-core/service');
const router = express.Router();

router.use((req,res,next) => {
  const user = service.currentUser(req.user.id);
  if (!user) return res.status(401).json({error:'Session révoquée'});
  req.user=user; next();
});
const admin = (req,res,next) => req.user.role === 'admin' ? next() : res.status(403).json({error:'Action réservée au SOC (administrateur)'});
router.get('/rules', admin, (req,res) => res.json(service.config()));
router.put('/rules', admin, (req,res) => res.json(service.updateRules(req.body,req.user)));
router.get('/rules/audit', admin, (req,res) => res.json(service.configAudit()));
router.get('/notifications', (req,res) => res.json(service.notifications(req.user.id)));
router.post('/notifications/:id/read', (req,res) => res.json(service.readNotification(req.params.id,req.user)));
router.get('/', (req,res) => res.json(service.list(req.user)));
router.post('/', (req,res) => res.status(201).json(service.create(req.body,req.user)));
router.get('/:id', (req,res) => res.json(service.detail(req.params.id,req.user)));
router.post('/:id/actions', (req,res) => res.json(service.act(req.params.id,req.body,req.user)));
router.use((req,res) => res.status(404).json({error:'Route Alert Core introuvable'}));
router.use((err,req,res,next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({error:err.message});
  next(err);
});

// Preserve the integration entry points used by server.js and backend/routes.js.
const { init, create, escalateDue, fromIncident, fromBadge } = service;
module.exports = {router,init,create,escalateDue,fromIncident,fromBadge};
