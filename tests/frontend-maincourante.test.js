'use strict';
// MAIN COURANTE — grille de codification (backend/maincourante-events.js,
// jamais recréée) + moteur de workflows PostgreSQL (portage propre étudié
// sur feature/securisite-alert-core, SQLite, jamais copié tel quel — voir
// backend/maincourante-workflows.js et frontend/js/maincourante-workflows.js).
//
// Depuis le portage workflows, sélectionner un code dans la grille ouvre
// directement le formulaire réel du workflow (modal partagée, contenu
// piloté par code) au lieu de l'ancien panneau latéral générique Poste/
// Agent/Lieu/Description — ce fichier verrouille ce câblage.
//
// Couverture (statique + fonctions pures, sans navigateur — le comportement
// interactif complet [sélection, recherche, formulaires par workflow,
// lookup APS, PCS01, FR/AR/RTL, mobile] a été vérifié en navigateur réel
// Playwright, documenté dans le rapport de mission ; aucune dépendance
// Playwright dans package.json, donc pas de test navigateur committé ici,
// comme pour le reste de la suite) :
//  1. Câblage statique index.html <-> app.js/maincourante-workflows.js.
//  2. Fonctions pures (mcEventLabel/mcCategoryLabel) — le cas 15.04/15.70/
//     15.80 sans libellé fourni ("NE PAS INVENTER") est directement
//     vérifiable sans DOM.
//  3. Garde-fou CSS : régression exacte trouvée pendant la mission grille —
//     un "*/" littéral dans le commentaire précédant .mc-entry-body fermait
//     le commentaire prématurément et faisait disparaître toute la règle
//     display:grid du CSSOM du navigateur (repéré via getComputedStyle,
//     jamais via une simple lecture du fichier). Verrouillé ici au niveau
//     source pour ne jamais revenir silencieusement.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');
const workflowsSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/maincourante-workflows.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');
const mcEvents = require('../backend/maincourante-events');
const { WORKFLOWS } = require('../backend/maincourante-workflows');

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

