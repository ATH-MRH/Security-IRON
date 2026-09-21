'use strict';
/**
 * MAIN COURANTE — moteur de workflows (portage PostgreSQL propre).
 *
 * Étudié conceptuellement sur feature/securisite-alert-core (exploration
 * SQLite, jamais copiée) puis reconstruit ici sur l'architecture réelle déjà
 * en place : tenants/sites/zones (migrations 003/004), backend/scope.js
 * (périmètre réel par memberships actives, déjà audité), backend/database.js
 * (transactions PostgreSQL). Le référentiel officiel (backend/
 * maincourante-events.js, codes/libellés/catégories) n'est PAS recréé — ce
 * module ne fait qu'y ajouter, par code, la définition des données requises
 * et l'action métier associée : code événement -> définition workflow ->
 * données nécessaires -> validation -> action métier -> enregistrement ->
 * audit (main_courante reste le journal, immuable en pratique : aucune
 * route de ce module ne fait d'UPDATE ni de DELETE dessus).
 *
 * Aucune dépendance à l'ancien moteur embarqué exploré côté SQLite (module,
 * driver synchrone ou fixture) : PostgreSQL uniquement, via backend/database.js.
 */
const express = require('express');
const crypto = require('node:crypto');
const db = require('./database');
const scope = require('./scope');
const securityAudit = require('./security-audit');
const alerts = require('./alerts');
const mcEvents = require('./maincourante-events');

const router = express.Router();
const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const uid = p => p + '-' + crypto.randomUUID();
const now = () => new Date().toISOString();

class WorkflowError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new WorkflowError(status, message); };

/* ============================================================ */
/*  Définition des workflows — données requises par code          */
/* ============================================================ */
// `aps` : champs nécessitant une identité APS vérifiée (mc_aps), jamais un
// nom saisi librement (mission explicite). `fields` : champs simples
// (texte/booléen/choix/référence). `domain` : action métier associée.
// `optionalAps`/`required` pilotent la validation ; tout le reste (icône,
// couleur, catégorie) reste dans backend/maincourante-events.js.
const WORKFLOWS = {
  '10.00': { domain: 'presence-abandon', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'observation', type: 'text', required: true }] },
  '10.01': { domain: 'presence-open', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'poste_id', type: 'resource', resource: 'posts', required: true }] },
  '10.02': { domain: 'presence-close', aps: [{ key: 'agent_id', required: true }], fields: [] },
  '10.03': { domain: 'generic', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'observation', type: 'text', required: true }] },
  '10.04': { domain: 'generic', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'observation', type: 'text', required: false }] },
  '10.05': { domain: 'generic', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'observation', type: 'text', required: true }] },
  '10.06': { domain: 'round-start', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'circuit_id', type: 'resource', resource: 'circuits', required: true }, { key: 'point_depart', type: 'text', required: true }] },
  '10.07': { domain: 'round-end', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'anomaly', type: 'select', options: ['non', 'oui'], required: true }, { key: 'anomaly_description', type: 'text', required: false }] },
  '10.08': { domain: 'visitor-arrival', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'prenom', type: 'text', required: true }, { key: 'nom', type: 'text', required: true }, { key: 'societe', type: 'text', required: false }, { key: 'hote', type: 'text', required: true }, { key: 'motif', type: 'text', required: false }, { key: 'badge', type: 'text', required: false }] },
  '10.09': { domain: 'visitor-departure', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'visiteur_id', type: 'resource', resource: 'visitors_present', required: true }] },
  '10.10': { domain: 'handover', aps: [{ key: 'sortant_id', required: true }, { key: 'entrant_id', required: true }], fields: [{ key: 'confirmation_sortant', type: 'boolean', required: true }, { key: 'confirmation_entrant', type: 'boolean', required: true }, { key: 'observation', type: 'text', required: false }] },
  '10.11': { domain: 'generic', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'destinataire', type: 'text', required: true }, { key: 'priorite', type: 'select', options: ['normale', 'urgente'], required: true }, { key: 'observation', type: 'text', required: true }] },
  '10.12': { domain: 'access', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'identite', type: 'text', required: true }, { key: 'point', type: 'text', required: true }] },
  '10.13': { domain: 'access', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'identite', type: 'text', required: true }, { key: 'point', type: 'text', required: true }, { key: 'motif_refus', type: 'text', required: true }] },
  '10.14': { domain: 'equipment-damage', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'equipment_id', type: 'resource', resource: 'equipment', required: true }, { key: 'description', type: 'text', required: true }, { key: 'impact', type: 'text', required: false }] },
  '10.15': { domain: 'outage-open', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'zone_impactee', type: 'text', required: false }] },
  '10.16': { domain: 'outage-close', aps: [{ key: 'agent_id', required: true }], fields: [] },
  '10.17': { domain: 'incident', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'description', type: 'text', required: true }], gravite: 'critique' },
  '10.18': { domain: 'incident', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'description', type: 'text', required: true }], gravite: 'majeur' },
  '10.19': { domain: 'incident', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'description', type: 'text', required: true }], gravite: 'critique' },
  '10.20': { domain: 'incident-close', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'description', type: 'text', required: false }] },
  '10.21': { domain: 'incident', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'description', type: 'text', required: true }], gravite: 'majeur' },
  '15.01': { domain: 'vehicle-entry', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'plaque', type: 'text', required: true }, { key: 'conducteur', type: 'text', required: true }, { key: 'societe', type: 'text', required: false }, { key: 'reference_bon', type: 'text', required: false }] },
  '15.02': { domain: 'vehicle-exit', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'vehicule_id', type: 'resource', resource: 'vehicles_present', required: true }], loadState: 'vide' },
  '15.03': { domain: 'vehicle-exit', aps: [{ key: 'agent_id', required: true }], fields: [{ key: 'vehicule_id', type: 'resource', resource: 'vehicles_present', required: true }], loadState: 'plein' },
  '15.100': { domain: 'generic', aps: [{ key: 'agent_id', required: false }], fields: [{ key: 'observation', type: 'text', required: false }] },
};
// 15.04/15.70/15.80 : aucune définition -> aucune procédure inventée,
// toujours refusés explicitement par createEvent() (mission explicite).

