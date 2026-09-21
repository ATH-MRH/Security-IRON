'use strict';
// Accessibilité de la modale partagée (frontend/js/ui.js: showModal/
// confirmModal/closeModal, frontend/index.html #modalBackdrop) — composant
// commun à toute l'application (19 points d'appel : alertes, notifications,
// Main courante V2, etc.), jamais dupliqué par workflow.
//
// Écart trouvé pendant la revue adversariale du portage Main courante V2
// PostgreSQL : la modale n'avait ni role="dialog"/aria-modal, ni piège de
// focus, ni fermeture Escape, ni retour de focus au déclencheur — corrigé
// une seule fois ici au niveau du composant partagé, ce qui couvre les 19
// appelants sans modification individuelle. Comportement interactif complet
// (Tab/Shift+Tab réel, focus effectif) vérifié en navigateur réel
// Playwright ; ce fichier verrouille le câblage au niveau source, comme le
// reste de la suite (pas de dépendance Playwright committée).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const uiSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');

test('#modalContent porte role=dialog, aria-modal et aria-labelledby vers le titre', () => {
  assert.match(htmlSource, /id="modalContent"[^>]*role="dialog"/);
  assert.match(htmlSource, /id="modalContent"[^>]*aria-modal="true"/);
  assert.match(htmlSource, /id="modalContent"[^>]*aria-labelledby="modalTitleId"/);
});

test('showModal() et confirmModal() posent id="modalTitleId" sur le titre réellement rendu', () => {
  assert.match(uiSource, /class="modal-title" id="modalTitleId"/);
  const occurrences = uiSource.match(/class="modal-title" id="modalTitleId"/g) || [];
  assert.equal(occurrences.length, 2, 'showModal() ET confirmModal() doivent tous deux poser cet id — sinon aria-labelledby pointe dans le vide pour l\'un des deux');
});

test('un seul gestionnaire clavier global gère Escape (fermeture) et Tab (piège de focus), actif seulement modale ouverte', () => {
  assert.match(uiSource, /document\.addEventListener\('keydown', e => \{[\s\S]*?if \(!backdrop \|\| !backdrop\.classList\.contains\('show'\)\) return;/);
  assert.match(uiSource, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); closeModal\(\); return; \}/);
  assert.match(uiSource, /if \(e\.key !== 'Tab'\) return;/);
});

test('le piège de focus cycle réellement entre premier et dernier élément focusable (jamais une évasion Shift+Tab/Tab)', () => {
  assert.match(uiSource, /e\.shiftKey && document\.activeElement === first.*last\.focus\(\)/);
  assert.match(uiSource, /!e\.shiftKey && document\.activeElement === last.*first\.focus\(\)/);
});

test('closeModal() rend le focus à l\'élément déclencheur, jamais silencieusement perdu sur <body>', () => {
  assert.match(uiSource, /function closeModal\(\)\{[\s\S]*?_modalTriggerEl[\s\S]*?\.focus\(\)/);
});

test('showModal()/confirmModal() ne recapturent pas le déclencheur sur un ré-rendu pendant que la modale est déjà ouverte (ex. changement de langue dans un workflow)', () => {
  assert.match(uiSource, /function _modalOpening\(\)\{[\s\S]*?if \(!backdrop\.classList\.contains\('show'\)\) _modalTriggerEl = document\.activeElement;/);
});

test('showModal()/confirmModal() donnent le focus initial à un élément réel de la modale à l\'ouverture', () => {
  assert.match(uiSource, /_modalFocusFirst\(\);/);
  const occurrences = uiSource.match(/_modalFocusFirst\(\);/g) || [];
  assert.equal(occurrences.length, 2, 'showModal() ET confirmModal() doivent tous deux déplacer le focus à l\'ouverture');
});
