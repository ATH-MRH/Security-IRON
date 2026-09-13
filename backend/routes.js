const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./database');
const alerts  = require('./alerts');
const scope   = require('./scope');
const securityAudit = require('./security-audit');
const push    = require('./push');

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

/* ============================================================ */
/*  ADMINISTRATION SYSTÈME                                      */
/* ============================================================ */
router.get('/admin/users', requireAdmin, async (req, res, next) => {
  try {
    res.json(await db.all('SELECT id, username, nom_complet, role, created_at FROM users ORDER BY role, username'));
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

router.post('/admin/system-admin', requireAdmin, async (req, res, next) => {
  try {
    const username = 'system_admin';
    const password = 'securisite2026';
    const existing = await db.get('SELECT id FROM users WHERE username=$1', [username]);
    if (!existing) {
      await db.query(
        `INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)`,
        [username, await bcrypt.hash(password, 10), 'Administrateur système', 'admin']
      );
    }
    const user = await db.get('SELECT id, username, nom_complet, role, created_at FROM users WHERE username=$1', [username]);
    res.json({ username, password, user });
  } catch (e) { next(e); }
});

router.get('/admin/system', requireAdmin, async (req, res, next) => {
  try {
    const tables = ['users','employes','visiteurs','vehicules','pietons','incidents','badges','main_courante','lapi_lectures'];
    const counts = {};
    for (const t of tables) {
      counts[t] = int((await db.get(`SELECT COUNT(*) as c FROM ${t}`)).c);
    }
    res.json({ counts, database: 'PostgreSQL', server_time: now(), user: req.user });
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

router.post('/maincourante', async (req, res, next) => {
  try {
    const e   = req.body;
    const row = await db.get(
      `INSERT INTO main_courante (id, datetime, poste, agent, type, lieu, description, priorite, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uid('MC'), e.datetime||now(), e.poste, e.agent || req.user?.username || null, e.type, e.lieu||'—', e.description, e.priorite||'normale', req.user?.username || null]
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
