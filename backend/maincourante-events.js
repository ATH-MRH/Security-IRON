'use strict';
/**
 * Référentiel officiel de codification des événements Main courante — fourni
 * par l'opérateur (grille métier), jamais inventé ni corrigé ici. Source
 * unique : sert à la fois la validation serveur de POST /maincourante et,
 * via GET /maincourante/events, le frontend qui rend la grille (aucune copie
 * cliente à maintenir à la main — un seul endroit à modifier si le
 * référentiel évolue).
 *
 * labelFr : libellé officiel. labelAr : volontairement absent pour l'instant
 * — le référentiel arabe n'a pas été fourni avec cette grille ; l'inventer
 * serait une traduction non autorisée d'une terminologie métier officielle.
 * relatedCode : relation textuelle documentée par la grille ("10.06 + 10.05"
 * etc.) — métadonnée informative uniquement, ne déclenche la création
 * d'aucune deuxième entrée automatique (aucun comportement existant ne
 * confirme cette lecture ; voir MAINCOURANTE.md pour l'audit correspondant).
 */

// `tone` : couleur d'accent (icône/badge du bouton — jamais le fond de
// page/carte, conforme au Design System "business color only inside
// components"). Défaut par catégorie ; quelques codes à sémantique
// positive/négative évidente (accès autorisé/refusé, coupure/retour
// électricité, feu/feu maîtrisé, abandon de poste, RAS) portent un
// `tone` explicite qui prime sur celui de leur catégorie.
const CATEGORIES = [
  { id: 'agents', labelFr: 'Agents', tone: 'info' },
  { id: 'rondes', labelFr: 'Rondes', tone: 'success' },
  { id: 'clients', labelFr: 'Clients', tone: 'purple' },
  { id: 'passation', labelFr: 'Passation', tone: 'warning' },
  { id: 'communication', labelFr: 'Communication', tone: 'info' },
  { id: 'acces', labelFr: 'Accès', tone: 'success' },
  { id: 'incidents_securite', labelFr: 'Incidents / Sécurité', tone: 'danger' },
  { id: 'marchandises', labelFr: 'Marchandises', tone: 'info' },
  { id: 'autres', labelFr: 'Autres événements', tone: 'muted' },
  { id: 'urgence', labelFr: 'Urgence', tone: 'danger' },
];

const EVENTS = [
  { code: '10.00', category: 'agents', labelFr: 'Abandon de poste', tone: 'danger' },
  { code: '10.01', category: 'agents', labelFr: 'Arrivée APS' },
  { code: '10.02', category: 'agents', labelFr: 'Départ APS' },
  { code: '10.03', category: 'agents', labelFr: "Absence de l'APS", tone: 'danger' },
  { code: '10.04', category: 'agents', labelFr: 'Rien à signaler (R.A.S.)', tone: 'success' },
  { code: '10.05', category: 'agents', labelFr: 'Point de situation' },

  { code: '10.06', category: 'rondes', labelFr: 'Début de la ronde', relatedCode: '10.05' },
  { code: '10.07', category: 'rondes', labelFr: 'Fin de la ronde', relatedCode: '10.05' },

  { code: '10.08', category: 'clients', labelFr: 'Arrivée du client' },
  { code: '10.09', category: 'clients', labelFr: 'Départ du client' },

  { code: '10.10', category: 'passation', labelFr: 'Passation + relève effectuée', relatedCode: '10.05' },
  { code: '10.11', category: 'communication', labelFr: "Demande d'appel TPH" },

  { code: '10.12', category: 'acces', labelFr: 'Accès autorisé', tone: 'success' },
  { code: '10.13', category: 'acces', labelFr: 'Accès non autorisé', tone: 'danger' },

  { code: '10.14', category: 'incidents_securite', labelFr: 'Matériel détérioré' },
  { code: '10.15', category: 'incidents_securite', labelFr: "Coupure de l'électricité", tone: 'warning' },
  { code: '10.16', category: 'incidents_securite', labelFr: "Retour de l'électricité", tone: 'success' },
  { code: '10.17', category: 'incidents_securite', labelFr: "Tentative d'intrusion" },
  { code: '10.18', category: 'incidents_securite', labelFr: 'Tentative de vol' },
  { code: '10.19', category: 'incidents_securite', labelFr: 'Feu / Incendie' },
  { code: '10.20', category: 'incidents_securite', labelFr: 'Incendie / Feu maîtrisé', tone: 'success' },
  { code: '10.21', category: 'incidents_securite', labelFr: 'Menace verbale et physique' },

  { code: '15.01', category: 'marchandises', labelFr: 'Entrée camion marchandise' },
  { code: '15.02', category: 'marchandises', labelFr: 'Sortie camion marchandise vide' },
  { code: '15.03', category: 'marchandises', labelFr: 'Sortie camion marchandise plein' },

  // Libellés non fournis par la grille métier — NE PAS INVENTER (mission
  // explicite). Conservés comme codes valides, non configurés.
  { code: '15.04', category: 'autres', labelFr: null },
  { code: '15.70', category: 'autres', labelFr: null },
  { code: '15.80', category: 'autres', labelFr: null },

  {
    code: '15.100', category: 'urgence', labelFr: "Appel / Consigne d'urgence",
    instructions: "Observer et signaler tout comportement suspect. Surveiller les accès, entrées et sorties. Garder un suivi visuel de la situation sans se mettre en danger.",
  },
];

const EVENTS_BY_CODE = new Map(EVENTS.map(e => [e.code, e]));

function findEvent(code) {
  return EVENTS_BY_CODE.get(String(code || '').trim()) || null;
}

/**
 * Valide un couple (code, categorie) soumis par le client contre le
 * référentiel serveur — le frontend n'est pas une autorité : un code/
 * catégorie qui ne correspond pas exactement à EVENTS est refusé plutôt que
 * stocké tel quel (protège contre un body forgé avec une catégorie
 * arbitraire). `categorie` est optionnelle dans l'appel : si absente, on la
 * dérive du code (comportement historique — un `type` libre sans code reste
 * accepté, ancien flux non cassé).
 */
function validateEventSelection({ code, categorie } = {}) {
  if (code == null || code === '') return { code: null, categorie: null };
  const found = findEvent(code);
  if (!found) return { error: 'Code événement inconnu du référentiel Main courante' };
  if (categorie != null && categorie !== '' && categorie !== found.category) {
    return { error: 'Catégorie incohérente avec le code événement' };
  }
  return { code: found.code, categorie: found.category };
}

module.exports = { CATEGORIES, EVENTS, findEvent, validateEventSelection };
