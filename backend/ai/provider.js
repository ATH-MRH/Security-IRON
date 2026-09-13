'use strict';
/**
 * PG-19 — interface AIProvider : abstraction entre les futures
 * fonctionnalités IA (PG-20 résumés, PG-21 assistant SOC) et le
 * fournisseur qui les exécute réellement. Aucun fournisseur externe
 * nécessitant une clé n'est câblé ici : choisir un fournisseur payant
 * reste un HUMAN CHECKPOINT REQUIRED (MASTER ROADMAP §23).
 *
 * L'IA est ASSISTANTE, jamais autorité des transitions (MASTER ROADMAP
 * §23) — structurel, pas seulement une convention :
 *   - un provider ne reçoit jamais de référence vers la base de données,
 *     backend/alert-core/repository.js ou backend/alert-core/service.js —
 *     seulement des données déjà lues et déjà autorisées par l'appelant
 *     (own/scope, PG-8) ;
 *   - le contrat n'expose qu'une seule méthode, complete(), qui RENVOIE du
 *     texte — rien qui écrive, transitionne ou exécute quoi que ce soit ;
 *   - un futur appelant (PG-20/21) reste seul responsable d'agir — ou non —
 *     sur ce qu'une IA suggère, via les mêmes routes/vérifications qu'une
 *     action humaine (jamais un court-circuit).
 *
 * Contrat qu'un provider doit implémenter (duck typing volontaire, comme le
 * reste de ce code base — pas de framework, pas de classe de base
 * imposée) : un provider est n'importe quel objet exposant
 *   async complete({ prompt, context }) -> { text, provider, generatedAt }
 *
 * Rédaction défensive : `context` transitera un jour vers un fournisseur
 * externe réel (après checkpoint). buildSafeContext() retire récursivement
 * toute clé/valeur ressemblant à un secret — même motif que
 * backend/security-audit.js#sanitizeDetail (PG-10), réutilisé ici, pas
 * dupliqué — avant qu'AUCUN provider, y compris le provider local, ne la
 * voie. Défense en profondeur : l'appelant (PG-20/21) reste responsable de
 * ne jamais construire ce contexte à partir de champs sensibles au départ.
 */
const { FORBIDDEN_DETAIL_PATTERN } = require('../security-audit');

// Récursif (contrairement à sanitizeDetail, qui exige un objet plat pour un
// journal d'audit) : un contexte IA est légitimement imbriqué — une alerte
// avec sa timeline, un incident, un lot d'alertes pour un résumé de shift.
// Limite connue : un objet non littéral (ex. `Date`) n'a pas de propriété
// propre énumérable — il ressortirait en `{}`. Sans conséquence ici : tous
// les horodatages de ce code base sont déjà des chaînes ISO (`now()` dans
// backend/alert-core/service.js), jamais des instances Date.
function redact(value, depth = 0) {
  if (depth > 8) return '[profondeur max atteinte]'; // borne défensive, jamais une boucle infinie
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_DETAIL_PATTERN.test(key)) continue; // clé suspecte : retirée entièrement, jamais devinée
      out[key] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && FORBIDDEN_DETAIL_PATTERN.test(value) && value.length > 40) return '[retiré]';
  return value;
}

function buildSafeContext(context) {
  return context == null ? null : redact(context);
}

// Provider par défaut, seul disponible aujourd'hui : aucun réseau, aucune
// clé, résultat déterministe et explicitement étiqueté `simulated: true` —
// jamais présenté comme un vrai modèle de langage. Donne à PG-20/21 un
// contrat stable à développer et tester avant qu'un fournisseur réel ne
// soit choisi (HUMAN CHECKPOINT REQUIRED).
const LocalAIProvider = {
  name: 'local',
  async complete({ prompt } = {}) {
    return {
      text: '[IA non configurée — aucun fournisseur réel actif] ' + String(prompt || '').slice(0, 200),
      provider: 'local',
      generatedAt: new Date().toISOString(),
      simulated: true,
    };
  },
};

let active = LocalAIProvider;

// Point d'extension unique pour un futur fournisseur réel (après
// checkpoint humain) : rien d'autre dans ce code base n'a besoin de changer.
function configureProvider(provider) {
  if (!provider || typeof provider.complete !== 'function') {
    throw new TypeError('AIProvider invalide : complete() requis');
  }
  active = provider;
}
function resetProvider() { active = LocalAIProvider; } // tests uniquement
function getProvider() { return active; }

async function complete({ prompt, context } = {}) {
  return getProvider().complete({ prompt, context: buildSafeContext(context) });
}

module.exports = { complete, getProvider, configureProvider, resetProvider, buildSafeContext, LocalAIProvider };
