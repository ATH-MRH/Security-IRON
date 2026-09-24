'use strict';
// Administration Système — Sites (LOT 3/4/5/19).
//
// Monté sous /api/admin/sites dans backend/routes.js : hérite du préfixe
// bare /admin/* qui contourne scope.requireScope() (routes.js:70) — un
// Administrateur global sans AUCUNE appartenance active garde un accès
// complet, exactement comme /admin/users existant. Gate = requireAdmin
// (users.role==='admin'), passé depuis routes.js — pas de nouvelle porte
// ici, la création/l'archivage d'un site est une capacité de compte
// globale par nature (on ne peut pas être "scope-limité" sur un site qui
// n'existe pas encore, ou sur la décision de l'archiver).
//
// Réutilise tenants/sites/zones (migration 003) et leurs colonnes
// administratives ajoutées par la migration 015 — aucune table nouvelle.
//
// tenants/sites/zones/memberships sont protégées par RLS (migration 005) :
// TOUTE requête doit passer par scope.withActorContext(req.user.id, ...),
// jamais un db.get()/db.all() nu — sous le rôle applicatif réel
// (securisite_app, NOBYPASSRLS), une requête nue verrait silencieusement
// zéro ligne, jamais une erreur (bug réel trouvé et corrigé en
// construisant ce fichier — voir tests/postgres-admin-sites.test.js, qui
// tourne délibérément sous ce rôle restreint pour ne plus jamais le
// laisser passer inaperçu). La migration 017 étend en plus les politiques
// RLS du référentiel de scope pour qu'un Administrateur global (users.
// role='admin') les traverse même sans AUCUNE appartenance active.
const express = require('express');
const scope = require('./scope');
const securityAudit = require('./security-audit');
const { countSiteDependencies, blockingTotal } = require('./site-dependencies');

const router = express.Router();

class SiteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new SiteError(status, message); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const STATUSES = ['active', 'suspended', 'archived'];
const SITE_COLUMNS = 'id, tenant_id, code, name, client, address, phone, email, timezone, latitude, longitude, status, created_at, updated_at, archived_at';

function auditFields(req) {
  return {
    requestId: req.requestId || null, origin: 'http',
    actorUserId: req.user?.id ?? null, actorUsername: req.user?.username ?? null, actorRole: req.user?.role ?? null,
  };
}

/* ============================================================ */
/*  Liste + recherche + filtres + pagination                     */
/* ============================================================ */
router.get('/sites', wrap(async (req, res) => {
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const conditions = [];
  const params = [];
  if (typeof q.status === 'string' && q.status) {
    if (!STATUSES.includes(q.status)) fail(400, 'Statut invalide');
    params.push(q.status); conditions.push(`status = $${params.length}`);
  }
  if (typeof q.search === 'string' && q.search.trim()) {
    params.push('%' + q.search.trim() + '%');
    conditions.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length} OR client ILIKE $${params.length})`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { sites, total } = await scope.withActorContext(req.user.id, async client => {
    const t = (await client.get(`SELECT count(*)::int AS c FROM public.sites ${where}`, params)).c;
    const listParams = [...params, limit, offset];
    const rows = await client.all(
      `SELECT ${SITE_COLUMNS} FROM public.sites ${where} ORDER BY name LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams);
    return { sites: rows, total: t };
  });
  res.json({ sites, total, limit, offset });
}));

/* ============================================================ */
/*  Fiche site : détail + dépendances réelles (jamais une valeur   */
/*  fictive — ce que le schéma ne permet pas de compter n'est pas  */
/*  affiché comme zéro, mais explicitement omis)                   */
/* ============================================================ */
router.get('/sites/:id', wrap(async (req, res) => {
  const site = await scope.withActorContext(req.user.id, client =>
    client.get(`SELECT ${SITE_COLUMNS} FROM public.sites WHERE id=$1`, [req.params.id]));
  if (!site) fail(404, 'Site introuvable');
  res.json(site);
}));