/* ============================================================ */
/*  Scope & identité — jamais fait confiance à ce que le client    */
/*  affirme, toujours revérifié en base                            */
/* ============================================================ */
// req.scope.allows() (backend/scope.js) est volontairement grossier pour une
// appartenance de niveau tenant : elle couvre tout site sous ce tenant SANS
// revérifier que le site_id fourni existe réellement (limite documentée
// explicitement dans scope.js — "known boundary"). Insuffisant ici : le
// moteur de workflows lit/écrit des données réelles par site (mission
// explicite, "vérifier le scope de chaque référence, pas seulement celui de
// la requête") — on revérifie donc que le site (et la zone, le cas échéant)
// existent réellement sous ce tenant, en plus de la couverture memberships
// déjà vérifiée par req.scope.allows().
async function scopeTriple(req) {
  const siteId = req.query.site_id || req.body?.site_id;
  const zoneId = req.query.zone_id || req.body?.zone_id || null;
  if (!siteId || !req.scope.allows(req.tenantId, siteId, zoneId)) fail(403, 'Site hors périmètre');
  // sites/zones portent une politique RLS (migration 006, sites_actor_tenant/
  // zones_actor_tenant) : sous le rôle applicatif restreint (NOBYPASSRLS),
  // une lecture sans acteur posé ne voit AUCUNE ligne, même existante —
  // même piège déjà rencontré et documenté dans backend/scope.js (PG-28).
  // withActorContext (déjà exporté par scope.js, jamais reconstruit ici)
  // pose l'acteur pour cette lecture, comme resolveScope() le fait pour
  // memberships.
  const { site, zone } = await scope.withActorContext(req.user.id, async client => ({
    site: await client.get(`SELECT id FROM public.sites WHERE id=$1 AND tenant_id=$2 AND status='active'`, [siteId, req.tenantId]),
    zone: zoneId ? await client.get(`SELECT id FROM public.zones WHERE id=$1 AND site_id=$2 AND tenant_id=$3 AND status='active'`, [zoneId, siteId, req.tenantId]) : null,
  }));
  if (!site) fail(403, 'Site hors périmètre');
  if (zoneId && !zone) fail(403, 'Zone hors périmètre');
  return { tenantId: req.tenantId, siteId, zoneId };
}

// APS vérifié : appartient réellement au (tenant, site[, zone]) demandé.
// Jamais un id fourni tel quel sans revérification (mission explicite,
// "vérifier le scope de chaque référence").
async function verifiedAps(client, { tenantId, siteId, zoneId }, employeId) {
  if (!employeId) return null;
  const row = await client.get(
    `SELECT a.employe_id, a.poste_id, e.nom, e.prenom, e.matricule, e.fonction, e.statut, e.groupe, p.name AS poste_name
     FROM public.mc_aps a JOIN public.employes e ON e.id = a.employe_id
     LEFT JOIN public.mc_posts p ON p.id = a.poste_id
     WHERE a.employe_id = $1 AND a.tenant_id = $2 AND a.site_id = $3 AND (a.zone_id IS NOT DISTINCT FROM $4 OR $4 IS NULL)`,
    [employeId, tenantId, siteId, zoneId]);
  if (!row) fail(404, 'APS introuvable dans ce périmètre');
  return row;
}

/* ============================================================ */
/*  GET /workflows/context — catalogue + périmètre + heure serveur */
/* ============================================================ */
// Amorçage du sélecteur de site (frontend/js/maincourante-workflows.js) :
// req.tenantId/req.scope sont déjà résolus par le middleware global
// (backend/scope.js#requireScope, déjà monté sur ce routeur) sans exiger de
// site_id — seul scopeTriple() (utilisé par toutes les autres routes de ce
// fichier) l'exige, pour amorcer un site à sélectionner avant tout le reste.
// sites/zones portent une politique RLS (migration 006) : toute lecture
// doit poser l'acteur (scope.withActorContext, déjà exporté par scope.js —
// même piège déjà rencontré et corrigé pour scopeTriple() plus haut).
router.get('/workflows/sites', wrap(async (req, res) => {
  const sites = await scope.withActorContext(req.user.id, client =>
    client.all(`SELECT id, name FROM public.sites WHERE tenant_id=$1 AND status='active' ORDER BY name`, [req.tenantId]));
  res.json({ sites });
}));

