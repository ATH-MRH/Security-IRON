const crypto  = require('node:crypto');
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./database');
const alerts  = require('./alerts');
const scope   = require('./scope');
const securityAudit = require('./security-audit');
const push    = require('./push');
const aiSummaries = require('./ai/summaries');
const mcEvents = require('./maincourante-events');
const mcWorkflows = require('./maincourante-workflows');
const adminSites = require('./admin-sites');
const adminGroups = require('./admin-groups');
const permissions = require('./permissions');

const router = express.Router();
const uid  = (p = 'ID') => p + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
const now  = () => new Date().toISOString();
const int  = v => parseInt(v, 10);
// PG-10 : IP/UA/request_id communs à tout événement audité depuis ce routeur.
const auditFields = req => ({
  requestId: req.requestId || null, origin: 'http',
  ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
});
const actorFields = req => ({ actorUserId: req.user?.id ?? null, actorUsername: req.user?.username ?? null, actorRole: req.user?.role ?? null });
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    // Attendu (pas fire-and-forget) avant d'écrire la réponse : recordBestEffort
    // n'échoue jamais (avale sa propre erreur), donc .then() suffit — pas besoin
    // d'un handler async ici (Express 4 ne relaie pas ses rejets).
    securityAudit.recordBestEffort({
      ...auditFields(req), ...actorFields(req),
      eventType: 'auth.access.denied', resourceType: 'admin', action: 'access', outcome: 'denied',
    }).then(() => res.status(403).json({ error: 'Accès administrateur requis' }));
    return;
  }
  next();
};

// PG-25 (hardening) : le rôle/l'existence du compte n'étaient jamais
// revérifiés après l'émission du JWT (jusqu'à 8h, backend/auth.js) sur ce
// routeur — un compte supprimé, ou un rôle rétrogradé (admin -> agent),
// restait pleinement actif jusqu'à expiration naturelle du token, y
// compris sur /admin/*. Seul backend/alerts.js revérifiait déjà (PG-10).
// Même mécanisme, étendu ici, avant toute autre vérification (y compris
// /admin/*, qui en a au moins autant besoin) : une session dont le compte
// n'existe plus est un événement de sécurité audité, jamais une simple
// 401 muette — même event_type qu'ailleurs (auth.session.revoked).
router.use(async (req, res, next) => {
  try {
    const fresh = req.user ? await db.get('SELECT id, username, role, status FROM public.users WHERE id=$1', [req.user.id]) : null;
    // LOT 8 (migration 016) : un compte bloqué APRÈS l'émission du JWT (jusqu'à
    // 8h) doit perdre l'accès immédiatement — même mécanisme PG-25 que pour un
    // compte supprimé ou rétrogradé, jamais une simple vérification au login.
    if (!fresh || fresh.status === 'blocked') {
      await securityAudit.recordBestEffort({
        ...auditFields(req), actorUserId: req.user?.id ?? null,
        eventType: 'auth.session.revoked', resourceType: 'session', action: 'access', outcome: 'denied',
        detail: fresh ? { reason: 'blocked' } : { reason: 'deleted' },
      });
      return res.status(401).json({ error: 'Session révoquée' });
    }
    req.user = fresh;
    next();
  } catch (e) { next(e); }
});

// PG-8 : toute donnée métier (tout sauf /admin/*, qui reste une capacité de
// compte/système gérée par le rôle JWT, pas par le périmètre memberships)
// exige un périmètre actif. Aucun filtrage de ligne n'est ajouté ici : les
// tables historiques n'ont ni tenant_id ni site_id (PG-6/PG-7 n'ont ajouté
// que le référentiel tenants/sites/zones, pas de colonne sur incidents,
// pietons, etc.) et il n'existe aujourd'hui qu'un tenant/site ; la porte
// « au moins une appartenance active » est donc la seule protection
// significative possible à ce stade — voir docs/postgresql-scope.md.
const withScope = scope.requireScope();
router.use((req, res, next) => (req.path.startsWith('/admin') ? next() : withScope(req, res, next)));
// PG-16 : les déclencheurs automatiques d'alerte (alerts.fromIncident/
// fromBadge, appelés plus bas avec ce même req.user) doivent connaître le
// tenant résolu ici — sans quoi une alerte créée depuis POST /incidents ou
// /pietons échouerait la contrainte NOT NULL de security_alerts.tenant_id
// (migration 009). Même convention que backend/alerts.js (PG-8/PG-10).
// PG-24 : requestId/correlationId/ipAddress/userAgentHeader posés en plus,
// pour que backend/ai/audit.js (résumé d'incident) ait le même contexte
// que les appels IA montés depuis backend/alerts.js — jamais recalculé
// différemment ici.
router.use((req, res, next) => {
  if (req.tenantId != null && req.user) req.user.tenantId = req.tenantId;
  if (req.user) {
    req.user.requestId = req.requestId || null;
    req.user.correlationId = req.correlationId || null;
    req.user.ipAddress = req.ip || null;
    req.user.userAgentHeader = req.headers['user-agent'] || null;
  }
  next();
});

