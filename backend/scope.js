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
const securityAudit = require('./security-audit');

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
// Former known boundary (now closed, see requireScope() below): this
// function itself still never re-verifies that a supplied siteId/zoneId
// truly belongs to tenantId — it purely trusts the (tenantId, siteId,
// zoneId) triple as stored on each membership row. That used to be safe
// because sites/zones (id, tenant_id) coherence was enforced forever via
// composite foreign keys (PG-6/PG-7). Since migration 019 (site transfer:
// sites.tenant_id can now change after the fact, see backend/admin-
// sites.js#POST /sites/:id/transfer), a membership's stored triple can
// legitimately go stale — requireScope() now re-validates the requested
// site/zone against the LIVE sites/zones tables via liveResourceTenant()
// before trusting coverageOf()'s verdict, closing exactly this gap for
// every requireScope()-guarded route. coverageOf() itself stays a pure,
// synchronous function on already-loaded data; the live check lives one
// layer up because it needs DB access this function deliberately doesn't.
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

// LOT GROUPES §17 (helper central de scope) : le seul ensemble de site_id
// qu'un module métier (Tableau de bord, Centre d'alertes, Main courante,
// Rondes, etc.) doit filtrer par — jamais recalculé différemment ailleurs.
//
// Règle métier verrouillée par le mandat, dérivée de coverageOf()
// ci-dessus (jamais une intersection recalculée à part — le même mécanisme
// qui décide allows()/coverage() décide aussi cet ensemble) :
//   - Une appartenance de niveau TENANT (site_id/zone_id NULL) = périmètre
//     maximal = TOUS les sites du groupe → retourne le sentinel `null`
//     ("ALL", jamais une énumération que l'appelant pourrait mal filtrer).
//   - Sinon, seulement les site_id des appartenances de niveau site/zone
//     dans ce tenant = la restriction réelle de l'utilisateur.
//   - Ne fait JAMAIS l'union des deux : coverageOf() couvre déjà tout site
//     dès qu'une ligne tenant existe, donc la coexistence de lignes site
//     ne restreint rien — elle ne fait que documenter une intention qui
//     n'a plus d'effet tant que la ligne tenant reste active. Le seul
//     moyen réel de restreindre un utilisateur est l'ABSENCE de ligne
//     tenant (voir backend/admin-groups.js, qui applique cette règle à la
//     création/mise à jour des appartenances plutôt que de la fabriquer
//     ici après coup).
function visibleSiteIdsOf(memberships, tenantId) {
  const inTenant = memberships.filter(m => m.tenant_id === tenantId);
  if (inTenant.some(m => m.scope === 'tenant')) return null; // null = tous les sites du tenant
  return [...new Set(inTenant.filter(m => m.site_id != null).map(m => m.site_id))];
}