router.get('/workflows/context', wrap(async (req, res) => {
  const { tenantId, siteId, zoneId } = await scopeTriple(req);
  const { sites, zones } = await scope.withActorContext(req.user.id, async client => ({
    sites: await client.all(`SELECT id, name FROM public.sites WHERE tenant_id=$1 AND status='active' ORDER BY name`, [tenantId]),
    zones: await client.all(`SELECT id, name FROM public.zones WHERE tenant_id=$1 AND site_id=$2 AND status='active' ORDER BY name`, [tenantId, siteId]),
  }));
  const posts = await db.all(
    `SELECT id, name FROM public.mc_posts WHERE tenant_id=$1 AND site_id=$2 AND status='active'
       AND (zone_id IS NOT DISTINCT FROM $3 OR zone_id IS NULL) ORDER BY name`, [tenantId, siteId, zoneId]);
  const pcs01 = await db.get(
    `SELECT enabled, codes FROM public.mc_pcs01_config WHERE tenant_id=$1 AND site_id=$2`, [tenantId, siteId]);
  const workflows = mcEvents.EVENTS.map(ev => ({
    code: ev.code, category: ev.category, label: ev.labelFr,
    unresolved: ev.labelFr === null,
    ...(WORKFLOWS[ev.code] ? { fields: WORKFLOWS[ev.code].fields, aps: WORKFLOWS[ev.code].aps, domain: WORKFLOWS[ev.code].domain } : { fields: [], aps: [], disabled: true }),
    ...(ev.instructions ? { instructions: ev.instructions } : {}),
    ...(ev.relatedCode ? { relatedCode: ev.relatedCode } : {}),
  }));
  res.json({
    server_time: now(), sites, zones, posts,
    capabilities: { rounds: true, visitors: true, vehicles: true, equipment: true, pcs01: !!pcs01?.enabled },
    pcs01_codes: pcs01?.codes || [],
    permissions: { write: true, admin: req.scope.hasRole(tenantId, 'soc') || req.scope.hasRole(tenantId, 'site_manager') },
    workflows,
  });
}));

/* ============================================================ */
/*  APS lookup — matricule exact, réponse minimale, anti-énumération */
/* ============================================================ */
const lookupAttempts = new Map(); // userId -> {count, resetAt} — 30/minute/utilisateur
function rateLimited(userId) {
  const now2 = Date.now();
  const entry = lookupAttempts.get(userId);
  if (!entry || now2 > entry.resetAt) { lookupAttempts.set(userId, { count: 1, resetAt: now2 + 60000 }); return false; }
  entry.count++;
  return entry.count > 30;
}
router.post('/aps/lookup', wrap(async (req, res) => {
  if (rateLimited(req.user.id)) fail(429, 'Trop de recherches, réessayez plus tard');
  const triple = await scopeTriple(req);
  const matricule = String(req.body?.matricule || '').trim();
  if (!matricule) fail(404, 'APS introuvable');
  const row = await db.get(
    `SELECT a.employe_id AS id, a.poste_id, e.nom, e.prenom, e.matricule, e.fonction, e.statut, e.groupe,
            p.name AS poste_name, (a.photo IS NOT NULL) AS has_photo
     FROM public.mc_aps a JOIN public.employes e ON e.id = a.employe_id
     LEFT JOIN public.mc_posts p ON p.id = a.poste_id
     WHERE e.matricule = $1 AND a.tenant_id = $2 AND a.site_id = $3 AND (a.zone_id IS NOT DISTINCT FROM $4 OR $4 IS NULL)`,
    [matricule, triple.tenantId, triple.siteId, triple.zoneId]);
  // Réponse identique (404, même forme) que l'APS n'existe pas ou soit hors
  // périmètre — jamais de distinction qui permettrait d'énumérer les
  // matricules valides d'un autre site.
  if (!row) return res.status(404).json({ error: 'APS introuvable' });
  res.json({ id: row.id, matricule: row.matricule, nom: row.nom, prenom: row.prenom, fonction: row.fonction,
    statut: row.statut, groupe: row.groupe, poste: row.poste_name, has_photo: row.has_photo });
}));

router.get('/aps/:id/photo', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  const row = await db.get(
    `SELECT photo, photo_mime FROM public.mc_aps WHERE employe_id=$1 AND tenant_id=$2 AND site_id=$3 AND (zone_id IS NOT DISTINCT FROM $4 OR $4 IS NULL)`,
    [req.params.id, triple.tenantId, triple.siteId, triple.zoneId]);
  if (!row || !row.photo) return res.status(404).end();
  res.set('Content-Type', row.photo_mime).set('Cache-Control', 'private, no-store').send(row.photo);
}));