/* ============================================================ */
/*  ADMINISTRATION SYSTÈME                                      */
/* ============================================================ */
// LOT 3/4/5 : Sites — additif, ne remplace rien. Même gate requireAdmin que
// le reste de /admin/* (routes.js:70 contourne requireScope pour ce préfixe
// entier : la création/l'archivage d'un site est une capacité de compte
// globale, pas scope-limitée).
router.use('/admin', requireAdmin, adminSites.router);
router.use('/admin', requireAdmin, adminGroups.router);

// LOT 9 : référentiel Rôles & Permissions — lecture seule, statique
// (backend/permissions.js, jamais un éditeur dynamique — voir son
// en-tête). N'EST PAS l'assignation d'un rôle à un utilisateur pour un
// site donné (memberships), qui reste hors périmètre de ce lot.
router.get('/admin/roles', requireAdmin, (req, res) => {
  res.json({ roles: permissions.ROLES, modules: permissions.MODULES, verbs: permissions.VERBS, permissions: permissions.PERMISSIONS });
});

router.get('/admin/users', requireAdmin, async (req, res, next) => {
  try {
    res.json(await db.all('SELECT id, username, nom_complet, role, status, sos_recipient, created_at, updated_at FROM users ORDER BY role, username'));
  } catch (e) { next(e); }
});

router.post('/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const u = req.body || {};
    if (!u.username || !u.password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    const exists = await db.get('SELECT id FROM users WHERE username=$1', [u.username]);
    if (exists) return res.status(409).json({ error: 'Identifiant déjà utilisé' });
    const hash = await bcrypt.hash(u.password, 10);
    // PG-10 : l'audit success partage la transaction de la mutation — si l'un
    // échoue, l'autre est annulé avec lui (jamais de faux success).
    const row = await db.transaction(async client => {
      const created = await client.get(
        `INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)
         RETURNING id, username, nom_complet, role, created_at`,
        [u.username.trim(), hash, u.nom_complet || u.username.trim(), u.role || 'agent']
      );
      await securityAudit.record({
        ...auditFields(req), ...actorFields(req),
        eventType: 'user.create', resourceType: 'user', resourceId: String(created.id), action: 'create', outcome: 'success',
        detail: { username: created.username, role: created.role },
      }, client);
      return created;
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const u = req.body || {};
    const current = await db.get('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const row = await db.transaction(async client => {
      await client.query(
        'UPDATE users SET nom_complet=$1, role=$2 WHERE id=$3',
        [u.nom_complet || current.nom_complet, u.role || current.role, req.params.id]
      );
      const passwordChanged = Boolean(u.password);
      if (passwordChanged) {
        await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(u.password, 10), req.params.id]);
      }
      await securityAudit.record({
        ...auditFields(req), ...actorFields(req),
        eventType: 'user.update', resourceType: 'user', resourceId: String(req.params.id), action: 'update', outcome: 'success',
        detail: { changed_fields: ['nom_complet', 'role', ...(passwordChanged ? ['password'] : [])].filter((f, i, a) => a.indexOf(f) === i) },
      }, client);
      return client.get('SELECT id, username, nom_complet, role, created_at FROM users WHERE id=$1', [req.params.id]);
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    const admins = int((await db.get(`SELECT COUNT(*) as c FROM users WHERE role='admin'`)).c);
    const target = await db.get('SELECT role, username FROM users WHERE id=$1', [id]);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (target.role === 'admin' && admins <= 1) return res.status(400).json({ error: 'Au moins un administrateur doit rester' });
    try {
      await db.transaction(async client => {
        await client.query('DELETE FROM users WHERE id=$1', [id]);
        await securityAudit.record({
          ...auditFields(req), ...actorFields(req),
          eventType: 'user.delete', resourceType: 'user', resourceId: String(id), action: 'delete', outcome: 'success',
          detail: { username: target.username, role: target.role },
        }, client);
      });
    } catch (e) {
      // PG-7/PG-8 : memberships référence users en RESTRICT et memberships est
      // append-only (aucune suppression possible). Un compte ayant eu une
      // appartenance ne peut donc plus jamais être supprimé — archiver son
      // statut est le chemin prévu. Message métier clair plutôt qu'un 500.
      if (e && e.code === '23503') return res.status(409).json({ error: 'Compte non supprimable : appartenances actives — archivez-les plutôt' });
      throw e;
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// LOT 8 (migration 016) : transition de statut dédiée, distincte de PUT
// /admin/users/:id (identité/rôle) — même raison que sites/:id/status : un
// blocage/déblocage est un événement métier propre, mérite sa propre entrée
// d'audit plutôt que d'être noyé dans "changed_fields".
router.put('/admin/users/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { status, reason } = req.body || {};
    if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    if (id === req.user.id && status === 'blocked') return res.status(400).json({ error: 'Impossible de bloquer votre propre compte' });
    const current = await db.get('SELECT id, username, role, status FROM users WHERE id=$1', [id]);
    if (!current) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (current.status === status) return res.status(409).json({ error: 'Le compte est déjà dans ce statut' });
    const row = await db.transaction(async client => {
      const updated = await client.get(
        `UPDATE users SET status=$1, blocked_at=CASE WHEN $1='blocked' THEN now() ELSE NULL END WHERE id=$2
         RETURNING id, username, nom_complet, role, status, created_at, updated_at`,
        [status, id]);
      await securityAudit.record({
        ...auditFields(req), ...actorFields(req),
        eventType: 'user.status_change', resourceType: 'user', resourceId: String(id), action: 'update', outcome: 'success',
        detail: { before_status: current.status, after_status: status, reason: reason || null },
      }, client);
      return updated;
    });
    res.json(row);
  } catch (e) { next(e); }
});

// Bouton SOS réel (mission « panic button ») — décision produit validée :
// désignation par simple case à cocher PAR COMPTE (migration 021), même
// convention que PUT /admin/users/:id/status ci-dessus (transition dédiée,
// sa propre entrée d'audit, distincte du PUT générique identité/rôle).
// Le déclenchement effectif (POST /alerts/sos) lit ce booléen à chaque
// création d'alerte SOS — voir backend/alert-core/recipients.js
// #broadcastToSosDesignated, jamais un second mécanisme.
router.put('/admin/users/:id/sos-recipient', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { sos_recipient } = req.body || {};
    if (typeof sos_recipient !== 'boolean') return res.status(400).json({ error: 'sos_recipient (booléen) requis' });
    const current = await db.get('SELECT id, username, sos_recipient FROM users WHERE id=$1', [id]);
    if (!current) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (current.sos_recipient === sos_recipient) return res.status(409).json({ error: 'Déjà dans cet état' });
    const row = await db.transaction(async client => {
      const updated = await client.get(
        `UPDATE users SET sos_recipient=$1 WHERE id=$2
         RETURNING id, username, nom_complet, role, status, sos_recipient, created_at, updated_at`,
        [sos_recipient, id]);
      await securityAudit.record({
        ...auditFields(req), ...actorFields(req),
        eventType: 'user.sos_recipient_change', resourceType: 'user', resourceId: String(id), action: 'update', outcome: 'success',
        detail: { before: current.sos_recipient, after: sos_recipient },
      }, client);
      return updated;
    });
    res.json(row);
  } catch (e) { next(e); }
});