/* ============================================================ */
/*  Zones (lecture seule V1 — pas de CRUD zones dans ce lot,        */
/*  seulement la liste réelle pour l'onglet Zones & postes)         */
/* ============================================================ */
router.get('/zones', wrap(async (req, res) => {
  const siteId = req.query.site_id;
  if (!siteId) fail(400, 'site_id requis');
  const zones = await scope.withActorContext(req.user.id, async client => {
    const site = await client.get(`SELECT id FROM public.sites WHERE id=$1`, [siteId]);
    if (!site) fail(404, 'Site introuvable');
    return client.all(
      `SELECT id, site_id, code, name, kind, description, access_level, status, created_at, updated_at, archived_at
       FROM public.zones WHERE site_id=$1 ORDER BY name`, [siteId]);
  });
  res.json({ zones });
}));

router.get('/sites/:id/dependencies', wrap(async (req, res) => {
  const id = req.params.id;
  const result = await scope.withActorContext(req.user.id, async client => {
    const site = await client.get(`SELECT id FROM public.sites WHERE id=$1`, [id]);
    if (!site) fail(404, 'Site introuvable');
    // Ces tables ne sont pas RLS-protégées (seul le référentiel tenant/site/
    // zone/memberships l'est), une lecture directe via ce même client reste
    // correcte à l'intérieur de la transaction ouverte par withActorContext.
    return countSiteDependencies(client, id);
  });
  res.json(result);
}));

// MISSION — DÉPENDANCES SITE : détail réel de la SEULE dépendance identifiée
// comme réellement bloquante et exploitable dans ce lot (utilisateurs/
// appartenances — voir GET /sites/:id/dependencies#active_memberships).
// MÊME condition WHERE que countSiteDependencies() (site-dependencies.js) —
// jamais un second calcul qui pourrait diverger du compteur déjà affiché.
router.get('/sites/:id/dependencies/memberships', wrap(async (req, res) => {
  const id = req.params.id;
  const rows = await scope.withActorContext(req.user.id, async client => {
    const site = await client.get(`SELECT id FROM public.sites WHERE id=$1`, [id]);
    if (!site) fail(404, 'Site introuvable');
    return client.all(
      `SELECT m.id AS membership_id, m.user_id, u.username, u.nom_complet, u.role AS account_role,
              m.role AS membership_role, m.scope, m.tenant_id, t.name AS tenant_name, t.code AS tenant_code,
              m.site_id, s.name AS site_name, m.status, m.created_at
       FROM public.memberships m
       JOIN public.users u ON u.id = m.user_id
       JOIN public.tenants t ON t.id = m.tenant_id
       LEFT JOIN public.sites s ON s.id = m.site_id
       WHERE m.site_id=$1 AND m.status='active'
       ORDER BY u.username`, [id]);
  });
  res.json({ memberships: rows });
}));

/* ============================================================ */
/*  Création (LOT 3 + étape 1 de l'assistant LOT 4)                */
/* ============================================================ */
router.post('/sites', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) fail(400, 'Code invalide (minuscules, chiffres, tiret/underscore)');
  if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'Nom requis');
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) fail(400, 'Email invalide');
  if (b.latitude != null && (b.longitude == null)) fail(400, 'Longitude requise si latitude fournie');
  if (b.longitude != null && (b.latitude == null)) fail(400, 'Latitude requise si latitude fournie');
  const row = await scope.withActorContext(req.user.id, async client => {
    let tenantId = b.tenant_id;
    if (!tenantId) {
      const t = await client.get(`SELECT id FROM public.tenants WHERE code='local'`);
      if (!t) fail(500, 'Tenant local introuvable (bootstrap incomplet)');
      tenantId = t.id;
    }
    const exists = await client.get(`SELECT id FROM public.sites WHERE tenant_id=$1 AND code=$2`, [tenantId, b.code]);
    if (exists) fail(409, 'Code de site déjà utilisé pour ce client');
    const created = await client.get(
      `INSERT INTO public.sites (tenant_id, code, name, client, address, phone, email, timezone, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${SITE_COLUMNS}`,
      [tenantId, b.code.trim(), b.name.trim(), b.client || null, b.address || null, b.phone || null, b.email || null,
       b.timezone || 'UTC', b.latitude ?? null, b.longitude ?? null]);
    await securityAudit.record({
      ...auditFields(req), tenantId,
      eventType: 'system_admin.site.create', resourceType: 'site', resourceId: created.id, action: 'create', outcome: 'success',
      detail: { code: created.code, name: created.name },
    }, client);
    return created;
  });
  res.status(201).json(row);
}));