/* ============================================================ */
/*  Ressources — listes réelles dans le périmètre (jamais globales) */
/* ============================================================ */
router.get('/workflows/resources', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  const kind = req.query.kind;
  const q = req.query.q ? '%' + String(req.query.q).slice(0, 100) + '%' : null;
  const zoneClause = '(zone_id IS NOT DISTINCT FROM $3 OR zone_id IS NULL)';
  switch (kind) {
    case 'posts': return res.json(await db.all(
      `SELECT id, name FROM public.mc_posts WHERE tenant_id=$1 AND site_id=$2 AND status='active' AND ${zoneClause} ORDER BY name`,
      [triple.tenantId, triple.siteId, triple.zoneId]));
    case 'circuits': return res.json(await db.all(
      `SELECT id, name, start_point FROM public.round_circuits WHERE tenant_id=$1 AND site_id=$2 AND status='active' AND ${zoneClause} ORDER BY name`,
      [triple.tenantId, triple.siteId, triple.zoneId]));
    case 'equipment': return res.json(await db.all(
      `SELECT id, name, reference, location, state FROM public.equipment WHERE tenant_id=$1 AND site_id=$2 AND ${zoneClause}
         ${q ? 'AND (name ILIKE $4 OR reference ILIKE $4)' : ''} ORDER BY name`,
      q ? [triple.tenantId, triple.siteId, triple.zoneId, q] : [triple.tenantId, triple.siteId, triple.zoneId]));
    case 'visitors_present': return res.json(await db.all(
      `SELECT id, prenom, nom, societe, hote, arrivee FROM public.visiteurs WHERE statut='present'
         ${q ? 'AND (nom ILIKE $1 OR prenom ILIKE $1)' : ''} ORDER BY arrivee DESC LIMIT 50`,
      q ? [q] : []));
    case 'vehicles_present': return res.json(await db.all(
      `SELECT id, plaque, conducteur, societe, entree FROM public.vehicules WHERE statut='dans'
         ${q ? 'AND plaque ILIKE $1' : ''} ORDER BY entree DESC LIMIT 50`,
      q ? [q] : []));
    case 'rounds_active': return res.json(await db.all(
      `SELECT r.id, r.employe_id, e.nom, e.prenom, c.name AS circuit_name, r.started_at
         FROM public.rounds r JOIN public.employes e ON e.id = r.employe_id JOIN public.round_circuits c ON c.id = r.circuit_id
         WHERE r.tenant_id=$1 AND r.site_id=$2 AND ${zoneClause.replace('zone_id', 'r.zone_id')} AND r.ended_at IS NULL ORDER BY r.started_at DESC`,
      [triple.tenantId, triple.siteId, triple.zoneId]));
    case 'employees': return res.json(await db.all(
      `SELECT id, matricule, prenom, nom, fonction FROM public.employes
         WHERE id NOT IN (SELECT employe_id FROM public.mc_aps) ${q ? 'AND (nom ILIKE $1 OR prenom ILIKE $1 OR matricule ILIKE $1)' : ''}
         ORDER BY nom LIMIT 50`, q ? [q] : []));
    default: fail(400, 'Type de ressource inconnu');
  }
}));

