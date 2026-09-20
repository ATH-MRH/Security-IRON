'use strict';
// MAIN COURANTE — grille de codification événements (remplace l'ancien
// sélecteur "Type d'événement" libre par la grille visuelle codifiée du
// référentiel métier, backend/maincourante-events.js).
//
// Couverture de ce fichier (statique + fonctions pures, sans navigateur —
// le comportement interactif complet [sélection, recherche, panneau,
// PCS01, FR/AR/RTL, mobile] a été vérifié en navigateur réel Playwright,
// documenté dans le rapport de mission ; aucune dépendance Playwright dans
// package.json, donc pas de test navigateur committé ici, comme pour le
// reste de la suite) :
//  1. Câblage statique index.html <-> app.js (ids, oninput/onclick, la
//     grille et le panneau existent et pointent vers de vraies fonctions).
//  2. Fonctions pures (mcEventLabel/mcCategoryLabel) — le cas 15.04/15.70/
//     15.80 sans libellé fourni ("NE PAS INVENTER") est directement
//     vérifiable sans DOM.
//  3. Garde-fou CSS : régression exacte trouvée pendant cette mission — un
//     "*/" littéral dans le commentaire précédant .mc-entry-body fermait le
//     commentaire prématurément et faisait disparaître toute la règle
//     display:grid du CSSOM du navigateur (repéré via getComputedStyle,
//     jamais via une simple lecture du fichier). Verrouillé ici au niveau
//     source pour ne jamais revenir silencieusement.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');
const mcEvents = require('../backend/maincourante-events');

const mcHtml = htmlSource.slice(htmlSource.indexOf('mc-entry-card'), htmlSource.indexOf('page-incidents'));

/* ============================================================ */
/*  1. Câblage statique                                           */
/* ============================================================ */