/* ============================================================ */
/*  Modification (identité/coordonnées — jamais le statut ici,      */
/*  transition dédiée ci-dessous pour rester auditable distinctement)*/
/* ============================================================ */
router.put('/sites/:id', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) fail(400, 'Email invalide');
  if (typeof b.name === 'string' && !b.name.trim()) fail(400, 'Nom ne peut pas être vide');
  const row = await scope.withActorContext(req.user.id, async client => {
    const current = await client.get(`SELECT * FROM public.sites WHERE id=$1`, [req.params.id]);
    if (!current) fail(404, 'Site introuvable');
    const updated = await client.get(
      `UPDATE public.sites SET name=$1, client=$2, address=$3, phone=$4, email=$5, timezone=$6, latitude=$7, longitude=$8
       WHERE id=$9
       RETURNING ${SITE_COLUMNS}`,
      [b.name?.trim() ?? current.name, b.client ?? current.client, b.address ?? current.address, b.phone ?? current.phone,
       b.email ?? current.email, b.timezone ?? current.timezone, b.latitude ?? current.latitude, b.longitude ?? current.longitude,
       req.params.id]);
    await securityAudit.record({
      ...auditFields(req), tenantId: current.tenant_id,
      eventType: 'system_admin.site.update', resourceType: 'site', resourceId: req.params.id, action: 'update', outcome: 'success',
      // security-audit.js#sanitizeDetail exige un objet plat (jamais de
      // valeur imbriquée) — avant/après aplati en clés préfixées.
      detail: {
        before_name: current.name, after_name: updated.name,
        before_client: current.client, after_client: updated.client,
        before_address: current.address, after_address: updated.address,
        before_phone: current.phone, after_phone: updated.phone,
        before_email: current.email, after_email: updated.email,
        before_timezone: current.timezone, after_timezone: updated.timezone,
      },
    }, client);
    return updated;
  });
  res.json(row);
}));

/* ============================================================ */
/*  Transition de statut (activer/désactiver/archiver) — le chemin  */
/*  normal pour retirer un site du service, jamais une suppression  */
/*  physique (mandat LOT 3).                                        */
/* ============================================================ */
router.put('/sites/:id/status', wrap(async (req, res) => {
  const { status, reason } = req.body || {};
  if (!STATUSES.includes(status)) fail(400, 'Statut invalide');
  const row = await scope.withActorContext(req.user.id, async client => {
    const current = await client.get(`SELECT * FROM public.sites WHERE id=$1`, [req.params.id]);
    if (!current) fail(404, 'Site introuvable');
    if (status === current.status) fail(409, 'Le site est déjà dans ce statut');
    const updated = await client.get(
      `UPDATE public.sites SET status=$1, archived_at=CASE WHEN $1='archived' THEN now() ELSE NULL END WHERE id=$2
       RETURNING ${SITE_COLUMNS}`,
      [status, req.params.id]);
    await securityAudit.record({
      ...auditFields(req), tenantId: current.tenant_id,
      eventType: 'system_admin.site.status_change', resourceType: 'site', resourceId: req.params.id, action: 'update', outcome: 'success',
      detail: { before_status: current.status, after_status: status, reason: reason || null },
    }, client);
    return updated;
  });
  res.json(row);
}));