/* ============================================================ */
/*  Action métier par domaine — appelée DANS la transaction        */
/*  portant l'insertion main_courante (atomicité, mission §12)     */
/* ============================================================ */
async function runDomain(client, workflow, code, fields, aps, triple, user, mcRow) {
  const { tenantId, siteId, zoneId } = triple;
  switch (workflow.domain) {
    case 'presence-open': {
      const open = await client.get(`SELECT id FROM public.mc_presence WHERE employe_id=$1 AND closed_at IS NULL`, [aps.agent_id.employe_id]);
      if (open) fail(409, 'Cet APS a déjà une arrivée ouverte sans départ');
      const posteId = fields.poste_id || aps.agent_id.poste_id;
      await client.query(
        `INSERT INTO public.mc_presence (id, tenant_id, site_id, zone_id, employe_id, poste_id, open_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), tenantId, siteId, zoneId, aps.agent_id.employe_id, posteId, mcRow.id]);
      return {};
    }
    case 'presence-close': {
      const open = await client.get(`SELECT id, opened_at FROM public.mc_presence WHERE employe_id=$1 AND closed_at IS NULL`, [aps.agent_id.employe_id]);
      if (!open) fail(409, 'Aucune arrivée ouverte pour cet APS : départ impossible');
      await client.query(`UPDATE public.mc_presence SET closed_at=now(), close_event_id=$1 WHERE id=$2`, [mcRow.id, open.id]);
      return { opened_at: open.opened_at };
    }
    case 'presence-abandon': {
      // Abandon de poste : constat + incident lié (jamais de PCS01 automatique
      // — la case reste manuelle, mission explicite "ne pas déclencher PCS01
      // pour abandon sans règle configurée").
      const ref = await createIncidentRow(client, { type: 'Abandon de poste', lieu: aps.agent_id.poste_name || '—', gravite: 'majeur', agent: apsLabel(aps.agent_id), description: fields.observation, user, mcId: mcRow.id });
      return { incident_ref: ref };
    }
    case 'round-start': {
      const open = await client.get(`SELECT id FROM public.rounds WHERE employe_id=$1 AND ended_at IS NULL`, [aps.agent_id.employe_id]);
      if (open) fail(409, 'Cet APS a déjà une ronde en cours');
      const circuit = await client.get(`SELECT id FROM public.round_circuits WHERE id=$1 AND tenant_id=$2 AND site_id=$3`, [fields.circuit_id, tenantId, siteId]);
      if (!circuit) fail(404, 'Circuit introuvable dans ce périmètre');
      await client.query(
        `INSERT INTO public.rounds (id, tenant_id, site_id, zone_id, circuit_id, employe_id, open_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), tenantId, siteId, zoneId, fields.circuit_id, aps.agent_id.employe_id, mcRow.id]);
      return {};
    }
    case 'round-end': {
      const open = await client.get(`SELECT id, started_at, circuit_id FROM public.rounds WHERE employe_id=$1 AND ended_at IS NULL`, [aps.agent_id.employe_id]);
      if (!open) fail(409, 'Aucune ronde ouverte pour cet APS : clôture impossible');
      const anomaly = fields.anomaly === 'oui';
      if (anomaly && !String(fields.anomaly_description || '').trim()) fail(400, 'Description de l’anomalie requise');
      const checkpointsTotal = (await client.get(`SELECT count(*)::int AS c FROM public.round_checkpoints WHERE circuit_id=$1`, [open.circuit_id])).c;
      const scansDone = (await client.get(`SELECT count(*)::int AS c FROM public.round_scans WHERE round_id=$1`, [open.id])).c;
      await client.query(
        `UPDATE public.rounds SET ended_at=now(), close_event_id=$1, anomaly=$2, anomaly_description=$3 WHERE id=$4`,
        [mcRow.id, anomaly, fields.anomaly_description || null, open.id]);
      return { started_at: open.started_at, checkpoints_completed: scansDone + '/' + checkpointsTotal };
    }
    case 'visitor-arrival': {
      const id = uid('VIS');
      await client.query(
        `INSERT INTO public.visiteurs (id, prenom, nom, societe, hote, motif, arrivee, badge, statut, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'present',$9)`,
        [id, fields.prenom, fields.nom, fields.societe || null, fields.hote, fields.motif || null, now(), fields.badge || null, user.username]);
      return { visiteur_id: id };
    }
    case 'visitor-departure': {
      const v = await client.get(`SELECT id FROM public.visiteurs WHERE id=$1 AND statut='present'`, [fields.visiteur_id]);
      if (!v) fail(409, 'Ce visiteur n’est pas présent (déjà sorti ou inconnu)');
      await client.query(`UPDATE public.visiteurs SET statut='parti' WHERE id=$1`, [fields.visiteur_id]);
      return {};
    }
    case 'handover': {
      if (aps.sortant_id.employe_id === aps.entrant_id.employe_id) fail(400, 'Les APS entrant et sortant doivent être différents');
      if (!fields.confirmation_sortant || !fields.confirmation_entrant) fail(400, 'Les deux confirmations sont requises');
      return {};
    }
    case 'access': {
      await client.query(
        `INSERT INTO public.pietons (id, datetime, nom, badge, type, point, sens, resultat, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uid('PIE'), now(), fields.identite, null, 'visiteur', fields.point, 'entree',
         code === '10.12' ? 'autorise' : 'refuse', fields.motif_refus || null, user.username]);
      return {};
    }
    case 'equipment-damage': {
      const eq = await client.get(`SELECT id FROM public.equipment WHERE id=$1 AND tenant_id=$2 AND site_id=$3`, [fields.equipment_id, tenantId, siteId]);
      if (!eq) fail(404, 'Équipement introuvable dans ce périmètre');
      await client.query(`UPDATE public.equipment SET state='deteriore' WHERE id=$1`, [fields.equipment_id]);
      return {};
    }
    case 'outage-open': {
      const open = await findOpenOutage(client, siteId, zoneId, { excludeOpenId: mcRow.id });
      if (open) fail(409, 'Une coupure est déjà ouverte pour ce site/cette zone');
      return {};
    }
    case 'outage-close': {
      const open = await findOpenOutage(client, siteId, zoneId, { excludeCloseId: mcRow.id });
      if (!open) fail(409, 'Aucune coupure ouverte pour ce site/cette zone');
      return { outage_opened_at: open.created_at };
    }
    case 'incident': {
      const ref = await createIncidentRow(client, {
        type: mcEvents.findEvent(code).labelFr, lieu: fields.lieu || aps.agent_id.poste_name || '—',
        gravite: workflow.gravite || 'majeur', agent: apsLabel(aps.agent_id), description: fields.description, user, mcId: mcRow.id,
      });
      return { incident_ref: ref };
    }
    case 'incident-close': {
      const open = await client.get(
        `SELECT id, ref FROM public.incidents WHERE type=$1 AND statut != 'resolu' ORDER BY datetime DESC LIMIT 1`,
        [mcEvents.findEvent('10.19').labelFr]);
      if (open) await client.query(`UPDATE public.incidents SET statut='resolu', actions=coalesce(actions,'')||$1 WHERE id=$2`,
        ['\nMaîtrisé : ' + (fields.description || ''), open.id]);
      return open ? { incident_ref: open.ref } : {};
    }
    case 'vehicle-entry': {
      const open = await client.get(`SELECT id FROM public.vehicules WHERE plaque=$1 AND statut='dans'`, [fields.plaque]);
      if (open) fail(409, 'Ce véhicule est déjà enregistré comme présent');
      const id = uid('VEH');
      await client.query(
        `INSERT INTO public.vehicules (id, plaque, type, conducteur, societe, motif, entree, statut, created_by)
         VALUES ($1,$2,'camion',$3,$4,$5,$6,'dans',$7)`,
        [id, fields.plaque, fields.conducteur, fields.societe || null, fields.reference_bon || null, now(), user.username]);
      return { vehicule_id: id };
    }
    case 'vehicle-exit': {
      const v = await client.get(`SELECT id, plaque FROM public.vehicules WHERE id=$1 AND statut='dans'`, [fields.vehicule_id]);
      if (!v) fail(409, 'Ce véhicule n’est pas présent (déjà sorti ou inconnu)');
      await client.query(`UPDATE public.vehicules SET statut='dehors', sortie=$1 WHERE id=$2`, [now(), fields.vehicule_id]);
      return { plaque: v.plaque };
    }
    case 'generic': return {};
    default: fail(500, 'Domaine de workflow inconnu : ' + workflow.domain);
  }
}
function apsLabel(a) { return a ? `${a.prenom || ''} ${a.nom || ''} (${a.matricule})`.trim() : null; }
// Dernière coupure (10.15) de ce site/cette zone dont aucun retour (10.16)
// plus récent n'existe déjà — pas de table dédiée (un seul champ à
// vérifier), la Main courante fait déjà foi.
// Dernière coupure (10.15) de ce site/cette zone, comparée en clair (deux
// requêtes simples + une comparaison en JS) plutôt qu'un NOT EXISTS corrélé
// paramétré : plus facile à raisonner, et évite toute ambiguïté de type sur
// un paramètre NULL réutilisé plusieurs fois dans la même requête.
// `excludeOpenId`/`excludeCloseId` : l'événement (10.15 ou 10.16) qu'on est
// en train de créer est déjà inséré dans main_courante à ce stade (même
// transaction, donc déjà visible ici) — sans l'exclure du côté qui
// correspond à son propre code, il se prendrait lui-même pour la preuve
// d'une coupure déjà ouverte (10.15 s'auto-bloque) ou déjà refermée (10.16
// se voit comme sa propre clôture, "aucune coupure ouverte" dès la
// première fermeture réelle).
async function findOpenOutage(client, siteId, zoneId, { excludeOpenId = null, excludeCloseId = null } = {}) {
  const opens = await client.all(
    `SELECT id, created_at FROM public.main_courante WHERE code = '10.15' AND site_id = $1 AND zone_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC`,
    [siteId, zoneId]);
  const lastOpen = opens.find(o => o.id !== excludeOpenId);
  if (!lastOpen) return null;
  const closes = await client.all(
    `SELECT id, created_at FROM public.main_courante WHERE code = '10.16' AND site_id = $1 AND zone_id IS NOT DISTINCT FROM $2 AND created_at > $3`,
    [siteId, zoneId, lastOpen.created_at]);
  const realClose = closes.find(c => c.id !== excludeCloseId);
  return realClose ? null : lastOpen;
}
async function createIncidentRow(client, { type, lieu, gravite, agent, description, user, mcId }) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('securisite:incidents:ref')::bigint)");
  const c = parseInt((await client.get('SELECT COUNT(*) AS c FROM incidents')).c, 10);
  const ref = 'INC-' + (2026100 + c);
  const record = await client.query(
    `INSERT INTO incidents (id, ref, datetime, type, lieu, gravite, statut, agent, description, actions, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'ouvert',$7,$8,$9,$10) RETURNING *`,
    [uid('INC'), ref, now(), type, lieu, gravite, agent, description || '', 'Créé depuis Main courante (' + mcId + ')', user.username]);
  await alerts.fromIncident(record.rows[0], user, client);
  return ref;
}

/* ============================================================ */
/*  POST /events — validation + transaction atomique               */
/* ============================================================ */
router.post('/events', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  const { code, data, trigger_pcs01, idempotency_key } = req.body || {};
  const selection = mcEvents.validateEventSelection({ code });
  if (selection.error) fail(400, selection.error);
  const workflow = WORKFLOWS[code];
  if (!workflow) fail(422, 'Code non configuré : « LIBELLÉ À COMPLÉTER », aucune procédure disponible');

  if (idempotency_key) {
    const existing = await db.get(`SELECT * FROM public.main_courante WHERE idempotency_key=$1`, [idempotency_key]);
    if (existing) return res.status(200).json({ ...existing, replayed: true });
  }

  const fields = (data && typeof data === 'object') ? data : {};
  for (const f of workflow.fields) {
    if (f.required && (fields[f.key] === undefined || fields[f.key] === null || fields[f.key] === '')) fail(400, 'Champ requis : ' + f.key);
  }

  const result = await db.transaction(async client => {
    const aps = {};
    for (const a of workflow.aps) {
      const employeId = fields[a.key];
      if (a.required && !employeId) fail(400, 'APS requis : ' + a.key);
      if (employeId) aps[a.key] = await verifiedAps(client, triple, employeId);
    }
    const label = mcEvents.findEvent(code).labelFr;
    // Le poste affiché est celui réellement sélectionné dans le formulaire
    // (fields.poste_id, ex. 10.01) quand ce workflow en porte un, jamais
    // seulement le poste par défaut de l'APS (qui peut être affecté ailleurs
    // ce jour-là — un select de poste existe précisément pour ce cas).
    const posteId = fields.poste_id || aps.agent_id?.poste_id || null;
    const poste = posteId
      ? (await client.get(`SELECT name FROM public.mc_posts WHERE id=$1 AND tenant_id=$2 AND site_id=$3`, [posteId, triple.tenantId, triple.siteId]))?.name || null
      : null;
    const event = await client.get(
      `INSERT INTO public.main_courante (id, datetime, poste, agent, type, lieu, description, priorite, created_by, code, categorie, data, idempotency_key, tenant_id, site_id, zone_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'normale',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [uid('MC'), now(), poste, apsLabel(aps.agent_id) || req.user.username,
       label, fields.lieu || null, fields.observation || fields.description || label,
       req.user.username, selection.code, selection.categorie, JSON.stringify(fields), idempotency_key || null, triple.tenantId, triple.siteId, triple.zoneId]);

    const domainResult = await runDomain(client, workflow, code, fields, aps, triple, req.user, event);

    let pcs01Triggered = false;
    if (trigger_pcs01) {
      const config = await client.get(`SELECT enabled, codes FROM public.mc_pcs01_config WHERE tenant_id=$1 AND site_id=$2`, [triple.tenantId, triple.siteId]);
      if (config?.enabled && (config.codes || []).includes(code)) {
        await createIncidentRow(client, {
          type: 'PCS01 — ' + mcEvents.findEvent(code).labelFr, lieu: fields.lieu || aps.agent_id?.poste_name || '—',
          gravite: 'critique', agent: apsLabel(aps.agent_id) || req.user.username,
          description: '[PCS01 déclenché manuellement depuis Main courante ' + code + '] ' + (fields.observation || fields.description || ''),
          user: req.user, mcId: event.id,
        });
        pcs01Triggered = true;
      }
      // Si non autorisé pour ce code/site : jamais d'alerte, jamais d'erreur
      // bloquante — l'entrée Main courante reste enregistrée (fail-safe).
    }
    await securityAudit.recordBestEffort({
      requestId: req.requestId || null, origin: 'http', actorUserId: req.user.id, actorUsername: req.user.username,
      eventType: 'maincourante.event.create', resourceType: 'main_courante', resourceId: event.id, action: 'create', outcome: 'success',
      detail: { code, domain: workflow.domain, pcs01Triggered },
    });
    return { event, domainResult, pcs01Triggered };
  });

  res.status(201).json({ ...result.event, domain_result: result.domainResult, pcs01_triggered: result.pcs01Triggered, replayed: false });
}));

