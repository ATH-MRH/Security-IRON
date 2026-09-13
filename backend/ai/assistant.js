'use strict';
/**
 * PG-21 — assistant SOC contextualisé : répond à une question en langage
 * naturel à partir de données déjà lues et déjà autorisées (own/scope,
 * PG-8), et propose — sans jamais exécuter — une liste bornée d'actions
 * possibles sur les alertes visibles. Construit sur backend/ai/provider.js
 * (PG-19) : structurellement, aucun accès en écriture n'est possible ici
 * non plus (même garantie que backend/ai/summaries.js, PG-20).
 *
 * « L'IA ne peut pas : close/cancel/change permissions/delete/modify
 * audit » (MASTER ROADMAP §25) — double garantie :
 *   1. structurelle (PG-19) : ce module ne peut écrire nulle part, quel
 *      que soit ce qu'un provider répond — le contrat AIProvider ne
 *      renvoie que du texte ;
 *   2. ceinture supplémentaire ici : ALLOWED_SUGGESTIONS est une liste
 *      blanche d'actions suggérables qui EXCLUT explicitement CLOTUREE,
 *      ANNULEE, FAUSSE_ALERTE (clôture/invalidation/annulation) — même
 *      si un futur fournisseur réel suggérait une de ces actions dans son
 *      texte, elle ne pourrait jamais apparaître dans `suggestions`
 *      (générées par du code métier déterministe, jamais par le
 *      provider). Permissions/suppression/modification d'audit n'existent
 *      même pas comme « action » d'alerte dans ce code base.
 *
 * « Toute action proposée nécessite confirmation utilisateur et exécution
 * API déterministe » : une suggestion n'est jamais qu'une donnée
 * ({alert_id, action, label}), jamais un appel. Le frontend affiche un
 * bouton de confirmation qui déclenche POST /api/alerts/:id/actions — la
 * MÊME route et les MÊMES vérifications qu'une action humaine directe,
 * jamais un court-circuit.
 */
const db = require('../database');
const service = require('../alert-core/service');
const ai = require('./provider');
const { recordAiEvent } = require('./audit');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const NOT_ACTIVE = new Set(['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE', 'RESOLUE']); // même définition que frontend/js/soc-kpis.js (PG-16)

// Liste blanche volontairement restrictive : jamais une action qui
// clôturerait, annulerait ou invaliderait une alerte depuis une
// suggestion IA — voir le contrat au sommet du fichier.
const ALLOWED_SUGGESTIONS = new Set(['ACQUITTEE', 'EN_INTERVENTION', 'SOUS_CONTROLE', 'RESOLUE', 'ESCALADE']);
const ACTION_LABELS = {
  ACQUITTEE: 'Prendre en charge', EN_INTERVENTION: 'Démarrer l’intervention',
  SOUS_CONTROLE: 'Situation sous contrôle', RESOLUE: 'Marquer résolue', ESCALADE: 'Escalader manuellement',
};
// Même échelle de transition que frontend/js/alerts.js (`next`) — pas
// dupliquée en toute rigueur (pas d'export partagé côté backend
// aujourd'hui), mais strictement alignée et sous ALLOWED_SUGGESTIONS de
// toute façon : une divergence future serait sans conséquence de sécurité.
const NEXT_STEP = { NOTIFIEE: 'ACQUITTEE', ACQUITTEE: 'EN_INTERVENTION', EN_INTERVENTION: 'SOUS_CONTROLE', SOUS_CONTROLE: 'RESOLUE' };

function suggestFor(alert) {
  const suggestions = [];
  const step = NEXT_STEP[alert.status];
  if (step && ALLOWED_SUGGESTIONS.has(step)) suggestions.push({ alert_id: alert.id, action: step, label: ACTION_LABELS[step] });
  if (alert.level >= 3 && alert.escalation_step === 0 && alert.status === 'NOTIFIEE' && ALLOWED_SUGGESTIONS.has('ESCALADE')) {
    suggestions.push({ alert_id: alert.id, action: 'ESCALADE', label: ACTION_LABELS.ESCALADE });
  }
  return suggestions;
}

// Sélection de contexte par mot-clé — pas de vrai NLP (LocalAIProvider est
// déterministe, PG-19) : une question sur les alertes critiques ou les
// escalades resserre le contexte transmis au provider ; sans mot-clé
// reconnu, il reste la vue d'ensemble complète — jamais une réponse vide
// faute de correspondance exacte.
function relevantAlerts(rows, question) {
  const q = question.toLowerCase();
  if (/critique|urgent|sos/.test(q)) return rows.filter(a => a.level >= 3);
  if (/escalad/.test(q)) return rows.filter(a => a.escalation_step > 0);
  if (/incident/.test(q)) return rows.filter(a => a.origin === 'INCIDENT');
  if (/site/.test(q)) return rows; // le regroupement par site est déjà dans context.sites
  return rows;
}

async function ask(question, user, client = db) {
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text) fail('Question requise');
  if (text.length > 1000) fail('Question trop longue (1000 caractères maximum)');

  const rows = await service.list(user, client); // own/scope déjà appliqués (PG-8/PG-16)
  const active = rows.filter(a => !NOT_ACTIVE.has(a.status));
  const relevant = relevantAlerts(active, text);
  const bySiteMap = new Map();
  for (const a of active) { const key = (a.site || '').trim() || '(site non renseigné)'; bySiteMap.set(key, (bySiteMap.get(key) || 0) + 1); }

  const context = {
    question: text,
    totalActive: active.length,
    critical: active.filter(a => a.level >= 3).length,
    sos: active.filter(a => a.level === 4).length,
    escalated: active.filter(a => a.escalation_step > 0).length,
    sites: [...bySiteMap.entries()].map(([site, count]) => ({ site, count })),
    // Échantillon borné : un assistant n'a pas besoin de chaque ligne pour
    // un périmètre chargé, seulement d'une base représentative.
    relevant: relevant.slice(0, 20).map(a => ({
      id: a.id, site: a.site, type: a.type, level: a.level, status: a.status,
      escalation_step: a.escalation_step, created_at: a.created_at,
    })),
  };
  const prompt = "Réponds à la question suivante pour un opérateur SOC, en te basant strictement sur les alertes fournies dans le contexte, en 5 phrases maximum : " + text;
  const result = await ai.complete({ prompt, context });

  // Suggestions réservées au SOC : toute action de transition/escalade
  // exige déjà user.isSoc côté service.act() (403 sinon) — ne jamais
  // suggérer à un agent "own" une action qu'il ne peut de toute façon pas
  // effectuer.
  const suggestions = user.isSoc ? active.flatMap(suggestFor).slice(0, 10) : [];

  await recordAiEvent({ user, requestType: 'assistant', resourceType: 'ai', provider: result.provider, model: result.model, resultText: result.text }); // PG-24
  return { ...result, generated_by_ai: true, question: text, suggestions };
}

module.exports = { ask, ALLOWED_SUGGESTIONS };