// PG-28 (revue déploiement) : jusqu'ici, cette requête tournait SANS jamais
// poser `securisite.actor_user_id` — sous le rôle applicatif réel
// (`securisite_app`, NOBYPASSRLS, PG-9), la RLS sur `memberships`/`tenants`
// (migration 005) filtre alors TOUJOURS ces lignes à zéro pour tout acteur
// non posé, donc `hasAccess` était TOUJOURS faux et absolument aucune route
// gardée par requireScope() (l'essentiel de la surface métier) ne
// fonctionnait sous ce rôle — masqué depuis PG-8/PG-9 par le fait que toute
// la suite de tests se connecte en tant que superutilisateur (BYPASSRLS
// implicite). Vérifié empiriquement avec un rôle restreint réel avant ce
// correctif : `hasAccess=false`, 0 membership renvoyée, pour un utilisateur
// qui en possède pourtant une. `withActorContext` pose l'acteur (même
// convention que backend/map.js, PG-17) pour que cette requête — comme
// toute autre sur les 5 tables protégées — voie réellement ses propres
// lignes. `client` doit être un objet "base" (`.transaction()`, comme le
// module `db` par défaut) — tous les appelants actuels le sont déjà ;
// passer un client déjà engagé dans une transaction échouerait bruyamment
// ici plutôt que de revenir silencieusement au bug ci-dessus.
async function resolveScope(userId, client = db) {
  const memberships = await withActorContext(userId, c => loadActiveMemberships(userId, c), client);
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
    // null = tous les sites du tenant (périmètre maximal, appartenance
    // tenant) ; tableau = restriction réelle (voir visibleSiteIdsOf ci-dessus).
    visibleSiteIds: tenantId => visibleSiteIdsOf(memberships, tenantId),
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
// PG-10 : un refus de périmètre est un événement de sécurité explicite et
// borné (n'arrive jamais sur une requête normalement autorisée) — audité en
// best-effort, jamais un blocage supplémentaire si le journal est indisponible.
function auditDenied(req, resourceType, detail) {
  return securityAudit.recordBestEffort({
    requestId: req.requestId || null, origin: 'http',
    actorUserId: req.user && req.user.id || null,
    eventType: 'auth.access.denied', resourceType, action: 'access', outcome: 'denied',
    ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
    detail,
  });
}

// TRANSFERT INTER-GROUPES DES SITES (migration 019) : sites.tenant_id peut
// désormais changer après coup (un site transféré reste le même site.id,
// mais change de groupe propriétaire). Ceci rouvre exactement la faille que
// le commentaire au-dessus de coverageOf() documentait déjà comme « limite
// connue » avant cette mission : coverageOf() ne valide JAMAIS qu'un
// site_id/zone_id demandé appartient RÉELLEMENT, EN CE MOMENT, au tenant
// résolu — elle fait entièrement confiance au triplet (tenant_id, site_id,
// zone_id) déjà stocké sur la ligne memberships. Pour une appartenance de
// niveau SITE/ZONE devenue obsolète après un transfert, la transaction de
// transfert elle-même neutralise déjà la ligne (archivage, voir
// backend/admin-sites.js#POST /sites/:id/transfer) — mais une appartenance
// de niveau TENANT couvre par construction N'IMPORTE QUEL site_id/zone_id
// demandé sous ce tenant, y compris un site qui n'y appartient plus : sans
// contrôle supplémentaire, un ancien membre tenant-wide du groupe SOURCE
// pourrait continuer à demander tenant_id=SOURCE&site_id=<site transféré>
// et franchir ce portail. Un aller-retour supplémentaire (clé primaire,
// léger) corrige ceci pour TOUT appelant de requireScope() — pas seulement
// Groupes — en revalidant le site/zone demandé contre les tables sites/
// zones RÉELLES, jamais seulement contre la ligne memberships stockée.
async function liveResourceTenant(userId, siteId, zoneId, client = db) {
  if (zoneId != null) {
    const row = await withActorContext(userId, c => c.get('SELECT tenant_id FROM public.zones WHERE id=$1', [zoneId]), client);
    return row ? row.tenant_id : null;
  }
  if (siteId != null) {
    const row = await withActorContext(userId, c => c.get('SELECT tenant_id FROM public.sites WHERE id=$1', [siteId]), client);
    return row ? row.tenant_id : null;
  }
  return null;
}

function requireScope() {
  return async (req, res, next) => {
    try {
      // module.exports.resolveScope, not the bare local reference: this
      // middleware closure is created once, at router-build time (router.use
      // (scope.requireScope())) — long before a test could ever monkey-patch
      // scope.resolveScope the way service.currentUser/service.config already
      // are elsewhere. Dispatching through the exports object keeps that same
      // interception point working here too, with no behavioural difference
      // in production (module.exports.resolveScope === resolveScope there).
      const scope = await module.exports.resolveScope(req.user.id);
      const param = key => (typeof req.query[key] === 'string' && req.query[key] ? req.query[key] : null);
      const tenantId = scope.resolveTenant(param('tenant_id'));
      if (!scope.hasAccess || tenantId == null) {
        await auditDenied(req, 'scope', { reason_code: scope.hasAccess ? 'tenant_unresolved' : 'no_membership' });
        return res.status(403).json({ error: 'Accès au périmètre refusé' });
      }
      const siteId = param('site_id'), zoneId = param('zone_id');
      if (siteId != null || zoneId != null) {
        if (!scope.allows(tenantId, siteId, zoneId)) {
          await auditDenied(req, 'scope', { reason_code: 'site_or_zone_not_covered' });
          return res.status(403).json({ error: 'Accès au périmètre refusé' });
        }
        const liveTenant = await module.exports.liveResourceTenant(req.user.id, siteId, zoneId);
        if (liveTenant !== tenantId) {
          await auditDenied(req, 'scope', { reason_code: 'site_tenant_mismatch' });
          return res.status(403).json({ error: 'Accès au périmètre refusé' });
        }
      }
      req.scope = scope;
      req.tenantId = tenantId;
      next();
    } catch (e) { next(e); }
  };
}

// PG-9 : contexte d'acteur transaction-scoped pour la RLS PostgreSQL
// (migration 005). SET LOCAL ne survit jamais à COMMIT/ROLLBACK et ne peut
// donc jamais fuiter vers la transaction suivante empruntant la même
// connexion du pool, ni vers un autre utilisateur. Aucune route ne lit
// encore une table protégée par RLS au runtime (voir docs/postgresql-scope.md)
// — ce mécanisme est prêt pour la première qui le fera.
async function withActorContext(userId, fn, database = db) {
  return database.transaction(async client => {
    await client.query("SELECT set_config('securisite.actor_user_id', $1, true)", [userId == null ? '' : String(userId)]);
    return fn(client);
  });
}

module.exports = { resolveScope, requireScope, withActorContext, liveResourceTenant };