/* ============================================================ */
/*  Rondes — détail + scan                                        */
/* ============================================================ */
router.get('/rounds/:id', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  const round = await db.get(
    `SELECT r.*, c.name AS circuit_name, c.start_point, e.nom, e.prenom, e.matricule
       FROM public.rounds r JOIN public.round_circuits c ON c.id=r.circuit_id JOIN public.employes e ON e.id=r.employe_id
       WHERE r.id=$1 AND r.tenant_id=$2 AND r.site_id=$3`, [req.params.id, triple.tenantId, triple.siteId]);
  if (!round) return res.status(404).json({ error: 'Ronde introuvable' });
  const checkpoints = await db.all(`SELECT id, name, position FROM public.round_checkpoints WHERE circuit_id=$1 ORDER BY position`, [round.circuit_id]);
  const scans = await db.all(`SELECT checkpoint_id, scanned_at, anomaly FROM public.round_scans WHERE round_id=$1 ORDER BY scanned_at`, [round.id]);
  res.json({ ...round, checkpoints, scans, duration_seconds: round.ended_at ? Math.round((new Date(round.ended_at) - new Date(round.started_at)) / 1000) : null });
}));

router.post('/rounds/:id/scans', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  const { checkpoint_id, anomaly } = req.body || {};
  await db.transaction(async client => {
    const round = await client.get(`SELECT id, circuit_id FROM public.rounds WHERE id=$1 AND tenant_id=$2 AND site_id=$3 AND ended_at IS NULL`,
      [req.params.id, triple.tenantId, triple.siteId]);
    if (!round) fail(404, 'Ronde introuvable ou déjà clôturée');
    const checkpoint = await client.get(`SELECT id FROM public.round_checkpoints WHERE id=$1 AND circuit_id=$2`, [checkpoint_id, round.circuit_id]);
    if (!checkpoint) fail(400, 'Checkpoint ne correspondant pas à cette ronde');
    const already = await client.get(`SELECT id FROM public.round_scans WHERE round_id=$1 AND checkpoint_id=$2`, [round.id, checkpoint_id]);
    if (already) fail(409, 'Ce checkpoint a déjà été scanné pour cette ronde');
    const scan = await client.get(
      `INSERT INTO public.round_scans (id, round_id, checkpoint_id, anomaly) VALUES ($1,$2,$3,$4) RETURNING *`,
      [crypto.randomUUID(), round.id, checkpoint_id, !!anomaly]);
    await securityAudit.recordBestEffort({
      requestId: req.requestId || null, origin: 'http', actorUserId: req.user.id, actorUsername: req.user.username,
      eventType: 'maincourante.round.scan', resourceType: 'round_scans', resourceId: scan.id, action: 'create', outcome: 'success',
    });
    res.status(201).json(scan);
  });
}));