/* ============================================================ */
/*  Suppression définitive — LOT 19 (allégé) : jamais un bouton      */
/*  trivial. Refusée dès qu'une donnée réelle dépend du site (même   */
/*  logique que GET /sites/:id/dependencies) ; le filet de sécurité  */
/*  réel reste la contrainte FK RESTRICT PostgreSQL elle-même (10     */
/*  tables référencent sites — équipement, main_courante, mc_aps,     */
/*  mc_pcs01_config, mc_posts, mc_presence, memberships, round_       */
/*  circuits, rounds, zones), au cas où le pré-contrôle applicatif    */
/*  en oublierait une : une violation 23503 est traduite en 409       */
/*  explicite, jamais un 500 opaque. Motif obligatoire, audité.       */
/* ============================================================ */
router.delete('/sites/:id', wrap(async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) fail(400, 'Motif de suppression requis');
  try {
    await scope.withActorContext(req.user.id, async client => {
      const current = await client.get(`SELECT * FROM public.sites WHERE id=$1`, [req.params.id]);
      if (!current) fail(404, 'Site introuvable');
      const deps = await countSiteDependencies(client, req.params.id);
      if (blockingTotal(deps) > 0) fail(409, 'Suppression refusée : des données réelles dépendent de ce site — archivez-le plutôt (voir Dépendances)');
      await client.query(`DELETE FROM public.sites WHERE id=$1`, [req.params.id]);
      await securityAudit.record({
        ...auditFields(req), tenantId: current.tenant_id,
        eventType: 'system_admin.site.delete', resourceType: 'site', resourceId: req.params.id, action: 'delete', outcome: 'success',
        detail: { code: current.code, name: current.name, reason: reason.trim() },
      }, client);
    });
  } catch (e) {
    if (e && e.code === '23503') fail(409, 'Suppression refusée : des données réelles dépendent de ce site — archivez-le plutôt (voir Dépendances)');
    throw e;
  }
  res.json({ ok: true });
}));

/* ============================================================ */
/*  MISSION — TRANSFERT INTER-GROUPES DES SITES.                    */
/*                                                                   */
/*  DELETE (ci-dessus) ≠ TRANSFER (ci-dessous) : la suppression       */
/*  reste TOUJOURS bloquée dès qu'une donnée réelle dépend du site    */
/*  (blockingTotal). Le transfert change UNIQUEMENT sites.tenant_id   */
/*  — même site.id, même historique, mêmes données opérationnelles    */
/*  (zones/postes/Main courante/rondes/équipements/audit) : rendu     */
/*  possible par la migration 019 (FK ON UPDATE RESTRICT → CASCADE    */
/*  pour zones, → contrainte simple site_id/zone_id pour memberships, */
/*  jamais un contournement des protections DELETE existantes).       */
/*                                                                   */
/*  §5 mission (point critique) — DENY BY DEFAULT : toute appartenance*/
/*  SITE/ZONE-level active sous l'ANCIEN groupe et référençant ce      */
/*  site (directement, ou via une de ses zones) est ARCHIVÉE — jamais  */
/*  supprimée (immuable), jamais reportée aveuglément vers le nouveau  */
/*  groupe (ce serait décider arbitrairement qu'elle doit être        */
/*  conservée). Un administrateur peut ensuite ré-affecter            */
/*  explicitement l'utilisateur sous le nouveau groupe (onglet         */
/*  Utilisateurs déjà existant) s'il le juge légitime — jamais une     */
/*  reconduction automatique et implicite d'un droit d'accès.          */
/* ============================================================ */

// Classe chaque utilisateur ayant une appartenance active SITE/ZONE-level
// sous l'ancien groupe et référençant ce site — informatif (aperçu §14/
// rapport), l'ACTION reste uniforme (archivage de toutes) quelle que soit
// la classification : la classification n'assouplit jamais l'archivage,
// elle explique seulement à l'administrateur ce qui va se passer pour qui.
async function classifyAffectedMemberships(client, sourceTenantId, siteId, targetTenantId) {
  const rows = await client.all(
    `SELECT DISTINCT m.id AS membership_id, m.user_id, m.role, m.scope, u.username, u.nom_complet, u.role AS user_account_role
     FROM public.memberships m
     JOIN public.users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.status = 'active'
       AND (m.site_id = $2 OR m.zone_id IN (SELECT id FROM public.zones WHERE site_id = $2))
     ORDER BY u.username`,
    [sourceTenantId, siteId]);
  const classified = [];
  for (const r of rows) {
    let classification;
    if (r.user_account_role === 'admin') classification = 'global_admin_unaffected'; // C
    else {
      const hasTarget = await client.get(
        `SELECT 1 FROM public.memberships WHERE user_id=$1 AND tenant_id=$2 AND status='active' LIMIT 1`,
        [r.user_id, targetTenantId]);
      classification = hasTarget ? 'access_potentially_conservable' : 'access_will_be_revoked'; // A : B
    }
    classified.push({
      membership_id: r.membership_id, user_id: r.user_id, username: r.username,
      nom_complet: r.nom_complet, role: r.role, scope: r.scope, classification,
    });
  }
  return classified;
}