// PG-10 : lecture du journal de sécurité global. requireAdmin (rôle JWT) est
// une première porte grossière ; l'application réelle est la RLS (migration
// 006, policy security_audit_soc_read) — via withActorContext, seul un
// membership actif de rôle 'soc' voit quoi que ce soit, et seulement sous son
// propre tenant. Un « admin » JWT sans membership soc reçoit donc une liste
// vide, pas une erreur : la RLS est fail-closed par construction (PG-9).
router.get('/admin/security-audit', requireAdmin, async (req, res, next) => {
  try {
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 500);
    const conditions = [];
    const params = [];
    const push = (col, value) => { params.push(value); conditions.push(`${col} = $${params.length}`); };
    if (typeof q.event_type === 'string' && q.event_type) push('event_type', q.event_type);
    if (typeof q.resource_type === 'string' && q.resource_type) push('resource_type', q.resource_type);
    if (typeof q.actor === 'string' && q.actor) push('actor_username', q.actor);
    for (const [param, op] of [['from', '>='], ['to', '<=']]) {
      if (typeof q[param] !== 'string' || !q[param]) continue;
      const parsed = new Date(q[param]);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: `Paramètre ${param} invalide` });
      params.push(parsed.toISOString()); conditions.push(`created_at ${op} $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await scope.withActorContext(req.user.id, client => client.all(
      `SELECT id, created_at, request_id, correlation_id, actor_user_id, actor_username, actor_role,
              tenant_id, site_id, zone_id, event_type, resource_type, resource_id, action, outcome,
              origin, ip_address, user_agent, detail
       FROM public.security_audit ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params));
    res.json(rows);
  } catch (e) { next(e); }
});

