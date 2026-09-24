'use strict';
// Administration Système — Groupes (LOT GROUPES).
//
// Groupe = tenants (migration 003, réutilisé, JAMAIS dupliqué — voir
// backend/db/postgresql/migrations/018_security_groups.sql pour l'audit
// complet). « Sites du groupe » = sites WHERE tenant_id = <groupe> (déjà
// canonique, jamais une table de relation many-to-many). « Utilisateur du
// groupe » = memberships (migration 004) : une ligne de niveau TENANT
// (site_id/zone_id NULL) = périmètre maximal (tous les sites du groupe) ;
// une ou plusieurs lignes de niveau SITE = restriction réelle. Jamais les
// deux à la fois pour un même (user, tenant, role) — voir
// backend/scope.js#visibleSiteIds, qui documente pourquoi une ligne tenant
// rend toute ligne site coexistante sans effet (jamais une union qui
// élargirait, jamais une intersection qui réduirait la ligne tenant).
//
// Monté sous /api/admin/groups (bare /admin/*, contourne requireScope —
// même raison que backend/admin-sites.js : administrer des groupes est
// une capacité de compte globale, pas scope-limitée).
//
// Réaffectation de site entre groupes (sites.tenant_id) via PUT
// /groups/:id/sites (add/remove) : reste gardée par le même compteur de
// dépendances que DELETE /admin/sites/:id (backend/site-dependencies.js)
// — cette route reste volontairement le chemin "simple affectation", pour
// un site RÉELLEMENT libre de toute dépendance (case à cocher "Sites
// disponibles", §12 mission TRANSFERT INTER-GROUPES). Pour un site AVEC
// des dépendances réelles (zones/postes/Main courante/rondes/équipements/
// appartenances/historique), l'Administrateur global dispose désormais
// d'un chemin dédié — backend/admin-sites.js#POST /sites/:id/transfer —
// qui NE bloque PAS sur ces dépendances (migration 019 a délibérément
// relâché les FK ON UPDATE RESTRICT qui l'en empêchaient jusqu'ici,
// documentées comme limitation V1 connue dans une version antérieure de
// ce commentaire) : transaction atomique, analyse d'impact réelle, motif
// obligatoire, appartenances SITE/ZONE-level incompatibles archivées
// (jamais reconduites aveuglément), audité (system_admin.site.transfer).
// Les deux chemins restent volontairement séparés : jamais de checkbox
// ordinaire transformée en transfert implicite (§2 mission).
const express = require('express');
const scope = require('./scope');
const securityAudit = require('./security-audit');
const { countSiteDependencies, blockingTotal } = require('./site-dependencies');

const router = express.Router();

class GroupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new GroupError(status, message); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const STATUSES = ['active', 'suspended', 'archived'];
const GROUP_COLUMNS = 'id, code, name, description, status, created_at, updated_at, archived_at';
// Rôles memberships réels (migration 004 + 015) — jamais une liste inventée ici.
const MEMBERSHIP_ROLES = ['soc', 'client_manager', 'supervisor', 'site_manager', 'agent', 'client_viewer', 'security_admin', 'patrol_agent', 'access_operator', 'auditor'];

function auditFields(req) {
  return {
    requestId: req.requestId || null, origin: 'http',
    actorUserId: req.user?.id ?? null, actorUsername: req.user?.username ?? null, actorRole: req.user?.role ?? null,
  };
}
async function localTenantId(client) {
  const row = await client.get(`SELECT id FROM public.tenants WHERE code='local'`);
  if (!row) fail(500, 'Tenant local introuvable (bootstrap incomplet)');
  return row.id;
}

