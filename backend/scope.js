'use strict';
/**
 * PG-8 — service central de résolution du périmètre applicatif (tenant / site /
 * zone) et de l'accès aux alertes (own / scope), à partir des `memberships`
 * ACTIFS de l'utilisateur authentifié (PG-7). Seul point d'autorité : aucune
 * condition de tenant dispersée dans les routes, aucune confiance dans un
 * tenant_id/site_id/zone_id fourni par le client (ce sont des FILTRES
 * demandés, jamais des autorisations — toujours intersectés avec le
 * périmètre réellement couvert par une ligne memberships active).
 *
 * Une appartenance ne compte que si elle est elle-même active ET que le
 * tenant (et, le cas échéant, le site/la zone) auquel elle pointe est actif :
 * suspendu/archivé à n'importe quel niveau retire tout accès opérationnel.
 *
 * Défense applicative uniquement (PG-8). Aucune RLS ici (PG-9, deuxième
 * défense indépendante). Aucune exception basée sur username/role/id :
 * chaque décision passe par une ligne memberships réelle.
 */
const db = require('./database');

const WIDER = { own: 0, scope: 1 };
const wider = (a, b) => (a == null ? b : (WIDER[b] > WIDER[a] ? b : a));

async function loadActiveMemberships(userId, client) {
  return client.all(`
    SELECT m.tenant_id, m.site_id, m.zone_id, m.role, m.alert_access, m.scope
    FROM public.memberships m
    JOIN public.tenants t ON t.id = m.tenant_id AND t.status = 'active'
    LEFT JOIN public.sites s ON s.id = m.site_id AND s.status = 'active'
    LEFT JOIN public.zones z ON z.id = m.zone_id AND z.status = 'active'
    WHERE m.user_id = $1 AND m.status = 'active'
      AND (m.site_id IS NULL OR s.id IS NOT NULL)
      AND (m.zone_id IS NULL OR z.id IS NOT NULL)`,
    [userId]);
}

// A membership covers a coordinate when it sits at or above that coordinate in
// the tenant > site > zone hierarchy (a tenant-level membership covers every
// site and zone under that tenant; a site-level membership covers every zone
// under that site). The caller is expected to pass siteId/zoneId that are
// already coherent (resolved against sites/zones), never raw free text.
// Known boundary: this function does not itself re-verify that a supplied
// siteId/zoneId truly belongs to tenantId — it trusts the triple the way it
// trusts any (tenantId, siteId, zoneId) sourced from the sites/zones tables,
// which already enforce that coherence via composite foreign keys (PG-6/PG-7).
// Nothing downstream currently filters business rows by tenant/site/zone (no
// historical table carries such a column yet — see docs/postgresql-scope.md),
// so a caller-forged mismatched triple cannot expose cross-tenant DATA today;
// it could only make the coarse requireScope gate pass when a stricter
// implementation might refuse it. Tighten this (query sites/zones to validate
// the triple) before any endpoint starts trusting siteId/zoneId to filter rows.
function coverageOf(memberships, tenantId, siteId, zoneId) {
  let best = null;
  for (const m of memberships) {
    if (m.tenant_id !== tenantId) continue;
    const covers = m.scope === 'tenant'
      || (m.scope === 'site' && siteId != null && m.site_id === siteId)
      || (m.scope === 'zone' && zoneId != null && m.zone_id === zoneId);
    if (covers) best = wider(best, m.alert_access);
  }
  return best; // 'own' | 'scope' | null
}

// Coarse, tenant-wide best access: the widest alert_access among ANY active
// membership under that tenant, regardless of level. Used for resources that
// carry no site/zone reference of their own (security_alerts today).
function tenantAccessOf(memberships, tenantId) {
  let best = null;
  for (const m of memberships) if (m.tenant_id === tenantId) best = wider(best, m.alert_access);
  return best;
}

function hasRoleOf(memberships, tenantId, role) {
  return memberships.some(m => m.tenant_id === tenantId && m.role === role);
}

async function resolveScope(userId, client = db) {
  const memberships = await loadActiveMemberships(userId, client);
  const tenantIds = [...new Set(memberships.map(m => m.tenant_id))];
  return {
    userId,
    memberships,
    tenantIds,
    hasAccess: memberships.length > 0,
    allows: (tenantId, siteId = null, zoneId = null) => coverageOf(memberships, tenantId, siteId, zoneId) !== null,
    coverage: (tenantId, siteId = null, zoneId = null) => coverageOf(memberships, tenantId, siteId, zoneId),
    tenantAccess: tenantId => tenantAccessOf(memberships, tenantId),
    hasRole: (tenantId, role) => hasRoleOf(memberships, tenantId, role),
    // No argument: resolves the sole covered tenant (today's single-tenant
    // reality). With an argument: only that exact tenant, and only if it is
    // actually covered by an active membership — never trusted otherwise.
    resolveTenant(requestedTenantId = null) {
      if (requestedTenantId != null) return tenantIds.includes(requestedTenantId) ? requestedTenantId : null;
      return tenantIds.length === 1 ? tenantIds[0] : null;
    },
  };
}

// Express middleware: requires an authenticated request (req.user.id set by
// auth.authMiddleware) to resolve to a real, active, unambiguous tenant scope.
// ?tenant_id=/?site_id=/?zone_id= are read only to NARROW the request — never
// to grant anything beyond what memberships already cover; a forged or
// uncovered value is refused, not silently ignored or widened.
function requireScope() {
  return async (req, res, next) => {
    try {
      const scope = await resolveScope(req.user.id);
      const param = key => (typeof req.query[key] === 'string' && req.query[key] ? req.query[key] : null);
      const tenantId = scope.resolveTenant(param('tenant_id'));
      if (!scope.hasAccess || tenantId == null) return res.status(403).json({ error: 'Accès au périmètre refusé' });
      const siteId = param('site_id'), zoneId = param('zone_id');
      if ((siteId != null || zoneId != null) && !scope.allows(tenantId, siteId, zoneId)) {
        return res.status(403).json({ error: 'Accès au périmètre refusé' });
      }
      req.scope = scope;
      req.tenantId = tenantId;
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { resolveScope, requireScope };