test('grille de saisie : recherche câblée sur filterMcEvents(), grille et barre urgence présentes', () => {
  assert.match(mcHtml, /id="mcEventSearch"[^>]*oninput="filterMcEvents\(this\.value\)"/);
  assert.match(mcHtml, /id="mcEventGrid"/);
  assert.match(mcHtml, /id="mcUrgencyBar"/);
  assert.match(appSource, /function filterMcEvents\(v\)\{/);
  assert.match(appSource, /function renderMcEventGrid\(filter\)\{/);
});

test('grille de saisie : chaque bouton événement appelle selectMcEvent(code) (fonction réelle, pas décorative)', () => {
  assert.match(appSource, /function selectMcEvent\(code\)\{/);
  assert.match(appSource, /onclick="selectMcEvent\('\$\{ev\.code\}'\)"/);
});

test('panneau droit : Code/Libellé/Catégorie, Poste*/Agent*/Lieu/Date/Description, Effacer/Enregistrer tous présents', () => {
  for (const id of ['mcSelectedSummary', 'mcSelectedMeta', 'mcMetaCode', 'mcMetaLabel', 'mcMetaCategory',
    'mcPoste', 'mcAgentSelect', 'mcLieu', 'mcDatetime', 'mcDescription', 'mcSaveBtn']) {
    assert.match(mcHtml, new RegExp('id="' + id + '"'), 'panneau : id manquant ' + id);
  }
  assert.match(mcHtml, /onclick="resetMainCouranteForm\(\)"/);
  assert.match(mcHtml, /onclick="ajouterMainCourante\(\)"/);
  assert.match(mcHtml, /id="mcSaveBtn"[^>]*disabled/, 'Enregistrer doit démarrer désactivé (aucune sélection)');
});

test('Agent en service est un <select>, plus un champ texte libre — jamais un nom inventé', () => {
  assert.match(mcHtml, /<select id="mcAgentSelect">/);
  assert.doesNotMatch(mcHtml, /id="mcAgent"[^S]/, 'ancien champ texte libre mcAgent ne doit plus exister');
  assert.match(appSource, /function renderMcAgentOptions\(\)\{/);
  assert.match(appSource, /cache\.employes/, 'la liste doit venir des employés réels, pas d’une liste inventée');
});

test('le sélecteur "Type d\'événement" libre et les boutons de saisie rapide ont été retirés (remplacés par la grille codifiée)', () => {
  assert.doesNotMatch(mcHtml, /id="mcType"/);
  assert.doesNotMatch(mcHtml, /id="mcPriorite"/);
  assert.doesNotMatch(appSource, /function quickMC\(/);
});

test('PCS01 : case à cocher présente, masquée par défaut, jamais pré-cochée par un code', () => {
  assert.match(mcHtml, /id="mcPcs01Row"[^>]*hidden/);
  assert.match(mcHtml, /id="mcPcs01Check"/);
  assert.doesNotMatch(mcHtml, /id="mcPcs01Check"[^>]*checked/);
});

test('POST /maincourante et POST /incidents envoient le code sélectionné, jamais un code différent de celui affiché', () => {
  assert.match(appSource, /code:\s*ev\.code,\s*categorie:\s*ev\.category/);
});

test('la relation "10.06/10.10 + 10.05" reste une métadonnée affichée (relatedCode), jamais une création automatique d’une deuxième entrée', () => {
  assert.match(appSource, /ev\.relatedCode/);
  const start = appSource.indexOf('async function ajouterMainCourante');
  const end = appSource.indexOf('\nfunction resetMainCouranteForm');
  const fnBody = appSource.slice(start, end);
  const postMaincouranteCalls = fnBody.match(/API\.post\('\/maincourante'/g) || [];
  assert.equal(postMaincouranteCalls.length, 1,
    'ajouterMainCourante() ne doit poster qu’UNE seule entrée Main courante par sélection — jamais une deuxième "10.05" automatique');
});

test('15.100 reste visuellement distinct (urgence) et affiche la consigne officielle sans la modifier', () => {
  assert.match(appSource, /ev\.instructions/);
  assert.match(mcHtml, /class="mc-urgency"/);
});

/* ============================================================ */
/*  2. Fonctions pures : mcEventLabel / mcCategoryLabel            */
/* ============================================================ */

function loadPureHelpers() {
  const context = vm.createContext({ console, mcEventCatalog: { categories: mcEvents.CATEGORIES, events: mcEvents.EVENTS }, mcSelectedEventCode: null });
  // Isole juste les deux fonctions pures (aucune dépendance DOM) plutôt que
  // de charger app.js en entier (qui exécute des document.addEventListener
  // au chargement — hors sujet ici, déjà couvert par les tests topbar).
  const start = appSource.indexOf('function mcEventLabel');
  const end = appSource.indexOf('function mcEventButtonHtml');
  const slice = appSource.slice(start, end);
  new vm.Script(slice, { filename: 'mc-pure.js' }).runInContext(context);
  return {
    mcEventLabel: ev => new vm.Script('mcEventLabel(' + JSON.stringify(ev) + ')').runInContext(context),
    mcCategoryLabel: id => new vm.Script('mcCategoryLabel(' + JSON.stringify(id) + ')').runInContext(context),
  };
}

test('mcEventLabel() renvoie le libellé officiel quand il existe', () => {
  const { mcEventLabel } = loadPureHelpers();
  assert.equal(mcEventLabel({ code: '10.17', labelFr: "Tentative d'intrusion" }), "Tentative d'intrusion");
});

test('mcEventLabel() : 15.04/15.70/15.80 (labelFr absent) affichent un espace réservé explicite, jamais un texte inventé', () => {
  const { mcEventLabel } = loadPureHelpers();
  for (const code of ['15.04', '15.70', '15.80']) {
    const ev = mcEvents.findEvent(code);
    const label = mcEventLabel(ev);
    assert.match(label, /libellé à compléter/);
    assert.match(label, new RegExp(code.replace('.', '\\.')));
  }
});

test('mcCategoryLabel() résout le libellé de catégorie depuis le référentiel réel', () => {
  const { mcCategoryLabel } = loadPureHelpers();
  assert.equal(mcCategoryLabel('incidents_securite'), 'Incidents / Sécurité');
  assert.equal(mcCategoryLabel('urgence'), 'Urgence');
});

/* ============================================================ */
/*  3. Garde-fou CSS — régression exacte de cette mission          */
/* ============================================================ */

test('cause racine : aucun "*/" ne survit à la suppression des commentaires réels (preuve directe qu’aucun commentaire n’a été fermé prématurément)', () => {
  // Reproduction exacte du bug de cette mission : un commentaire écrit
  // "(--color-*/--radius-*/--shadow-sm)" contient DEUX "*/" avant sa vraie
  // fin voulue. Le moteur CSS du navigateur (comme la regex non-gourmande
  // ci-dessous, qui a le même comportement d'arrêt-au-premier-match)
  // referme le commentaire au TOUT PREMIER "*/" rencontré : la règle
  // .mc-entry-body{display:grid...} qui suivait dans le fichier
  // disparaissait du CSSOM (confirmé par getComputedStyle : display:block
  // au lieu de grid — jamais visible par une simple lecture du fichier,
  // le texte de la règle reste bien présent tel quel). Signature fiable :
  // un "*/" orphelin (sans son "/*" d'origine, déjà consommé par un
  // commentaire précédent tronqué) reste forcément dans le texte non
  // commenté après une suppression des commentaires réels — en CSS valide,
  // "*/" n'apparaît jamais en dehors d'un commentaire.
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');
  const strayIndex = withoutComments.indexOf('*/');
  assert.equal(strayIndex, -1,
    strayIndex >= 0 ? 'commentaire CSS fermé prématurément près de : '
      + JSON.stringify(withoutComments.slice(Math.max(0, strayIndex - 80), strayIndex + 20)) : undefined);
});

test('cause racine : .mc-entry-body déclare bien display:grid en dehors de tout commentaire', () => {
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(withoutComments, /\.mc-entry-body\{display:grid/);
});