/* ============================================================ */
/*  Administration — postes / matériel / circuits / PCS01          */
/* ============================================================ */
function requireAdminScope(req, triple) {
  if (!(req.scope.hasRole(triple.tenantId, 'soc') || req.scope.hasRole(triple.tenantId, 'site_manager'))) fail(403, 'Droits de gestion requis');
}

router.get('/admin/catalog', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  requireAdminScope(req, triple);
  const [posts, equipment, circuits, pcs01, unattached] = await Promise.all([
    db.all(`SELECT id, name, status FROM public.mc_posts WHERE tenant_id=$1 AND site_id=$2 ORDER BY name`, [triple.tenantId, triple.siteId]),
    db.all(`SELECT id, name, reference, location, state FROM public.equipment WHERE tenant_id=$1 AND site_id=$2 ORDER BY name`, [triple.tenantId, triple.siteId]),
    db.all(`SELECT c.id, c.name, c.start_point, count(ch.id)::int AS checkpoint_count
              FROM public.round_circuits c LEFT JOIN public.round_checkpoints ch ON ch.circuit_id=c.id
              WHERE c.tenant_id=$1 AND c.site_id=$2 GROUP BY c.id ORDER BY c.name`, [triple.tenantId, triple.siteId]),
    db.get(`SELECT enabled, codes FROM public.mc_pcs01_config WHERE tenant_id=$1 AND site_id=$2`, [triple.tenantId, triple.siteId]),
    db.all(`SELECT id, matricule, prenom, nom FROM public.employes WHERE id NOT IN (SELECT employe_id FROM public.mc_aps) ORDER BY nom LIMIT 100`),
  ]);
  res.json({ posts, equipment, circuits, pcs01: pcs01 || { enabled: false, codes: [] }, unattached_employees: unattached });
}));