// PG-28 (revue adversariale, correctif de sécurité) : cette route créait
// jusqu'ici un compte 'system_admin' avec un mot de passe CODÉ EN DUR
// ('securisite2026'), visible dans le code source et renvoyé en clair à
// chaque appel — une porte dérobée d'administrateur exploitable par
// quiconque lit le dépôt ou observe une réponse HTTP. `frontend/js/app.js
// #ensureSystemAdmin()` l'appelle réellement (page Utilisateurs). Corrigé :
// mot de passe aléatoire (crypto.randomBytes, jamais devinable), généré et
// affiché UNE SEULE FOIS à la création ; un appel ultérieur sur un compte
// déjà existant ne révèle ni ne réinitialise jamais le mot de passe
// (password: null) — cohérent avec backend/db/postgresql/create-admin.js,
// qui n'affiche/n'enregistre jamais non plus de mot de passe en clair.
router.post('/admin/system-admin', requireAdmin, async (req, res, next) => {
  try {
    const username = 'system_admin';
    const existing = await db.get(
      'SELECT id, username, nom_complet, role, created_at FROM users WHERE username=$1', [username]);
    if (existing) {
      res.json({ username, password: null, user: existing, created: false });
      return;
    }
    const password = crypto.randomBytes(18).toString('base64url');
    await db.query(
      `INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)`,
      [username, await bcrypt.hash(password, 10), 'Administrateur système', 'admin']
    );
    const user = await db.get('SELECT id, username, nom_complet, role, created_at FROM users WHERE username=$1', [username]);
    res.json({ username, password, user, created: true });
  } catch (e) { next(e); }
});

router.get('/admin/system', requireAdmin, async (req, res, next) => {
  try {
    const tables = ['users','employes','visiteurs','vehicules','pietons','incidents','badges','main_courante','lapi_lectures'];
    const counts = {};
    for (const t of tables) {
      counts[t] = int((await db.get(`SELECT COUNT(*) as c FROM ${t}`)).c);
    }
    // LOT 2 (Administration Système — cockpit) : KPI réels, jamais une
    // constante. "caméras si réellement disponibles" : backend/camera-registry.js
    // est un fichier JSON, pas une table — comptée séparément, jamais forcée à
    // zéro pour ne pas laisser croire "aucune caméra configurée" à tort.
    let camerasCount = null;
    try { camerasCount = require('./camera-registry').all().length; } catch { camerasCount = null; }
    // sites est protégée par RLS (migration 005/017) : un db.all() nu y
    // verrait silencieusement zéro ligne sous le rôle applicatif restreint
    // (même classe de bug déjà trouvée et corrigée dans backend/admin-sites.js).
    // users/mc_posts/round_circuits ne sont pas RLS-protégées, lues normalement.
    const [sitesByStatus, usersByStatus, postesCount, roundsCount] = await Promise.all([
      scope.withActorContext(req.user.id, client => client.all(`SELECT status, count(*)::int AS c FROM public.sites GROUP BY status`)),
      db.all(`SELECT status, count(*)::int AS c FROM public.users GROUP BY status`),
      db.get(`SELECT count(*)::int AS c FROM public.mc_posts WHERE status='active'`),
      db.get(`SELECT count(*)::int AS c FROM public.round_circuits`),
    ]);
    const byStatus = rows => Object.fromEntries(rows.map(r => [r.status, r.c]));
    const sitesStatus = byStatus(sitesByStatus);
    const usersStatus = byStatus(usersByStatus);
    let pushConfigured = false;
    try { pushConfigured = push.getProvider() !== require('./push/fake-provider'); } catch { pushConfigured = false; }
    res.json({
      counts, database: 'PostgreSQL', server_time: now(), user: req.user,
      kpis: {
        sites_total: (sitesByStatus || []).reduce((a, r) => a + r.c, 0),
        sites_active: sitesStatus.active || 0, sites_suspended: sitesStatus.suspended || 0, sites_archived: sitesStatus.archived || 0,
        users_total: (usersByStatus || []).reduce((a, r) => a + r.c, 0),
        users_active: usersStatus.active || 0, users_blocked: usersStatus.blocked || 0,
        maincourante_codes: mcEvents.EVENTS.length,
        postes_actifs: postesCount.c,
        round_circuits: roundsCount.c,
        cameras: camerasCount, // null = registre indisponible/illisible, jamais 0 par défaut
      },
      health: {
        application: 'operational', // ce endpoint répond : trivialement vrai, jamais une constante affichée seule
        postgresql: 'operational', // les requêtes ci-dessus ont réussi ; sinon l'erreur remonte via next(e)
        push: pushConfigured ? 'operational' : 'not_configured',
        cameras: camerasCount == null ? 'unavailable' : 'operational', // registre vide (0) reste "operational" — absence de caméra ≠ registre en panne
        api: 'operational',
      },
    });
  } catch (e) { next(e); }
});