/* ============================================================ */
/*  Liste + recherche + filtres + compteurs réels                 */
/* ============================================================ */
router.get('/groups', wrap(async (req, res) => {
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const conditions = [];
  const params = [];
  if (typeof q.status === 'string' && q.status) {
    if (!STATUSES.includes(q.status)) fail(400, 'Statut invalide');
    params.push(q.status); conditions.push(`t.status = $${params.length}`);
  }
  if (typeof q.search === 'string' && q.search.trim()) {
    params.push('%' + q.search.trim() + '%');
    conditions.push(`(t.name ILIKE $${params.length} OR t.code ILIKE $${params.length})`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const groups = await scope.withActorContext(req.user.id, async client => {
    const total = (await client.get(`SELECT count(*)::int AS c FROM public.tenants t ${where}`, params)).c;
    const listParams = [...params, limit];
    // sites_count : lecture directe de sites (non RLS ici car on lit à
    // l'intérieur de la même transaction actor-context — cohérent avec le
    // reste du fichier). users_count : appartenances actives distinctes.
    const rows = await client.all(
      `SELECT t.id, t.code, t.name, t.description, t.status, t.created_at, t.updated_at, t.archived_at,
              (SELECT count(*)::int FROM public.sites s WHERE s.tenant_id = t.id) AS sites_count,
              (SELECT count(DISTINCT m.user_id)::int FROM public.memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS users_count
       FROM public.tenants t ${where} ORDER BY t.name LIMIT $${listParams.length}`,
      listParams);
    return { rows, total };
  });
  res.json({ groups: groups.rows, total: groups.total });
}));

router.get('/groups/:id', wrap(async (req, res) => {
  const group = await scope.withActorContext(req.user.id, client =>
    client.get(`SELECT ${GROUP_COLUMNS} FROM public.tenants WHERE id=$1`, [req.params.id]));
  if (!group) fail(404, 'Groupe introuvable');
  res.json(group);
}));

/* ============================================================ */
/*  Création                                                       */
/* ============================================================ */
router.post('/groups', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) fail(400, 'Code invalide (minuscules, chiffres, tiret/underscore)');
  if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'Nom requis');
  const row = await scope.withActorContext(req.user.id, async client => {
    const exists = await client.get(`SELECT id FROM public.tenants WHERE code=$1`, [b.code]);
    if (exists) fail(409, 'Code de groupe déjà utilisé');
    const created = await client.get(
      `INSERT INTO public.tenants (code, name, description) VALUES ($1,$2,$3) RETURNING ${GROUP_COLUMNS}`,
      [b.code.trim(), b.name.trim(), b.description || null]);
    await securityAudit.record({
      ...auditFields(req), tenantId: created.id,
      eventType: 'system_admin.group.create', resourceType: 'group', resourceId: created.id, action: 'create', outcome: 'success',
      detail: { code: created.code, name: created.name },
    }, client);
    return created;
  });
  res.status(201).json(row);
}));

/* ============================================================ */
/*  Modification (informations)                                    */
/* ============================================================ */
router.put('/groups/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.name === 'string' && !b.name.trim()) fail(400, 'Nom ne peut pas être vide');
  const row = await scope.withActorContext(req.user.id, async client => {
    const current = await client.get(`SELECT * FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!current) fail(404, 'Groupe introuvable');
    const updated = await client.get(
      `UPDATE public.tenants SET name=$1, description=$2 WHERE id=$3 RETURNING ${GROUP_COLUMNS}`,
      [b.name?.trim() ?? current.name, b.description ?? current.description, req.params.id]);
    await securityAudit.record({
      ...auditFields(req), tenantId: req.params.id,
      eventType: 'system_admin.group.update', resourceType: 'group', resourceId: req.params.id, action: 'update', outcome: 'success',
      detail: { before_name: current.name, after_name: updated.name, before_description: current.description, after_description: updated.description },
    }, client);
    return updated;
  });
  res.json(row);
}));

/* ============================================================ */
/*  Transition de statut (activer/désactiver/archiver) — jamais    */
/*  de suppression définitive de groupe dans ce lot (surface FK     */
/*  trop large — voir en-tête de fichier).                          */
/* ============================================================ */
router.put('/groups/:id/status', wrap(async (req, res) => {
  const { status, reason } = req.body || {};
  if (!STATUSES.includes(status)) fail(400, 'Statut invalide');
  const row = await scope.withActorContext(req.user.id, async client => {
    const current = await client.get(`SELECT * FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!current) fail(404, 'Groupe introuvable');
    if (status === current.status) fail(409, 'Le groupe est déjà dans ce statut');
    const updated = await client.get(
      `UPDATE public.tenants SET status=$1, archived_at=CASE WHEN $1='archived' THEN now() ELSE NULL END WHERE id=$2 RETURNING ${GROUP_COLUMNS}`,
      [status, req.params.id]);
    await securityAudit.record({
      ...auditFields(req), tenantId: req.params.id,
      eventType: 'system_admin.group.' + (status === 'active' ? 'activate' : status === 'suspended' ? 'deactivate' : 'archive'),
      resourceType: 'group', resourceId: req.params.id, action: 'update', outcome: 'success',
      detail: { before_status: current.status, after_status: status, reason: reason || null },
    }, client);
    return updated;
  });
  res.json(row);
}));