router.post('/admin/resources', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  requireAdminScope(req, triple);
  const { kind, data } = req.body || {};
  if (kind === 'post') {
    if (!data?.name) fail(400, 'Nom requis');
    const row = await db.get(`INSERT INTO public.mc_posts (id, tenant_id, site_id, zone_id, name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [crypto.randomUUID(), triple.tenantId, triple.siteId, triple.zoneId, data.name]);
    return res.status(201).json(row);
  }
  if (kind === 'equipment') {
    if (!data?.name || !data?.reference || !data?.location) fail(400, 'Nom, référence et emplacement requis');
    const row = await db.get(`INSERT INTO public.equipment (id, tenant_id, site_id, zone_id, reference, name, location, state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [crypto.randomUUID(), triple.tenantId, triple.siteId, triple.zoneId, data.reference, data.name, data.location, data.state || 'bon']);
    return res.status(201).json(row);
  }
  if (kind === 'circuit') {
    if (!data?.name || !data?.start_point) fail(400, 'Nom et point de départ requis');
    if (data.latitude != null && (data.latitude < -90 || data.latitude > 90)) fail(400, 'Latitude invalide');
    const checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
    const positions = checkpoints.map((c, i) => c.position ?? i);
    if (new Set(positions).size !== positions.length) fail(400, 'Positions de checkpoints dupliquées');
    return res.status(201).json(await db.transaction(async client => {
      const circuit = await client.get(`INSERT INTO public.round_circuits (id, tenant_id, site_id, zone_id, name, start_point) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [crypto.randomUUID(), triple.tenantId, triple.siteId, triple.zoneId, data.name, data.start_point]);
      const rows = [];
      for (let i = 0; i < checkpoints.length; i++) {
        rows.push(await client.get(`INSERT INTO public.round_checkpoints (id, circuit_id, name, position) VALUES ($1,$2,$3,$4) RETURNING *`,
          [crypto.randomUUID(), circuit.id, checkpoints[i].name, checkpoints[i].position ?? i]));
      }
      return { ...circuit, latitude: null, longitude: null, checkpoints: rows };
    }));
  }
  if (kind === 'aps') {
    const { employe_id, poste_id } = data || {};
    if (!employe_id) fail(400, 'Employé requis');
    const employe = await db.get(`SELECT id FROM public.employes WHERE id=$1`, [employe_id]);
    if (!employe) fail(404, 'Employé introuvable');
    const row = await db.get(
      `INSERT INTO public.mc_aps (employe_id, tenant_id, site_id, zone_id, poste_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employe_id) DO UPDATE SET tenant_id=excluded.tenant_id, site_id=excluded.site_id, zone_id=excluded.zone_id, poste_id=excluded.poste_id, updated_at=now()
         RETURNING *`,
      [employe_id, triple.tenantId, triple.siteId, triple.zoneId, poste_id || null]);
    return res.status(201).json(row);
  }
  fail(400, 'Type de ressource inconnu');
}));

router.put('/admin/pcs01', wrap(async (req, res) => {
  const triple = await scopeTriple(req);
  requireAdminScope(req, triple);
  const { enabled, codes } = req.body || {};
  const validCodes = (Array.isArray(codes) ? codes : []).filter(c => mcEvents.findEvent(c));
  const row = await db.get(
    `INSERT INTO public.mc_pcs01_config (tenant_id, site_id, enabled, codes, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, site_id) DO UPDATE SET enabled=excluded.enabled, codes=excluded.codes, updated_at=now(), updated_by=excluded.updated_by
       RETURNING *`,
    [triple.tenantId, triple.siteId, !!enabled, validCodes, req.user.username]);
  await securityAudit.recordBestEffort({
    requestId: req.requestId || null, origin: 'http', actorUserId: req.user.id, actorUsername: req.user.username,
    eventType: 'maincourante.pcs01.configure', resourceType: 'mc_pcs01_config', action: 'update', outcome: 'success',
    detail: { enabled: !!enabled, codes: validCodes },
  });
  res.json(row);
}));

router.use((err, req, res, next) => {
  if (err instanceof WorkflowError) return res.status(err.status).json({ error: err.message });
  next(err);
});

module.exports = { router, WORKFLOWS };
