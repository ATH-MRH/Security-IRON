'use strict';
/**
 * PG-17 — lecture cartographique (référentiel sites/zones, PG-6/PG-7).
 *
 * Aucun fournisseur cartographique réel n'est câblé ici : choisir un
 * fournisseur (potentiellement payant) reste un HUMAN CHECKPOINT REQUIRED
 * (MASTER ROADMAP §21). Ce module expose uniquement les COORDONNÉES déjà
 * stockées (`sites.latitude/longitude`, migration 003) — le rendu (tuiles,
 * projection, fournisseur) est une préoccupation strictement frontend
 * (`frontend/js/map-provider.js`), volontairement séparée pour qu'un futur
 * fournisseur réel puisse se brancher sans toucher à cette route.
 *
 * Les alertes/SOS géolocalisés ne passent PAS par ce fichier : GET
 * /api/alerts (PG-8) renvoie déjà latitude/longitude par alerte, déjà
 * filtré own/scope — dupliquer une route serait un nouvel endpoint sans
 * nécessité démontrée (même principe que PG-16 pour les KPI).
 *
 * Première route à exploiter réellement PG-9 (RLS, migration 005) plutôt
 * que la seule défense applicative PG-8 : `sites`/`zones` comptent parmi
 * les 5 tables RLS-protégées jamais encore lues par un endpoint (voir
 * docs/postgresql-scope.md, "prêt pour la première qui le fera").
 * `withActorContext` pose l'acteur PostgreSQL (SET LOCAL) pour que
 * `current_actor_tenant_ids()` filtre réellement les lignes en base —
 * défense en profondeur, jamais une confiance dans le seul filtre
 * applicatif ci-dessous. Ce dernier reste nécessaire : RLS est
 * volontairement grossière (tout le tenant, PG-9 §granularité), le filtre
 * `req.scope.allows(...)` referme sur le site/zone réellement couvert par
 * l'appartenance de l'utilisateur — même modèle que `?site_id=`/`?zone_id=`
 * sur GET /api/alerts.
 *
 * Aucune position agent : aucune source de données de localisation continue
 * des agents n'existe dans ce code base aujourd'hui (le SOS PG-15 capture un
 * point GPS ponctuel, pas un suivi). Ne pas simuler — même principe que
 * PG-16 pour les KPI ("ne simule pas des KPI dont les données n'existent pas").
 */
const express = require('express');
const scope = require('./scope');
const router = express.Router();

const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.use(scope.requireScope());

router.get('/sites', wrap(async (req, res) => {
  const { sites, zones } = await scope.withActorContext(req.user.id, async client => ({
    sites: await client.all(
      `SELECT id, code, name, address, latitude, longitude FROM public.sites
       WHERE tenant_id = $1 AND status = 'active' ORDER BY name`, [req.tenantId]),
    // Seulement pour dériver quels sites une appartenance de niveau ZONE
    // couvre indirectement (voir commentaire ci-dessous) — jamais renvoyé tel quel.
    zones: await client.all(
      `SELECT id, site_id FROM public.zones WHERE tenant_id = $1 AND status = 'active'`, [req.tenantId]),
  }));
  // req.scope.allows(tenantId, siteId, null) ne couvre que les appartenances
  // 'tenant' ou 'site' (voir backend/scope.js#coverageOf) : une appartenance
  // 'zone' ne le satisfait jamais (elle exige un zoneId précis). Sans ce
  // second filtre, un utilisateur limité à une seule zone ne verrait AUCUN
  // site sur la carte — pas même le site qui contient sa propre zone. Une
  // zone impliquant toujours un site (CHECK memberships_zone_needs_site_chk,
  // migration 004), le site parent d'une zone couverte est nécessairement
  // visible aussi.
  const sitesCoveredViaZone = new Set(
    zones.filter(z => req.scope.allows(req.tenantId, z.site_id, z.id)).map(z => z.site_id));
  res.json(sites.filter(s => req.scope.allows(req.tenantId, s.id, null) || sitesCoveredViaZone.has(s.id)));
}));

router.get('/zones', wrap(async (req, res) => {
  const rows = await scope.withActorContext(req.user.id, client => client.all(
    `SELECT id, site_id, code, name, kind FROM public.zones
     WHERE tenant_id = $1 AND status = 'active' ORDER BY name`, [req.tenantId]));
  res.json(rows.filter(z => req.scope.allows(req.tenantId, z.site_id, z.id)));
}));

module.exports = router;