/* ============================================================ */
/*  Onglet Sites — double panneau                                  */
/* ============================================================ */
router.get('/groups/:id/sites', wrap(async (req, res) => {
  const sites = await scope.withActorContext(req.user.id, async client => {
    const group = await client.get(`SELECT id FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!group) fail(404, 'Groupe introuvable');
    return client.all(
      `SELECT id, code, name, client, status, updated_at FROM public.sites WHERE tenant_id=$1 ORDER BY name`,
      [req.params.id]);
  });
  res.json({ sites });
}));

// Sites disponibles = sites d'AUTRES groupes, avec leur groupe actuel et
// s'ils sont réellement déplaçables (0 dépendance bloquante) — jamais une
// simple liste plate qui laisserait l'admin découvrir le refus après coup.
router.get('/groups/:id/sites/available', wrap(async (req, res) => {
  const result = await scope.withActorContext(req.user.id, async client => {
    const group = await client.get(`SELECT id FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!group) fail(404, 'Groupe introuvable');
    const sites = await client.all(
      `SELECT s.id, s.code, s.name, s.client, s.status, t.id AS current_group_id, t.name AS current_group_name
       FROM public.sites s JOIN public.tenants t ON t.id = s.tenant_id
       WHERE s.tenant_id <> $1 ORDER BY t.name, s.name`, [req.params.id]);
    const withMovable = await Promise.all(sites.map(async s => {
      const deps = await countSiteDependencies(client, s.id);
      return { ...s, movable: blockingTotal(deps) === 0 };
    }));
    return withMovable;
  });
  res.json({ sites: result });
}));

// Enregistrement groupé (§11 : sélection locale temporaire côté client,
// UNE SEULE transaction ici) — { add:[siteId...], remove:[siteId...] }.
// "remove" déplace vers le tenant 'local' (pool neutre par défaut) ; sans
// effet si le groupe édité EST déjà 'local'. Chaque site est gardé par le
// même compteur de dépendances que DELETE /admin/sites/:id — tout ou rien :
// un seul site bloquant fait échouer toute la transaction (jamais un état
// intermédiaire où certains sites ont bougé et d'autres non).
router.put('/groups/:id/sites', wrap(async (req, res) => {
  const add = Array.isArray(req.body?.add) ? req.body.add : [];
  const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
  if (!add.length && !remove.length) fail(400, 'Aucune modification à enregistrer');
  const result = await scope.withActorContext(req.user.id, async client => {
    const group = await client.get(`SELECT * FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!group) fail(404, 'Groupe introuvable');
    const localId = await localTenantId(client);
    const moved = [];
    const moveSite = async (siteId, targetTenantId, eventSuffix) => {
      const site = await client.get(`SELECT * FROM public.sites WHERE id=$1`, [siteId]);
      if (!site) fail(404, 'Site introuvable : ' + siteId);
      if (site.tenant_id === targetTenantId) return; // déjà à sa place, no-op silencieux
      const deps = await countSiteDependencies(client, siteId);
      if (blockingTotal(deps) > 0) {
        fail(409, `Site « ${site.name} » non déplaçable : des données réelles y sont rattachées (voir Dépendances) — le retirer/l'ajouter est refusé pour ne laisser aucune référence orpheline.`);
      }
      await client.query(`UPDATE public.sites SET tenant_id=$1 WHERE id=$2`, [targetTenantId, siteId]);
      await securityAudit.record({
        ...auditFields(req), tenantId: req.params.id,
        eventType: 'system_admin.group.site.' + eventSuffix, resourceType: 'group', resourceId: req.params.id, action: 'update', outcome: 'success',
        detail: { site_id: siteId, site_code: site.code, from_tenant: site.tenant_id, to_tenant: targetTenantId },
      }, client);
      moved.push(siteId);
    };
    for (const siteId of add) await moveSite(siteId, req.params.id, 'add');
    if (remove.length && req.params.id === localId) fail(409, 'Ce groupe est le pool par défaut — aucun site ne peut en être retiré');
    for (const siteId of remove) await moveSite(siteId, localId, 'remove');
    return { moved };
  });
  res.json(result);
}));

