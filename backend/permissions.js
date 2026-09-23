'use strict';
// Catalogue des rôles et permissions — Administration Système V1.
//
// Réutilise le modèle d'autorisation existant (backend/scope.js), ne le
// remplace pas : deux portes restent volontairement séparées, comme
// avant ce lot (voir commentaire backend/routes.js:61-68) —
//   - users.role === 'admin' : Administrateur global, capacité de compte,
//     hors périmètre memberships (peut n'avoir AUCUNE appartenance active
//     et garder un accès complet — exception explicite, testée ci-dessous
//     et dans tests/postgres-permissions.test.js).
//   - memberships.role (10 valeurs depuis la migration 015) : capacité
//     scoping par tenant/site/zone, vérifiée via req.scope.hasRole(...).
//
// Ce module ne définit AUCUNE nouvelle table : la matrice ci-dessous est
// un référentiel applicatif statique (même esprit que
// backend/maincourante-events.js CATEGORIES/EVENTS), pas un éditeur de
// permissions dynamique — la V1 du mandat demande d'« administrer les
// rôles/permissions », pas de les rendre librement reconfigurables (ce
// qui ouvrirait une vraie surface de contournement de DENY BY DEFAULT).

const VERBS = ['read', 'create', 'update', 'validate', 'delete', 'export', 'admin', 'execute'];

const MODULES = [
  'sites', 'zones', 'postes', 'users', 'roles', 'maincourante', 'alerts',
  'access_control', 'rondes', 'notifications', 'cameras', 'integrations',
  'data_governance', 'audit',
];

// Rôle -> { label, membershipRole } ; membershipRole===null signifie
// « porté par users.role, pas par memberships » (seul 'admin' aujourd'hui).
const ROLES = {
  admin:           { label: 'Administrateur global', membershipRole: null, global: true },
  security_admin:  { label: 'Administrateur sécurité', membershipRole: 'security_admin' },
  supervisor:      { label: 'Responsable sécurité / Superviseur', membershipRole: 'supervisor' },
  site_manager:    { label: 'Chef de site', membershipRole: 'site_manager' },
  soc:             { label: 'Opérateur SOC', membershipRole: 'soc' },
  agent:           { label: 'APS', membershipRole: 'agent' },
  patrol_agent:    { label: 'Rondier', membershipRole: 'patrol_agent' },
  access_operator: { label: 'Opérateur contrôle d’accès', membershipRole: 'access_operator' },
  client_manager:  { label: 'Client (gestionnaire)', membershipRole: 'client_manager' },
  client_viewer:   { label: 'Client / consultation', membershipRole: 'client_viewer' },
  auditor:         { label: 'Auditeur', membershipRole: 'auditor' },
};

// PERMISSIONS[module][membershipRole] = liste de verbes autorisés.
// Absence de clé = DENY BY DEFAULT (jamais un tableau vide interprété
// différemment d'une absence — les deux refusent, testé explicitement).
// 'admin' (global) n'apparaît JAMAIS ici : son accès total est décidé une
// seule fois dans can(), jamais dérivé de cette table (un module oublié
// ici doit rester fermé à tout le monde SAUF admin, pas l'inverse).
const PERMISSIONS = {
  sites:           { security_admin: ['read'], supervisor: ['read'], site_manager: ['read'], auditor: ['read'] },
  zones:           { security_admin: ['read', 'create', 'update'], supervisor: ['read'], site_manager: ['read', 'create', 'update'], auditor: ['read'] },
  postes:          { security_admin: ['read', 'create', 'update'], supervisor: ['read'], site_manager: ['read', 'create', 'update'], auditor: ['read'] },
  users:           { security_admin: ['read'], auditor: ['read'] },
  roles:           { security_admin: ['read'], auditor: ['read'] },
  maincourante:    { security_admin: ['read', 'update', 'admin'], supervisor: ['read'], site_manager: ['read', 'update', 'admin'], soc: ['read'], auditor: ['read'] },
  alerts:          { security_admin: ['read', 'update', 'admin'], supervisor: ['read', 'update'], soc: ['read', 'update'], auditor: ['read'] },
  access_control:  { security_admin: ['read', 'create', 'update', 'admin'], access_operator: ['read', 'execute'], site_manager: ['read'], auditor: ['read'] },
  rondes:          { security_admin: ['read', 'update'], site_manager: ['read', 'create', 'update'], patrol_agent: ['read', 'execute'], auditor: ['read'] },
  notifications:   { security_admin: ['read', 'update'], auditor: ['read'] },
  cameras:         { security_admin: ['read'], soc: ['read'], auditor: ['read'] },
  integrations:    { security_admin: ['read'], auditor: ['read'] },
  data_governance: { security_admin: ['read', 'export'], auditor: ['read'] },
  audit:           { security_admin: ['read'], soc: ['read'], auditor: ['read'] },
};

for (const m of Object.keys(PERMISSIONS)) {
  if (!MODULES.includes(m)) throw new Error('permissions.js : module inconnu ' + m);
  for (const [role, verbs] of Object.entries(PERMISSIONS[m])) {
    if (!ROLES[role] || ROLES[role].membershipRole === null) throw new Error('permissions.js : rôle memberships invalide ' + role);
    for (const v of verbs) if (!VERBS.includes(v)) throw new Error('permissions.js : verbe inconnu ' + v);
  }
}

// can(user, reqScope, tenantId, moduleName, verb) — vrai si CE user peut
// VERB sur MODULE dans TENANT. reqScope est req.scope (backend/scope.js,
// déjà résolu par requireScope()) ; peut être null (ex. utilisateur admin
// sans aucune appartenance — l'exception globale doit rester vraie même
// alors, testé explicitement).
function can(user, reqScope, tenantId, moduleName, verb) {
  if (!user) return false;
  if (user.role === 'admin') return true; // exception globale explicite
  if (!reqScope || tenantId == null) return false; // DENY BY DEFAULT
  const modulePerms = PERMISSIONS[moduleName];
  if (!modulePerms) return false; // module non déclaré = fermé à tous sauf admin
  for (const [role, verbs] of Object.entries(modulePerms)) {
    if (verbs.includes(verb) && reqScope.hasRole(tenantId, role)) return true;
  }
  return false;
}

// requirePermission(module, verb) — middleware Express. Doit être monté
// APRÈS scope.requireScope() (a besoin de req.scope/req.tenantId) — donc
// jamais sous le préfixe bare /admin/* de routes.js, qui contourne
// délibérément requireScope() pour les capacités de compte pur (voir
// backend/routes.js:70). Les routes qui en ont besoin sont montées sous
// un préfixe distinct qui, lui, passe par requireScope() normalement.
function requirePermission(moduleName, verb) {
  return (req, res, next) => {
    if (can(req.user, req.scope, req.tenantId, moduleName, verb)) return next();
    const securityAudit = require('./security-audit');
    securityAudit.recordBestEffort({
      requestId: req.requestId || null, origin: 'http',
      actorUserId: req.user?.id ?? null, actorUsername: req.user?.username ?? null, actorRole: req.user?.role ?? null,
      tenantId: req.tenantId ?? null,
      eventType: 'auth.access.denied', resourceType: 'system_admin.' + moduleName, action: verb, outcome: 'denied',
    }).then(() => res.status(403).json({ error: 'Droits insuffisants' }));
  };
}

module.exports = { VERBS, MODULES, ROLES, PERMISSIONS, can, requirePermission };