function transferImpactPayload(site, sourceGroup, targetGroup, deps, classified, codeCollision) {
  return {
    site: { id: site.id, code: site.code, name: site.name },
    source_group: sourceGroup ? { id: sourceGroup.id, code: sourceGroup.code, name: sourceGroup.name } : null,
    target_group: { id: targetGroup.id, code: targetGroup.code, name: targetGroup.name },
    already_in_target: site.tenant_id === targetGroup.id,
    code_collision: !!codeCollision,
    zones_count: deps.zones,
    posts_count: deps.postes,
    memberships_count: deps.memberships_total,
    events_count: deps.main_courante_events,
    rounds_count: deps.rounds,
    equipment_count: deps.equipment,
    round_circuits_count: deps.round_circuits,
    aps_count: deps.aps,
    presence_count: deps.presence,
    configs_count: deps.pcs01_config,
    not_scoped_by_site: deps.not_scoped_by_site,
    users_losing_access: classified.filter(c => c.classification === 'access_will_be_revoked').map(c => c.username),
    users_remaining_authorized: classified.filter(c => c.classification === 'access_potentially_conservable').map(c => c.username),
    users_global_admin: classified.filter(c => c.classification === 'global_admin_unaffected').map(c => c.username),
    memberships_to_archive: classified.length,
  };
}

// §14 mission — aperçu AVANT confirmation, aucune écriture. Mêmes calculs
// que le transfert réel (countSiteDependencies, classifyAffectedMemberships)
// — jamais un second calcul divergent.
router.get('/sites/:id/transfer-impact', wrap(async (req, res) => {
  const targetGroupId = req.query.target_group_id;
  if (!targetGroupId) fail(400, 'target_group_id requis');
  const result = await scope.withActorContext(req.user.id, async client => {
    const site = await client.get(`SELECT * FROM public.sites WHERE id=$1`, [req.params.id]);
    if (!site) fail(404, 'Site introuvable');
    const targetGroup = await client.get(`SELECT id, code, name, status FROM public.tenants WHERE id=$1`, [targetGroupId]);
    if (!targetGroup) fail(404, 'Groupe cible introuvable');
    const sourceGroup = await client.get(`SELECT id, code, name, status FROM public.tenants WHERE id=$1`, [site.tenant_id]);
    const deps = await countSiteDependencies(client, site.id);
    const classified = await classifyAffectedMemberships(client, site.tenant_id, site.id, targetGroupId);
    const codeCollision = await client.get(
      `SELECT id FROM public.sites WHERE tenant_id=$1 AND code=$2 AND id<>$3`, [targetGroupId, site.code, site.id]);
    return transferImpactPayload(site, sourceGroup, targetGroup, deps, classified, codeCollision);
  });
  res.json(result);
}));

