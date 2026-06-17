const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('./database');

const router = express.Router();
const uid  = (p = 'ID') => p + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
const now  = () => new Date().toISOString();
const int  = v => parseInt(v, 10);
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Accès administrateur requis' });
  next();
};

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
    const row = await db.get(
      `INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)
       RETURNING id, username, nom_complet, role, created_at`,
      [u.username.trim(), hash, u.nom_complet || u.username.trim(), u.role || 'agent']
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const u = req.body || {};
    const current = await db.get('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Utilisateur introuvable' });
    await db.query(
      'UPDATE users SET nom_complet=$1, role=$2 WHERE id=$3',
      [u.nom_complet || current.nom_complet, u.role || current.role, req.params.id]
    );
    if (u.password) {
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(u.password, 10), req.params.id]);
    }
    res.json(await db.get('SELECT id, username, nom_complet, role, created_at FROM users WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

router.delete('/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    const admins = int((await db.get(`SELECT COUNT(*) as c FROM users WHERE role='admin'`)).c);
    const target = await db.get('SELECT role FROM users WHERE id=$1', [id]);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (target.role === 'admin' && admins <= 1) return res.status(400).json({ error: 'Au moins un administrateur doit rester' });
    await db.query('DELETE FROM users WHERE id=$1', [id]);
    res.json({ ok: true });
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
    const dbUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@') : 'non configuré';
    res.json({ counts, db_url: dbUrl, server_time: now(), user: req.user });
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

router.post('/employes', async (req, res, next) => {
  try {
    const e = req.body;
    const idx = int((await db.get('SELECT COUNT(*) as c FROM employes')).c);
    const id  = uid('EMP');
    const row = await db.get(
      `INSERT INTO employes (id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, e.matricule || 'M'+(1000+idx), e.prenom, e.nom, e.service, e.fonction,
       e.badge || 'BDG-'+(2000+idx), e.niveau || 'N1', e.statut || 'actif', now()]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/employes/:id', async (req, res, next) => {
  try {
    const e   = req.body;
    const row = await db.get(
      `UPDATE employes SET service=$1, fonction=$2, niveau=$3, statut=$4 WHERE id=$5 RETURNING *`,
      [e.service, e.fonction, e.niveau, e.statut, req.params.id]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/employes/:id', async (req, res, next) => {
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
      `INSERT INTO visiteurs (id, prenom, nom, societe, hote, motif, arrivee, badge, statut)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uid('VIS'), v.prenom, v.nom, v.societe, v.hote, v.motif, v.arrivee || now(), null, 'attendu']
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

router.delete('/visiteurs/:id', async (req, res, next) => {
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
      `INSERT INTO vehicules (id, plaque, type, conducteur, societe, motif, entree, sortie, statut, place_parking, lapi_photo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [uid('VEH'), (v.plaque||'').toUpperCase(), v.type, v.conducteur, v.societe||'',
       v.motif, v.entree||now(), null, 'dans', v.placeParking||null, v.lapiPhoto||null]
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

router.delete('/vehicules/:id', async (req, res, next) => {
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
    const p   = req.body;
    const row = await db.get(
      `INSERT INTO pietons (id, datetime, nom, badge, type, point, sens, resultat, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uid('PED'), p.datetime||now(), p.nom, p.badge, p.type, p.point, p.sens, p.resultat, p.notes||'']
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/pietons/:id', async (req, res, next) => {
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
    const i   = req.body;
    const c   = int((await db.get('SELECT COUNT(*) as c FROM incidents')).c);
    const row = await db.get(
      `INSERT INTO incidents (id, ref, datetime, type, lieu, gravite, statut, agent, description, actions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uid('INC'), i.ref || 'INC-'+(2026100+c), i.datetime||now(), i.type,
       i.lieu, i.gravite, i.statut||'ouvert', i.agent, i.description||'', i.actions||'']
    );
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

router.delete('/incidents/:id', async (req, res, next) => {
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

router.post('/badges', async (req, res, next) => {
  try {
    const b   = req.body;
    const ref = b.ref || (b.type + '-' + Math.floor(Math.random() * 9000 + 1000));
    const row = await db.get(
      `INSERT INTO badges (ref, nom, type, niveau, emis, validite, etat, societe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ref) DO UPDATE SET
         nom=EXCLUDED.nom, type=EXCLUDED.type, niveau=EXCLUDED.niveau,
         emis=EXCLUDED.emis, validite=EXCLUDED.validite, etat=EXCLUDED.etat, societe=EXCLUDED.societe
       RETURNING *`,
      [ref, b.nom, b.type, b.niveau, b.emis||now(), b.validite, b.etat||'actif', b.societe||'']
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/badges/:ref', async (req, res, next) => {
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

router.delete('/badges/:ref', async (req, res, next) => {
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
        `INSERT INTO parking_mouvements (id, datetime, plaque, place, zone, action, duree) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uid('MVT'), now(), plaque||'?', req.params.num, place.zone, 'entree', 0]
      );
    } else if (place.etat === 'occupe' && etat === 'libre') {
      await db.query(
        `INSERT INTO parking_mouvements (id, datetime, plaque, place, zone, action, duree) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uid('MVT'), now(), place.plaque||'?', req.params.num, place.zone, 'sortie', Math.floor(Math.random()*270)+30]
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
      `INSERT INTO main_courante (id, datetime, poste, agent, type, lieu, description, priorite)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uid('MC'), e.datetime||now(), e.poste, e.agent, e.type, e.lieu||'—', e.description, e.priorite||'normale']
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/maincourante/:id', async (req, res, next) => {
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
      `INSERT INTO lapi_lectures (id, datetime, plaque_detectee, plaque_raw, confiance, image, statut, action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uid('LAPI'), l.datetime||now(), l.plaqueDetectee||'?', l.plaqueRaw||'',
       l.confiance||0, l.image||'', l.statut||'detecte', l.action||null]
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

router.delete('/lapi', async (req, res, next) => {
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

router.put('/parametres', async (req, res, next) => {
  try {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [k, v] of Object.entries(req.body)) {
        await client.query(
          `INSERT INTO parametres (cle, valeur) VALUES ($1,$2) ON CONFLICT(cle) DO UPDATE SET valeur=EXCLUDED.valeur`,
          [k, String(v)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
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

module.exports = router;