// LOT 2 (Vue générale — recette visuelle) : widgets cockpit à données
// réelles, endpoint dédié distinct de /admin/system (qui reste les
// compteurs bruts déjà utilisés ailleurs). sites (RLS, migrations 005/017)
// lu via withActorContext ; main_courante/security_audit non RLS pour la
// première, RLS pour la seconde (migration 006) — même mécanisme que
// /admin/security-audit existant. pg_database_size() est une métrique
// PostgreSQL réelle (jamais une valeur inventée) : seule donnée "stockage"
// disponible aujourd'hui, faute d'un widget disque/volume dédié.
router.get('/admin/overview', requireAdmin, async (req, res, next) => {
  try {
    const { recentActivity, sitesByStatus, topSites } = await scope.withActorContext(req.user.id, async client => ({
      recentActivity: await client.all(
        `SELECT id, created_at, actor_username, event_type, resource_type, resource_id, outcome
         FROM public.security_audit ORDER BY created_at DESC, id DESC LIMIT 8`),
      sitesByStatus: await client.all(`SELECT status, count(*)::int AS c FROM public.sites GROUP BY status`),
      topSites: await client.all(
        `SELECT s.id, s.name, count(mc.id)::int AS c
         FROM public.sites s JOIN public.main_courante mc ON mc.site_id = s.id
         GROUP BY s.id, s.name ORDER BY c DESC LIMIT 5`),
    }));
    const [mc7d, mcByCategory, storage] = await Promise.all([
      db.get(`SELECT count(*)::int AS c FROM public.main_courante WHERE created_at >= now() - interval '7 days'`),
      db.all(`SELECT categorie, count(*)::int AS c FROM public.main_courante WHERE categorie IS NOT NULL GROUP BY categorie ORDER BY c DESC LIMIT 10`),
      db.get(`SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty, pg_database_size(current_database())::bigint AS bytes`),
    ]);
    res.json({
      recent_activity: recentActivity,
      sites_by_status: Object.fromEntries(sitesByStatus.map(r => [r.status, r.c])),
      maincourante_last_7_days: mc7d.c,
      maincourante_by_category: mcByCategory,
      top_sites: topSites,
      storage: { pretty: storage.pretty, bytes: Number(storage.bytes) },
    });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  EMPLOYÉS                                                    */
/* ============================================================ */
router.get('/employes', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM employes ORDER BY matricule'));
  } catch (e) { next(e); }
});

router.post('/employes', requireAdmin, async (req, res, next) => {
  try {
    const e = req.body;
    const idx = int((await db.get('SELECT COUNT(*) as c FROM employes')).c);
    const id  = uid('EMP');
    const row = await db.get(
      `INSERT INTO employes (id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, e.matricule || 'M'+(1000+idx), e.prenom, e.nom, e.service, e.fonction,
       e.badge || 'BDG-'+(2000+idx), e.niveau || 'N1', e.statut || 'actif', now(), req.user?.username || null]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/employes/:id', requireAdmin, async (req, res, next) => {
  try {
    const e   = req.body;
    const row = await db.get(
      `UPDATE employes SET service=$1, fonction=$2, niveau=$3, statut=$4 WHERE id=$5 RETURNING *`,
      [e.service, e.fonction, e.niveau, e.statut, req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/employes/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM employes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  VISITEURS                                                   */
/* ============================================================ */
router.get('/visiteurs', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM visiteurs ORDER BY arrivee DESC'));
  } catch (e) { next(e); }
});

router.post('/visiteurs', async (req, res, next) => {
  try {
    const v   = req.body;
    const row = await db.get(
      `INSERT INTO visiteurs (id, prenom, nom, societe, hote, motif, arrivee, badge, statut, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uid('VIS'), v.prenom, v.nom, v.societe, v.hote, v.motif, v.arrivee || now(), null, 'attendu', req.user?.username || null]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/visiteurs/:id/checkin', async (req, res, next) => {
  try {
    const c     = int((await db.get('SELECT COUNT(*) as c FROM visiteurs')).c);
    const badge = 'V-' + (7000 + c);
    const row   = await db.get(
      `UPDATE visiteurs SET statut='present', badge=$1 WHERE id=$2 RETURNING *`,
      [badge, req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/visiteurs/:id/checkout', async (req, res, next) => {
  try {
    const row = await db.get(
      `UPDATE visiteurs SET statut='parti' WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/visiteurs/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM visiteurs WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  VÉHICULES                                                   */
/* ============================================================ */
router.get('/vehicules', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM vehicules ORDER BY entree DESC'));
  } catch (e) { next(e); }
});

router.post('/vehicules', async (req, res, next) => {
  try {
    const v   = req.body;
    const row = await db.get(
      `INSERT INTO vehicules (id, plaque, type, conducteur, societe, motif, entree, sortie, statut, place_parking, lapi_photo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [uid('VEH'), (v.plaque||'').toUpperCase(), v.type, v.conducteur, v.societe||'',
       v.motif, v.entree||now(), null, 'dans', v.placeParking||null, v.lapiPhoto||null, req.user?.username || null]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/vehicules/:id/sortie', async (req, res, next) => {
  try {
    const row = await db.get(
      `UPDATE vehicules SET statut='dehors', sortie=$1 WHERE id=$2 RETURNING *`,
      [now(), req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/vehicules/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM vehicules WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  PIÉTONS                                                     */
/* ============================================================ */
router.get('/pietons', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM pietons ORDER BY datetime DESC LIMIT 1000'));
  } catch (e) { next(e); }
});

router.post('/pietons', async (req, res, next) => {
  try {
    const p = req.body;
    // Une seule transaction PostgreSQL : le passage et l'éventuelle alerte badge
    // (verrou advisory conservé jusqu'au COMMIT parent) réussissent ou échouent ensemble.
    const row = await db.transaction(async client => {
      const record = await client.query(
        `INSERT INTO pietons (id, datetime, nom, badge, type, point, sens, resultat, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [uid('PED'), p.datetime || now(), p.nom, p.badge, p.type, p.point, p.sens, p.resultat, p.notes || '', req.user?.username || null]
      );
      const created = record.rows[0];
      await alerts.fromBadge(created, req.user, client);
      return created;
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/pietons/:id', requireAdmin, async (req, res, next) => {
  try {
    const p   = req.body;
    const row = await db.get(
      `UPDATE pietons SET datetime=$1, nom=$2, badge=$3, type=$4, point=$5, sens=$6, resultat=$7, notes=$8
       WHERE id=$9 RETURNING *`,
      [p.datetime, p.nom, p.badge, p.type, p.point, p.sens, p.resultat, p.notes||'', req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Pointage introuvable' });
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/pietons/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM pietons WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  INCIDENTS                                                   */
/* ============================================================ */
router.get('/incidents', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM incidents ORDER BY datetime DESC'));
  } catch (e) { next(e); }
});

// PG-20 : résumé IA d'un incident — même périmètre que GET /incidents
// ci-dessus, aucun filtrage supplémentaire inventé (voir backend/ai/summaries.js).
router.get('/incidents/:id/summary', async (req, res, next) => {
  try { res.json(await aiSummaries.summarizeIncident(req.params.id, req.user, db)); }
  catch (e) { next(e); }
});

router.post('/incidents', async (req, res, next) => {
  try {
    const i = req.body;
    // Une seule transaction PostgreSQL : incident + alerte + audit + notifications
    // sont validés ou annulés ensemble.
    const row = await db.transaction(async client => {
      // Référence historique dérivée d'un COUNT(*). Sérialisée par un verrou
      // advisory transactionnel dédié (relâché au COMMIT) : deux créations
      // simultanées ne peuvent plus calculer le même compteur ni violer
      // incidents.ref UNIQUE. Le format « INC-<2026100+n> » est inchangé ;
      // une référence explicite fournie par l'appelant court-circuite le compteur.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('securisite:incidents:ref')::bigint)");
      const c = int((await client.get('SELECT COUNT(*) AS c FROM incidents')).c);
      const record = await client.query(
        `INSERT INTO incidents (id, ref, datetime, type, lieu, gravite, statut, agent, description, actions, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [uid('INC'), i.ref || 'INC-' + (2026100 + c), i.datetime || now(), i.type,
         i.lieu, i.gravite, i.statut || 'ouvert', i.agent || req.user?.username || null, i.description || '', i.actions || '', req.user?.username || null]
      );
      const created = record.rows[0];
      await alerts.fromIncident(created, req.user, client);
      return created;
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/incidents/:id', async (req, res, next) => {
  try {
    const i       = req.body;
    const current = await db.get('SELECT * FROM incidents WHERE id=$1', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Incident introuvable' });
    const row = await db.get(
      `UPDATE incidents SET statut=$1, actions=$2 WHERE id=$3 RETURNING *`,
      [i.statut ?? current.statut, i.actions ?? current.actions ?? '', req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/incidents/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM incidents WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  BADGES                                                      */
/* ============================================================ */
router.get('/badges', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM badges ORDER BY emis DESC'));
  } catch (e) { next(e); }
});

router.post('/badges', requireAdmin, async (req, res, next) => {
  try {
    const b   = req.body;
    const ref = b.ref || (b.type + '-' + Math.floor(Math.random() * 9000 + 1000));
    const row = await db.get(
      `INSERT INTO badges (ref, nom, type, niveau, emis, validite, etat, societe, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (ref) DO UPDATE SET
         nom=EXCLUDED.nom, type=EXCLUDED.type, niveau=EXCLUDED.niveau,
         emis=EXCLUDED.emis, validite=EXCLUDED.validite, etat=EXCLUDED.etat, societe=EXCLUDED.societe
       RETURNING *`,
      [ref, b.nom, b.type, b.niveau, b.emis||now(), b.validite, b.etat||'actif', b.societe||'', req.user?.username || null]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/badges/:ref', requireAdmin, async (req, res, next) => {
  try {
    const b       = req.body || {};
    const current = await db.get('SELECT * FROM badges WHERE ref=$1', [req.params.ref]);
    if (!current) return res.status(404).json({ error: 'Badge introuvable' });
    const row = await db.get(
      `UPDATE badges SET nom=$1, type=$2, niveau=$3, validite=$4, etat=$5, societe=$6 WHERE ref=$7 RETURNING *`,
      [b.nom||current.nom, b.type||current.type, b.niveau||current.niveau,
       b.validite||current.validite, b.etat||current.etat, b.societe??current.societe, req.params.ref]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/badges/:ref', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM badges WHERE ref=$1', [req.params.ref]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  PARKING                                                     */
/* ============================================================ */
router.get('/parking', async (req, res, next) => {
  try {
    const zones = await db.all('SELECT * FROM parking_zones ORDER BY zone');
    for (const z of zones) {
      z.places = await db.all('SELECT * FROM parking_places WHERE zone=$1 ORDER BY num', [z.zone]);
    }
    const mouvements = await db.all('SELECT * FROM parking_mouvements ORDER BY datetime DESC LIMIT 100');
    res.json({ zones, mouvements });
  } catch (e) { next(e); }
});

router.put('/parking/places/:num', async (req, res, next) => {
  try {
    const { etat, plaque } = req.body;
    const place = await db.get('SELECT * FROM parking_places WHERE num=$1', [req.params.num]);
    if (!place) return res.status(404).json({ error: 'Place introuvable' });

    await db.query('UPDATE parking_places SET etat=$1, plaque=$2 WHERE num=$3', [etat, plaque||null, req.params.num]);

    if (etat === 'occupe') {
      await db.query(
        `INSERT INTO parking_mouvements (id, datetime, plaque, place, zone, action, duree, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid('MVT'), now(), plaque||'?', req.params.num, place.zone, 'entree', 0, req.user?.username || null]
      );
    } else if (place.etat === 'occupe' && etat === 'libre') {
      await db.query(
        `INSERT INTO parking_mouvements (id, datetime, plaque, place, zone, action, duree, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid('MVT'), now(), place.plaque||'?', req.params.num, place.zone, 'sortie', Math.floor(Math.random()*270)+30, req.user?.username || null]
      );
    }
    res.json(await db.get('SELECT * FROM parking_places WHERE num=$1', [req.params.num]));
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  MAIN COURANTE                                               */
/* ============================================================ */
router.get('/maincourante', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM main_courante ORDER BY datetime DESC LIMIT 1000'));
  } catch (e) { next(e); }
});

// Référentiel de codification : source unique servie au frontend (grille de
// saisie codifiée) — évite qu'une copie cliente diverge silencieusement du
// référentiel qui fait foi côté serveur (celui utilisé par la validation de
// POST /maincourante ci-dessous).
router.get('/maincourante/events', (req, res) => {
  res.json({ categories: mcEvents.CATEGORIES, events: mcEvents.EVENTS });
});

router.post('/maincourante', async (req, res, next) => {
  try {
    const e = req.body;
    // Référentiel de codification (grille métier) : un code/catégorie fourni
    // est revalidé contre le référentiel serveur, jamais accepté tel quel —
    // le frontend n'est pas une autorité (un body forgé ne peut pas associer
    // un code réel à une catégorie inventée). Une entrée sans code (flux
    // libre historique) reste acceptée à l'identique.
    const selection = mcEvents.validateEventSelection({ code: e.code, categorie: e.categorie });
    if (selection.error) return res.status(400).json({ error: selection.error });
    const row = await db.get(
      `INSERT INTO main_courante (id, datetime, poste, agent, type, lieu, description, priorite, created_by, code, categorie)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [uid('MC'), e.datetime||now(), e.poste, e.agent || req.user?.username || null, e.type, e.lieu||'—', e.description, e.priorite||'normale', req.user?.username || null, selection.code, selection.categorie]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/maincourante/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM main_courante WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Moteur de workflows (portage PostgreSQL propre, migration 014) : routes
// additionnelles sous /maincourante/*, jamais un remplacement des routes
// ci-dessus (GET/POST /maincourante, GET /maincourante/events restent le
// flux libre historique + référentiel, inchangés — réutilisés tels quels
// par ce moteur pour la validation code/catégorie).
router.use('/maincourante', mcWorkflows.router);

/* ============================================================ */
/*  LAPI                                                        */
/* ============================================================ */
router.get('/lapi', async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM lapi_lectures ORDER BY datetime DESC LIMIT 50'));
  } catch (e) { next(e); }
});

router.post('/lapi', async (req, res, next) => {
  try {
    const l   = req.body;
    const row = await db.get(
      `INSERT INTO lapi_lectures (id, datetime, plaque_detectee, plaque_raw, confiance, image, statut, action, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uid('LAPI'), l.datetime||now(), l.plaqueDetectee||'?', l.plaqueRaw||'',
       l.confiance||0, l.image||'', l.statut||'detecte', l.action||null, req.user?.username || null]
    );
    await db.query(
      `DELETE FROM lapi_lectures WHERE id NOT IN (SELECT id FROM lapi_lectures ORDER BY datetime DESC LIMIT 50)`
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/lapi/:id', async (req, res, next) => {
  try {
    const l   = req.body;
    const row = await db.get(
      `UPDATE lapi_lectures SET statut=$1, action=$2 WHERE id=$3 RETURNING *`,
      [l.statut, l.action, req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/lapi', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM lapi_lectures');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  RAPPORTS                                                    */
/* ============================================================ */
router.get('/rapports', async (req, res, next) => {
  try {
    const periode = parseInt(req.query.periode) || 30;
    const limite  = new Date(Date.now() - periode * 24 * 3600 * 1000).toISOString();
    const [inc, piet, veh, empR] = await Promise.all([
      db.all(`SELECT * FROM incidents WHERE datetime > $1`, [limite]),
      db.all(`SELECT * FROM pietons WHERE datetime > $1`, [limite]),
      db.all(`SELECT * FROM vehicules WHERE entree > $1`, [limite]),
      db.get(`SELECT COUNT(*) as c FROM employes WHERE statut='actif'`),
    ]);
    res.json({ periode, incidents: inc, pietons: piet, vehicules: veh, employes_actifs: int(empR.c) });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  PARAMÈTRES                                                  */
/* ============================================================ */
router.get('/parametres', async (req, res, next) => {
  try {
    const rows   = await db.all('SELECT cle, valeur FROM parametres');
    const result = {};
    rows.forEach(r => result[r.cle] = r.valeur);
    res.json(result);
  } catch (e) { next(e); }
});

router.put('/parametres', requireAdmin, async (req, res, next) => {
  try {
    const entries = Object.entries(req.body || {});
    // Toutes les mutations dans une seule transaction : pas d'écriture partielle,
    // rollback complet si l'une d'elles échoue.
    await db.transaction(async client => {
      for (const [k, v] of entries) {
        await client.query(
          `INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=excluded.valeur`,
          [k, String(v)]
        );
      }
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  STATS DASHBOARD                                             */
/* ============================================================ */
router.get('/stats/dashboard', async (req, res, next) => {
  try {
    const last24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [empActifs, visTotal, visPresent, veh24h, vehSite, incOuverts, incCritiques] = await Promise.all([
      db.get(`SELECT COUNT(*) as c FROM employes WHERE statut='actif'`),
      db.get(`SELECT COUNT(*) as c FROM visiteurs`),
      db.get(`SELECT COUNT(*) as c FROM visiteurs WHERE statut='present'`),
      db.get(`SELECT COUNT(*) as c FROM vehicules WHERE entree > $1`, [last24]),
      db.get(`SELECT COUNT(*) as c FROM vehicules WHERE statut='dans'`),
      db.get(`SELECT COUNT(*) as c FROM incidents WHERE statut != 'resolu'`),
      db.get(`SELECT COUNT(*) as c FROM incidents WHERE statut != 'resolu' AND gravite='critique'`),
    ]);
    res.json({
      employes_actifs:    int(empActifs.c),
      visiteurs_total:    int(visTotal.c),
      visiteurs_present:  int(visPresent.c),
      vehicules_24h:      int(veh24h.c),
      vehicules_sur_site: int(vehSite.c),
      incidents_ouverts:  int(incOuverts.c),
      incidents_critiques:int(incCritiques.c),
    });
  } catch (e) { next(e); }
});

/* ============================================================ */
/*  PUSH (PG-13)                                                */
/* ============================================================ */
// Requiert un périmètre actif (withScope, en tête de fichier) : sans
// membership, aucun événement ne serait jamais poussé de toute façon.
// PCS01 (Lot B) : clé publique VAPID, si un fournisseur réel a été activé
// (docs/push.md — HUMAN CHECKPOINT ; le fournisseur réel existe depuis le
// Lot D mais reste inactif tant que les trois variables SECURISITE_VAPID_*
// ne sont pas explicitement fournies en production). Une clé PUBLIQUE
// n'est pas un secret (c'est tout son
// principe, Web Push standard) ; exposée derrière l'auth existante du
// routeur par simple cohérence avec le reste de /push, jamais parce
// qu'elle le nécessiterait. `null` tant qu'aucun fournisseur réel n'est
// configuré — le frontend doit alors proposer les notifications comme
// indisponibles, jamais fabriquer une capacité qui n'existe pas.
router.get('/push/public-key', (req, res) => {
  res.json({ publicKey: process.env.SECURISITE_VAPID_PUBLIC_KEY || null });
});

router.post('/push/subscribe', async (req, res, next) => {
  try {
    res.json(await push.subscribe(req.user.id, req.body));
  } catch (e) { next(e); }
});

router.delete('/push/subscribe', async (req, res, next) => {
  try {
    res.json(await push.unsubscribe(req.user.id, req.body?.endpoint));
  } catch (e) { next(e); }
});

module.exports = router;