// §7 mission — transaction atomique. §8 — verrou de ligne (FOR UPDATE)
// sérialise deux transferts concurrents du même site ; expected_source_
// group_id (capturé par le frontend à l'ouverture de l'assistant) permet
// de détecter qu'un AUTRE transfert a déjà eu lieu entre-temps → 409 propre
// demandant de recharger l'analyse, plutôt qu'un transfert silencieusement
// appliqué sur la base d'une analyse d'impact périmée.
router.post('/sites/:id/transfer', wrap(async (req, res) => {
  const b = req.body || {};
  const targetGroupId = b.target_group_id;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!targetGroupId) fail(400, 'Groupe cible requis');
  if (!reason) fail(400, 'Motif requis');
  const result = await scope.withActorContext(req.user.id, async client => {
    // 1. Verrouiller le site concerné.
    const site = await client.get(`SELECT * FROM public.sites WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!site) fail(404, 'Site introuvable');
    // 8. Concurrence : le groupe source a-t-il changé depuis l'ouverture
    // de l'assistant côté client ?
    if (b.expected_source_group_id && b.expected_source_group_id !== site.tenant_id) {
      fail(409, 'Le site a changé de groupe depuis l\'analyse d\'impact — veuillez recharger.');
    }
    // 2/3. Vérifier groupe source et destination.
    const sourceGroup = await client.get(`SELECT * FROM public.tenants WHERE id=$1`, [site.tenant_id]);
    const targetGroup = await client.get(`SELECT * FROM public.tenants WHERE id=$1`, [targetGroupId]);
    if (!targetGroup) fail(404, 'Groupe cible introuvable');
    if (targetGroup.status === 'archived') fail(409, 'Le groupe cible est archivé');
    if (site.tenant_id === targetGroupId) fail(409, 'Le site appartient déjà à ce groupe');
    const codeCollision = await client.get(
      `SELECT id FROM public.sites WHERE tenant_id=$1 AND code=$2 AND id<>$3`, [targetGroupId, site.code, site.id]);
    if (codeCollision) fail(409, `Un site avec le code « ${site.code} » existe déjà dans le groupe cible`);
    // 4. Permissions acteur : déjà garanti par requireAdmin (routes.js) —
    // capacité de compte globale, comme le reste de /admin/* (voir
    // en-tête de fichier). Aucune seconde porte inventée ici.
    // 5. Impact (avant modification).
    const deps = await countSiteDependencies(client, site.id);
    const classified = await classifyAffectedMemberships(client, site.tenant_id, site.id, targetGroupId);
    // 6. Traiter les appartenances incompatibles — archivage uniforme,
    // DENY BY DEFAULT (§5 mission), jamais une décision arbitraire de
    // conservation automatique.
    for (const m of classified) {
      await client.query(`UPDATE public.memberships SET status='archived' WHERE id=$1`, [m.membership_id]);
    }
    // 7. Modifier sites.tenant_id — les zones suivent via ON UPDATE CASCADE
    // (migration 019), même site.id, même historique conservés partout.
    const updated = await client.get(
      `UPDATE public.sites SET tenant_id=$1 WHERE id=$2 RETURNING ${SITE_COLUMNS}`,
      [targetGroupId, site.id]);
    // 9. Audit — détail à plat (sanitizeDetail refuse toute valeur imbriquée).
    await securityAudit.record({
      ...auditFields(req), tenantId: targetGroupId,
      eventType: 'system_admin.site.transfer', resourceType: 'site', resourceId: site.id, action: 'update', outcome: 'success',
      detail: {
        site_code: site.code, site_name: site.name,
        source_group_id: sourceGroup?.id || null, source_group_code: sourceGroup?.code || null, source_group_name: sourceGroup?.name || null,
        target_group_id: targetGroup.id, target_group_code: targetGroup.code, target_group_name: targetGroup.name,
        reason,
        zones_count: deps.zones, posts_count: deps.postes, memberships_total: deps.memberships_total,
        events_count: deps.main_courante_events, rounds_count: deps.rounds, equipment_count: deps.equipment,
        memberships_archived: classified.length,
      },
    }, client);
    // 10. Vérifier les invariants : même site.id, nouveau tenant_id réel.
    if (updated.id !== site.id) fail(500, 'Invariant violé : site.id modifié pendant le transfert');
    if (updated.tenant_id !== targetGroupId) fail(500, 'Invariant violé : le transfert n\'a pas appliqué le nouveau groupe');
    return {
      site: updated,
      previous_group: sourceGroup ? { id: sourceGroup.id, code: sourceGroup.code, name: sourceGroup.name } : null,
      new_group: { id: targetGroup.id, code: targetGroup.code, name: targetGroup.name },
      impact: transferImpactPayload(site, sourceGroup, targetGroup, deps, classified, null),
      memberships_archived: classified.map(c => ({ user_id: c.user_id, username: c.username, classification: c.classification })),
    };
  });
  res.json(result);
}));

router.use((err, req, res, next) => (err instanceof SiteError ? res.status(err.status).json({ error: err.message }) : next(err)));

module.exports = { router };
