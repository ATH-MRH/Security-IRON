const express = require('express');
const db = require('./database');

const router = express.Router();

function requireSyncKey(req, res, next) {
  const secret = process.env.IRON_SYNC_SECRET;
  if (!secret) return res.status(503).json({ error: 'Sync non configuré (IRON_SYNC_SECRET manquant)' });
  if (req.headers['x-atlas-sync-key'] !== secret) return res.status(401).json({ error: 'Clé de synchronisation invalide' });
  next();
}

// POST /api/sync/affectation — reçoit une affectation depuis ATLAS et upsert l'employé
router.post('/affectation', requireSyncKey, async (req, res, next) => {
  try {
    const d = req.body || {};
    if (!d.atlas_id) return res.status(400).json({ error: 'atlas_id requis' });

    const id = 'ATLAS-' + d.atlas_id;
    const existing = await db.get('SELECT id FROM employes WHERE id=$1', [id]);

    if (existing) {
      await db.query(
        `UPDATE employes
         SET matricule=$1, prenom=$2, nom=$3, service=$4, fonction=$5,
             niveau=$6, statut=$7, site_id=$8, site_nom=$9, groupe=$10, date_affectation=$11
         WHERE id=$12`,
        [d.matricule, d.prenom, d.nom, d.service, d.fonction,
         d.niveau, d.statut, d.site_id, d.site_nom, d.groupe, d.date_affectation, id]
      );
    } else {
      await db.query(
        `INSERT INTO employes
           (id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation,
            atlas_id, site_id, site_nom, groupe, date_affectation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, d.matricule, d.prenom, d.nom, d.service, d.fonction,
         d.badge || null, d.niveau, d.statut, d.creation,
         d.atlas_id, d.site_id, d.site_nom, d.groupe, d.date_affectation]
      );
    }
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});

module.exports = router;
