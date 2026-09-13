'use strict';
/**
 * PG-23 — recherche scoped (RAG "recherche", pas de génération libre) :
 * construite sur les mêmes garanties que backend/ai/summaries.js (PG-20),
 * assistant.js (PG-21) et correlation.js (PG-22) — lecture uniquement via
 * les points d'autorité déjà testés du reste de l'application, jamais un
 * accès parallèle à la base.
 *
 * Aucune base vectorielle externe (payante ou non) : PostgreSQL natif
 * suffit à ce stade (correspondance de sous-chaînes en mémoire sur des
 * lignes déjà tenant-scoped, volumes réalistes — même justification que
 * l'agrégation client-side de PG-16, "mesurer avant d'optimiser"). Si le
 * volume réel dépassait ce qui est mesuré ici, la recherche devrait migrer
 * vers `to_tsvector`/`plainto_tsquery` (PostgreSQL natif, toujours pas de
 * dépendance externe) — non fait ici faute de nécessité démontrée.
 *
 * Sources couvertes : alertes (service.list, own/scope + tenant, PG-8/
 * PG-16), sites et zones (backend/map.js#listSites/#listZones — RÉUTILISÉES
 * telles quelles, pas réécrites : RLS PG-9 + filtre applicatif PG-8, un
 * seul point de vérité pour "quels sites/zones cet utilisateur voit").
 *
 * Sources volontairement EXCLUES : `incidents`, `main_courante`,
 * `pietons`, `badges` — aucune ne porte de colonne tenant/site/zone
 * (limite PG-8/PG-16 inchangée, voir docs/soc.md). Contrairement à
 * PG-20#summarizeIncident (qui hérite consciemment de cette limite pour un
 * lookup PAR IDENTIFIANT déjà connu de l'appelant), une recherche en texte
 * libre parcourrait ICI l'intégralité de la table, tous tenants confondus
 * — une fuite intertenant réelle et directement démontrable, exactement le
 * genre que PG-23 exige explicitement de ne jamais introduire. Les
 * inclure exigerait d'abord une migration leur ajoutant tenant_id (même
 * modèle que la migration 009 pour security_alerts, PG-16) : un lot
 * distinct, non entrepris ici faute d'être le périmètre de PG-23.
 * « procédures/documentation » n'existe pas comme fonctionnalité réelle
 * dans ce code base — non simulée (même principe que PG-16/17 pour les
 * KPI/positions inventés).
 *
 * « Citations/références vers les données sources » (MASTER ROADMAP §27) :
 * chaque résultat porte `kind`/`id`/`source` — les données exactes qui ont
 * produit le résultat, calculées par correspondance déterministe
 * (searchAlerts/searchSites/searchZones, pures, testées sans base) —
 * jamais devinées depuis le texte généré par le provider. `ai.complete()`
 * (PG-19) ne fait que résumer/citer ces résultats déjà trouvés.
 */
const db = require('../database');
const service = require('../alert-core/service');
const scope = require('../scope');
const map = require('../map');
const ai = require('./provider');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const MAX_RESULTS = 30;

function tokenize(q) {
  return q.toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').split(/\s+/).filter(Boolean).slice(0, 20);
}
function scoreText(haystack, tokens) {
  if (!haystack) return 0;
  const lower = haystack.toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '');
  return tokens.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
}

function searchAlerts(rows, tokens) {
  const out = [];
  for (const a of (rows || [])) {
    const haystack = [a.site, a.zone, a.type, a.comment, a.equipment, a.status, a.origin].filter(Boolean).join(' ');
    const score = scoreText(haystack, tokens);
    if (score > 0) out.push({
      kind: 'alert', id: a.id, score, title: `${a.type} — ${a.site}`, snippet: (a.comment || '').slice(0, 200),
      source: { site: a.site, zone: a.zone, type: a.type, level: a.level, status: a.status, created_at: a.created_at },
    });
  }
  return out;
}
function searchSites(rows, tokens) {
  const out = [];
  for (const s of (rows || [])) {
    const haystack = [s.name, s.code, s.address].filter(Boolean).join(' ');
    const score = scoreText(haystack, tokens);
    if (score > 0) out.push({ kind: 'site', id: s.id, score, title: s.name, snippet: s.address || '', source: { code: s.code } });
  }
  return out;
}
function searchZones(rows, tokens) {
  const out = [];
  for (const z of (rows || [])) {
    const haystack = [z.name, z.code, z.kind].filter(Boolean).join(' ');
    const score = scoreText(haystack, tokens);
    if (score > 0) out.push({ kind: 'zone', id: z.id, score, title: z.name, snippet: z.kind || '', source: { code: z.code, site_id: z.site_id } });
  }
  return out;
}

async function search(query, user, client = db) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) fail('Requête de recherche requise');
  if (text.length > 500) fail('Requête trop longue (500 caractères maximum)');
  const tokens = tokenize(text);
  if (!tokens.length) fail('Requête de recherche requise');
  if (!user.tenantId) fail('Périmètre non résolu', 403);

  const userScope = await scope.resolveScope(user.id, client);
  const [alertRows, siteRows, zoneRows] = await Promise.all([
    service.list(user, client), // own/scope + tenant déjà appliqués (PG-8/PG-16)
    map.listSites(user.id, user.tenantId, userScope, client),
    map.listZones(user.id, user.tenantId, userScope, client),
  ]);

  const results = [...searchAlerts(alertRows, tokens), ...searchSites(siteRows, tokens), ...searchZones(zoneRows, tokens)]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

  const context = { query: text, resultCount: results.length, results: results.map(({ source, ...rest }) => rest) };
  const prompt = "Réponds à cette recherche pour un opérateur SOC en t'appuyant strictement sur les résultats fournis dans le contexte (jamais une information hors de ces résultats), en citant leurs identifiants, en 4 phrases maximum : " + text;
  const result = await ai.complete({ prompt, context });

  return { ...result, generated_by_ai: true, query: text, results };
}

module.exports = { search, searchAlerts, searchSites, searchZones, tokenize };