test('grille de saisie : chaque bouton événement ouvre le workflow réel via MainCouranteWorkflows (jamais décoratif)', () => {
  assert.match(appSource, /function selectMcEvent\(code\)\{/);
  assert.match(appSource, /MainCouranteWorkflows\.open\(code\)/);
  assert.match(appSource, /onclick="selectMcEvent\('\$\{ev\.code\}'\)"/);
});

test('site/zone/configuration : sélecteurs présents et câblés sur le moteur de workflows réel', () => {
  for (const id of ['mcWorkflowSite', 'mcWorkflowZone', 'mcConfigure']) {
    assert.match(mcHtml, new RegExp('id="' + id + '"'), 'toolbar : id manquant ' + id);
  }
  assert.match(mcHtml, /MainCouranteWorkflows\.setSite\(this\.value\)/);
  assert.match(mcHtml, /MainCouranteWorkflows\.setZone\(this\.value\)/);
  assert.match(mcHtml, /MainCouranteWorkflows\.configure\(\)/);
  assert.match(mcHtml, /id="mcConfigure"[^>]*hidden/, 'masqué par défaut : admin résolu par le serveur (context.permissions.admin), jamais deviné côté client');
});

test('frontend/js/maincourante-workflows.js est bien chargé, avant app.js (selectMcEvent en dépend)', () => {
  const wfIdx = htmlSource.indexOf('js/maincourante-workflows.js');
  const appIdx = htmlSource.indexOf('js/app.js');
  assert.ok(wfIdx > 0, 'script maincourante-workflows.js absent de index.html');
  assert.ok(wfIdx < appIdx, 'doit être chargé avant app.js');
});

test('l’ancien panneau latéral générique (Poste/Agent/Lieu/Description/Enregistrer statiques) a été retiré : chaque workflow porte ses vrais champs', () => {
  for (const id of ['mcSelectedSummary', 'mcSelectedMeta', 'mcPoste', 'mcAgentSelect', 'mcLieu', 'mcDatetime', 'mcDescription', 'mcSaveBtn', 'mcPcs01Check']) {
    assert.doesNotMatch(mcHtml, new RegExp('id="' + id + '"'), 'ancien panneau : id encore présent ' + id);
  }
  assert.doesNotMatch(appSource, /function ajouterMainCourante\(/);
  assert.doesNotMatch(appSource, /function resetMainCouranteForm\(/);
  assert.doesNotMatch(appSource, /function renderMcAgentOptions\(/);
});

test('le sélecteur "Type d\'événement" libre et les boutons de saisie rapide restent retirés (remplacés par la grille codifiée)', () => {
  assert.doesNotMatch(mcHtml, /id="mcType"/);
  assert.doesNotMatch(mcHtml, /id="mcPriorite"/);
  assert.doesNotMatch(appSource, /function quickMC\(/);
});

test('moteur de workflows : APS jamais saisi en texte libre — toujours une recherche + une identité en lecture seule', () => {
  assert.match(workflowsSource, /data-aps-search/);
  assert.match(workflowsSource, /lecture seule/);
  assert.doesNotMatch(workflowsSource, /<input[^>]*data-field="agent_id"/, 'agent_id ne doit jamais être un champ texte libre');
});

test('PCS01 : case à cocher affichée uniquement si le serveur l’autorise (context.capabilities.pcs01), jamais pré-cochée par un code', () => {
  assert.match(workflowsSource, /context\.capabilities\.pcs01/);
  assert.doesNotMatch(workflowsSource, /id="mcWfPcs01"[^`]*checked/);
});

test('photo APS : jamais une balise <img src> brute vers la route authentifiée (ne porterait pas le jeton) — récupérée en blob authentifié', () => {
  assert.doesNotMatch(workflowsSource, /<img src="[^"]*\/aps\//, 'une balise <img> ne peut pas porter l’en-tête Authorization');
  assert.match(workflowsSource, /Authorization.*API\.getToken\(\)/);
});

test('POST /maincourante/events envoie le code réellement sélectionné, jamais un autre', () => {
  assert.match(workflowsSource, /code, site_id: siteId, zone_id: zoneId, data, trigger_pcs01/);
});

test('la relation "10.06/10.07/10.10 + 10.05" reste une métadonnée affichée (relatedCode), jamais une création automatique d’une deuxième entrée', () => {
  assert.match(workflowsSource, /w\.relatedCode/);
  const submitStart = workflowsSource.indexOf('async function submit()');
  const submitEnd = workflowsSource.indexOf('\n  /* =', submitStart);
  const fnBody = workflowsSource.slice(submitStart, submitEnd);
  const postEventCalls = fnBody.match(/API\.post\('\/maincourante\/events/g) || [];
  assert.equal(postEventCalls.length, 1,
    'submit() ne doit poster qu’UN seul événement par soumission — jamais une deuxième "10.05" automatique');
});

test('15.100 reste visuellement distinct (urgence) et affiche la consigne officielle sans la modifier', () => {
  assert.match(workflowsSource, /w\.instructions/);
  assert.match(mcHtml, /class="mc-urgency"/);
  assert.equal(mcEvents.findEvent('15.100').instructions,
    "Observer et signaler tout comportement suspect. Surveiller les accès, entrées et sorties. Garder un suivi visuel de la situation sans se mettre en danger.");
});

test('les 29 codes officiels ont chacun une définition de workflow (fields/aps) ou sont explicitement non configurés (15.04/15.70/15.80 uniquement)', () => {
  const definedCodes = Object.keys(WORKFLOWS).sort();
  const allCodes = mcEvents.EVENTS.map(e => e.code).sort();
  const undefinedCodes = allCodes.filter(c => !definedCodes.includes(c));
  assert.deepEqual(undefinedCodes.sort(), ['15.04', '15.70', '15.80']);
  for (const code of definedCodes) assert.ok(mcEvents.findEvent(code), 'workflow défini pour un code inconnu du référentiel : ' + code);
});

/* ============================================================ */
/*  2. Fonctions pures : mcEventLabel / mcCategoryLabel            */
/* ============================================================ */

function loadPureHelpers() {
  const context = vm.createContext({ console, mcEventCatalog: { categories: mcEvents.CATEGORIES, events: mcEvents.EVENTS } });
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

test('cause racine : les règles Main courante autour de l’ancien point de rupture parsent bien en dehors de tout commentaire', () => {
  // .mc-entry-body{display:grid...} (le sujet original de la régression) a
  // depuis été retiré avec l'ancien panneau latéral (remplacé par le moteur
  // de workflows, formulaire en modale) — la garde générale ci-dessus (aucun
  // "*/" orphelin) reste la protection réelle ; celle-ci ancre juste la
  // preuve sur une règle qui vit toujours au même endroit du fichier.
  const withoutComments = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(withoutComments, /\.mc-workflow-toolbar\{display:flex/);
});
