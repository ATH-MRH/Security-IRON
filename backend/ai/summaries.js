'use strict';
/**
 * PG-20 — résumés IA : alerte, timeline, rapport de clôture, incident,
 * shift SOC. Construit uniquement sur l'interface AIProvider (PG-19,
 * backend/ai/provider.js) — aucun fournisseur réel câblé ici non plus.
 *
 * Périmètre : chaque fonction lit via les mêmes points d'autorité déjà
 * testés que le reste de l'application (service.detail/list — own/scope,
 * PG-8/PG-16), jamais un accès parallèle à la base. « L'IA est assistante,
 * jamais autorité » (PG-19) : ce module ne fait QUE lire et renvoyer du
 * texte — aucune de ses fonctions n'écrit quoi que ce soit.
 *
 * « Les résultats IA doivent être identifiés comme générés » (MASTER
 * ROADMAP §24) : `label()` pose `generated_by_ai: true` sur CHAQUE retour,
 * inconditionnellement — jamais une confiance dans le fait qu'un futur
 * provider réel s'auto-déclare correctement lui-même.
 *
 * Résumé d'incident : `incidents` ne porte toujours aucune colonne
 * tenant/site/zone (limite PG-8/PG-16 inchangée, voir docs/soc.md) —
 * summarizeIncident() hérite exactement du même périmètre que
 * GET /api/incidents aujourd'hui (toute appartenance active suffit),
 * jamais un filtrage supplémentaire inventé ici.
 */
const db = require('../database');
const service = require('../alert-core/service');
const ai = require('./provider');
const { recordAiEvent } = require('./audit');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const NOT_ACTIVE = new Set(['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE', 'RESOLUE']); // même définition que frontend/js/soc-kpis.js (PG-16)
// PG-24 : resourceType par type de résumé ('alert' pour les trois résumés
// d'alerte, 'incident' pour l'incident, 'ai' générique pour un shift qui
// n'a pas une seule ressource).
const RESOURCE_TYPE = { alert_summary: 'alert', timeline_summary: 'alert', closing_report: 'alert', incident_summary: 'incident', shift_summary: 'ai' };

// PG-24 : un seul point de sortie pour les 5 fonctions -> un seul point
// d'audit (backend/ai/audit.js), jamais dupliqué par fonction.
async function label(result, kind, resourceId, user) {
  await recordAiEvent({ user, requestType: kind, resourceType: RESOURCE_TYPE[kind], resourceId, provider: result.provider, model: result.model, resultText: result.text });
  return { kind, resource_id: resourceId, ...result, generated_by_ai: true };
}

function alertContext(alert) {
  const { id, site, zone, type, level, status, created_at, updated_at, acknowledged_at, resolved_at, comment, equipment, escalation_step, timeline } = alert;
  return {
    id, site, zone, type, level, status, created_at, updated_at, acknowledged_at, resolved_at, comment, equipment, escalation_step,
    timeline: (timeline || []).map(t => ({ at: t.created_at, actor: t.actor, action: t.action, detail: t.detail })),
  };
}

async function summarizeAlert(id, user, client = db) {
  const alert = await service.detail(id, user, client); // own/scope + tenant déjà appliqués
  const context = alertContext(alert);
  const prompt = 'Résume cette alerte de sécurité pour un opérateur SOC : site, type, niveau, statut et chronologie essentielle, en 3 phrases maximum.';
  return label(await ai.complete({ prompt, context }), 'alert_summary', id, user);
}

async function summarizeTimeline(id, user, client = db) {
  const alert = await service.detail(id, user, client);
  const context = { id: alert.id, timeline: alertContext(alert).timeline };
  const prompt = 'Résume uniquement la chronologie de cette alerte (qui a fait quoi, dans quel ordre), sans répéter ce qui est déjà connu (site/type/niveau).';
  return label(await ai.complete({ prompt, context }), 'timeline_summary', id, user);
}

async function closingReport(id, user, client = db) {
  const alert = await service.detail(id, user, client);
  const context = alertContext(alert);
  const prompt = 'Rédige un rapport de clôture structuré pour cette alerte : contexte, actions menées, résolution, durée totale de traitement. '
    + "Si l'alerte n'est pas encore clôturée, indique-le explicitement comme un brouillon, jamais comme un rapport final.";
  return label(await ai.complete({ prompt, context }), 'closing_report', id, user);
}

async function summarizeIncident(id, user, client = db) {
  const incident = await client.get('SELECT * FROM incidents WHERE id=$1', [id]);
  if (!incident) fail('Incident introuvable', 404);
  const { id: incidentId, ref, type, lieu, gravite, statut, description, actions, datetime } = incident;
  const context = { id: incidentId, ref, type, lieu, gravite, statut, description, actions, datetime };
  const prompt = 'Résume cet incident de sécurité pour un rapport SOC : type, lieu, gravité, statut et actions déjà menées, en 3 phrases maximum.';
  return label(await ai.complete({ prompt, context }), 'incident_summary', id, user);
}

async function summarizeShift(user, client = db, { sinceHours = 12 } = {}) {
  if (!user.isSoc) fail('Action réservée au SOC', 403);
  if (!Number.isFinite(sinceHours) || sinceHours <= 0 || sinceHours > 24 * 30) fail('sinceHours invalide');
  const rows = await service.list(user, client); // own/scope déjà appliqués (ici : scope, garanti par isSoc)
  const since = Date.now() - sinceHours * 3600 * 1000;
  const recent = rows.filter(a => Date.parse(a.created_at) >= since);
  const bySiteMap = new Map();
  for (const a of recent) { const key = (a.site || '').trim() || '(site non renseigné)'; bySiteMap.set(key, (bySiteMap.get(key) || 0) + 1); }
  const context = {
    sinceHours,
    total: recent.length,
    critical: recent.filter(a => a.level >= 3).length,
    sos: recent.filter(a => a.level === 4).length,
    stillOpen: recent.filter(a => !NOT_ACTIVE.has(a.status)).length,
    bySite: [...bySiteMap.entries()].map(([site, count]) => ({ site, count })).sort((x, y) => y.count - x.count),
    // Échantillon borné : un résumé n'a pas besoin de chaque ligne pour un
    // shift chargé, seulement d'une base représentative.
    items: recent.slice(0, 30).map(a => ({ site: a.site, type: a.type, level: a.level, status: a.status, created_at: a.created_at })),
  };
  const prompt = "Rédige un résumé de shift SOC pour la relève : volume d'alertes, alertes critiques/SOS, sites concernés, points d'attention, en 5 phrases maximum.";
  return label(await ai.complete({ prompt, context }), 'shift_summary', null, user);
}

module.exports = { summarizeAlert, summarizeTimeline, closingReport, summarizeIncident, summarizeShift };
