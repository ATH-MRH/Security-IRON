'use strict';
// backend/permissions.js — matrice statique rôles/permissions de
// l'Administration Système. Logique pure, aucune base de données (comme
// tests/maincourante-events.test.js pour le référentiel Main courante).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, MODULES, PERMISSIONS, VERBS, can } = require('../backend/permissions');

function scope(rolesByTenant) {
  // Fake minimal de req.scope : seule hasRole(tenantId, role) est utilisée par can().
  return { hasRole: (tenantId, role) => (rolesByTenant[tenantId] || []).includes(role) };
}

test('admin (global) can do anything, even with no scope at all — the explicit exception', () => {
  const admin = { role: 'admin' };
  assert.equal(can(admin, null, null, 'sites', 'delete'), true);
  assert.equal(can(admin, null, null, 'nonexistent_module', 'admin'), true);
  for (const m of MODULES) for (const v of VERBS) assert.equal(can(admin, null, null, m, v), true);
});

test('a non-admin user with no scope is refused everything — DENY BY DEFAULT, never an accidental global grant', () => {
  const user = { role: 'agent' };
  assert.equal(can(user, null, 't1', 'sites', 'read'), false);
  assert.equal(can(user, scope({}), null, 'sites', 'read'), false, 'a null tenantId must never widen access');
});

test('a role granted in one tenant is refused in another (no cross-tenant leak through the permission layer)', () => {
  const user = { role: 'agent' };
  const s = scope({ t1: ['site_manager'] });
  assert.equal(can(user, s, 't1', 'zones', 'create'), true);
  assert.equal(can(user, s, 't2', 'zones', 'create'), false);
});

test('an undeclared module is closed to every non-admin role, even one with broad permissions elsewhere', () => {
  const user = { role: 'agent' };
  const s = scope({ t1: ['security_admin'] });
  assert.equal(can(user, s, 't1', 'a_module_nobody_declared', 'read'), false);
});

test('a role only grants the exact verbs it is declared for, nothing implied', () => {
  const user = { role: 'agent' };
  const s = scope({ t1: ['auditor'] });
  assert.equal(can(user, s, 't1', 'sites', 'read'), true);
  for (const v of ['create', 'update', 'delete', 'validate', 'export', 'admin', 'execute']) {
    assert.equal(can(user, s, 't1', 'sites', v), false, 'auditor must stay read-only on sites, verb=' + v);
  }
});

test('a user holding two different roles in the same tenant gets the union of their permissions', () => {
  const user = { role: 'agent' };
  const s = scope({ t1: ['patrol_agent', 'site_manager'] });
  assert.equal(can(user, s, 't1', 'rondes', 'execute'), true, 'from patrol_agent');
  assert.equal(can(user, s, 't1', 'postes', 'create'), true, 'from site_manager');
});

test('every role referenced in PERMISSIONS is declared in ROLES and is a real membership role (never the global admin key)', () => {
  for (const m of Object.keys(PERMISSIONS)) {
    assert.ok(MODULES.includes(m), 'module ' + m + ' must be listed in MODULES');
    for (const role of Object.keys(PERMISSIONS[m])) {
      assert.ok(ROLES[role], 'role ' + role + ' referenced in PERMISSIONS.' + m + ' must exist in ROLES');
      assert.notEqual(ROLES[role].membershipRole, null, 'admin must never appear as a PERMISSIONS row key (its access is unconditional, decided once in can())');
    }
  }
});

test('every verb used in PERMISSIONS is one of the declared VERBS (no silent typo widening or narrowing a grant)', () => {
  for (const m of Object.keys(PERMISSIONS)) {
    for (const verbs of Object.values(PERMISSIONS[m])) {
      for (const v of verbs) assert.ok(VERBS.includes(v), 'unknown verb ' + v + ' in module ' + m);
    }
  }
});

test('the 11 mission roles all resolve to a real ROLES entry (label present, no placeholder)', () => {
  // Administrateur sécurité, Responsable sécurité, Chef de site, Superviseur,
  // Opérateur SOC, APS, Rondier, Opérateur contrôle d'accès, Client, Auditeur
  // + Administrateur global. "Responsable sécurité" est documenté comme
  // réutilisant 'supervisor' (pas un rôle distinct — jamais un doublon
  // silencieux : voir le commentaire de la migration 015).
  const expectedKeys = ['admin', 'security_admin', 'supervisor', 'site_manager', 'soc', 'agent', 'patrol_agent', 'access_operator', 'client_manager', 'client_viewer', 'auditor'];
  for (const k of expectedKeys) {
    assert.ok(ROLES[k], 'missing role ' + k);
    assert.ok(ROLES[k].label && ROLES[k].label.length > 0, 'role ' + k + ' must have a real label');
  }
});