/* ============================================================ */
/*  Onglet Utilisateurs                                            */
/* ============================================================ */
router.get('/groups/:id/users', wrap(async (req, res) => {
  const users = await scope.withActorContext(req.user.id, async client => {
    const group = await client.get(`SELECT id FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!group) fail(404, 'Groupe introuvable');
    const rows = await client.all(
      `SELECT m.id AS membership_id, m.user_id, u.username, u.nom_complet, m.role, m.scope, m.site_id,
              s.name AS site_name, m.status, m.created_at
       FROM public.memberships m
       JOIN public.users u ON u.id = m.user_id
       LEFT JOIN public.sites s ON s.id = m.site_id
       WHERE m.tenant_id=$1 AND m.status='active'
       ORDER BY u.username, m.scope`, [req.params.id]);
    // Regroupe par utilisateur : une ligne tenant = accès total ; sinon la
    // liste des sites restreints (jamais l'union — voir scope.js#visibleSiteIds).
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { user_id: r.user_id, username: r.username, nom_complet: r.nom_complet, role: r.role, all_sites: false, site_ids: [], site_names: [] });
      const u = byUser.get(r.user_id);
      if (r.scope === 'tenant') u.all_sites = true;
      else if (r.scope === 'site') { u.site_ids.push(r.site_id); u.site_names.push(r.site_name); }
    }
    return [...byUser.values()];
  });
  res.json({ users });
}));

router.post('/groups/:id/users', wrap(async (req, res) => {
  const b = req.body || {};
  if (!Number.isInteger(b.user_id)) fail(400, 'user_id requis');
  if (!MEMBERSHIP_ROLES.includes(b.role)) fail(400, 'Rôle invalide');
  const allSites = !!b.all_sites;
  const siteIds = Array.isArray(b.site_ids) ? b.site_ids : [];
  if (!allSites && !siteIds.length) fail(400, 'Sélectionner « tous les sites » ou au moins un site du groupe');
  const row = await scope.withActorContext(req.user.id, async client => {
    const group = await client.get(`SELECT id FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!group) fail(404, 'Groupe introuvable');
    const user = await client.get(`SELECT id, username FROM public.users WHERE id=$1`, [b.user_id]);
    if (!user) fail(404, 'Utilisateur introuvable');
    const created = [];
    if (allSites) {
      const existing = await client.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND tenant_id=$2 AND role=$3 AND site_id IS NULL AND zone_id IS NULL`, [b.user_id, req.params.id, b.role]);
      if (existing) fail(409, 'Cet utilisateur a déjà une appartenance de ce rôle sur ce groupe');
      const m = await client.get(
        `INSERT INTO public.memberships (user_id, tenant_id, role, alert_access) VALUES ($1,$2,$3,'own') RETURNING id`,
        [b.user_id, req.params.id, b.role]);
      created.push(m.id);
    } else {
      for (const siteId of siteIds) {
        // La contrainte composite memberships_site_tenant_fk (migration 004)
        // refuse déjà un site hors tenant — vérifié ici en amont pour un 400
        // clair plutôt qu'un 500 issu d'une violation FK brute.
        const site = await client.get(`SELECT id FROM public.sites WHERE id=$1 AND tenant_id=$2`, [siteId, req.params.id]);
        if (!site) fail(400, 'Site hors du périmètre de ce groupe : ' + siteId);
        const existing = await client.get(`SELECT id FROM public.memberships WHERE user_id=$1 AND tenant_id=$2 AND site_id=$3 AND role=$4`, [b.user_id, req.params.id, siteId, b.role]);
        if (existing) continue;
        const m = await client.get(
          `INSERT INTO public.memberships (user_id, tenant_id, site_id, role, alert_access) VALUES ($1,$2,$3,$4,'own') RETURNING id`,
          [b.user_id, req.params.id, siteId, b.role]);
        created.push(m.id);
      }
    }
    await securityAudit.record({
      ...auditFields(req), tenantId: req.params.id,
      eventType: 'system_admin.group.user.add', resourceType: 'group', resourceId: req.params.id, action: 'create', outcome: 'success',
      detail: { user_id: b.user_id, username: user.username, role: b.role, all_sites: allSites, site_count: siteIds.length },
    }, client);
    return { membership_ids: created };
  });
  res.status(201).json(row);
}));

// Retirer un utilisateur du groupe = archiver TOUTES ses appartenances
// actives sur ce tenant (jamais une suppression — immuable par trigger).
router.delete('/groups/:id/users/:userId', wrap(async (req, res) => {
  const result = await scope.withActorContext(req.user.id, async client => {
    const group = await client.get(`SELECT id FROM public.tenants WHERE id=$1`, [req.params.id]);
    if (!group) fail(404, 'Groupe introuvable');
    const rows = await client.all(
      `SELECT id FROM public.memberships WHERE user_id=$1 AND tenant_id=$2 AND status='active'`,
      [req.params.userId, req.params.id]);
    if (!rows.length) fail(404, 'Cet utilisateur n\'a aucune appartenance active sur ce groupe');
    for (const r of rows) await client.query(`UPDATE public.memberships SET status='archived' WHERE id=$1`, [r.id]);
    await securityAudit.record({
      ...auditFields(req), tenantId: req.params.id,
      eventType: 'system_admin.group.user.remove', resourceType: 'group', resourceId: req.params.id, action: 'update', outcome: 'success',
      detail: { user_id: Number(req.params.userId), revoked_memberships: rows.length },
    }, client);
    return { revoked: rows.length };
  });
  res.json(result);
}));

// MISSION — DÉPENDANCES SITE : retirer UNE appartenance précise (identifiée
// par son id, ex. depuis le drill-down des dépendances d'un site), jamais
// TOUTES les appartenances d'un utilisateur sur le groupe (DELETE /groups/
// :id/users/:userId ci-dessus reste inchangée pour ce cas plus large — un
// utilisateur restreint à plusieurs sites du même groupe ne doit pas tout
// perdre pour n'en avoir retiré qu'un seul). Même mécanisme d'archivage
// (status='archived', jamais une suppression — trigger memberships_
// no_delete l'interdirait de toute façon), même convention d'audit.
// Un Administrateur global (users.role='admin') ne tire AUCUN privilège de
// ses lignes memberships (voir backend/permissions.js, backend/scope.js) :
// archiver l'une des siennes ne retire jamais son statut global — vérifié
// explicitement par un test dédié plutôt que simplement supposé.
router.delete('/memberships/:id', wrap(async (req, res) => {
  const result = await scope.withActorContext(req.user.id, async client => {
    const m = await client.get(
      `SELECT m.*, u.username FROM public.memberships m JOIN public.users u ON u.id = m.user_id WHERE m.id=$1`,
      [req.params.id]);
    if (!m) fail(404, 'Appartenance introuvable');
    if (m.status !== 'active') fail(409, 'Cette appartenance n\'est plus active');
    await client.query(`UPDATE public.memberships SET status='archived' WHERE id=$1`, [m.id]);
    await securityAudit.record({
      ...auditFields(req), tenantId: m.tenant_id,
      eventType: 'system_admin.membership.archive', resourceType: 'membership', resourceId: m.id, action: 'update', outcome: 'success',
      detail: { user_id: m.user_id, username: m.username, tenant_id: m.tenant_id, site_id: m.site_id, zone_id: m.zone_id, role: m.role, scope: m.scope },
    }, client);
    return { archived: true, membership_id: m.id, user_id: m.user_id, site_id: m.site_id };
  });
  res.json(result);
}));

/* ============================================================ */
/*  Onglet Audit — réutilise security_audit (migration 006),       */
/*  jamais un journal parallèle.                                   */
/* ============================================================ */
router.get('/groups/:id/audit', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  // MISSION — DÉPENDANCES SITE : system_admin.membership.archive (retrait
  // d'une appartenance précise depuis le drill-down des dépendances d'un
  // site) est posé avec tenantId=memberships.tenant_id — donc réellement
  // rattaché à CE groupe — jamais visible ici auparavant faute d'un motif
  // LIKE correspondant, alors même que l'action a bien eu lieu et est déjà
  // auditée dans security_audit.
  const rows = await scope.withActorContext(req.user.id, client => client.all(
    `SELECT id, created_at, actor_username, event_type, resource_type, resource_id, action, outcome, detail
     FROM public.security_audit
     WHERE tenant_id=$1 AND (event_type LIKE 'system_admin.group.%' OR event_type LIKE 'system_admin.site.%' OR event_type LIKE 'system_admin.membership.%')
     ORDER BY created_at DESC, id DESC LIMIT $2`, [req.params.id, limit]));
  res.json({ events: rows });
}));

router.use((err, req, res, next) => (err instanceof GroupError ? res.status(err.status).json({ error: err.message }) : next(err)));

module.exports = { router };
