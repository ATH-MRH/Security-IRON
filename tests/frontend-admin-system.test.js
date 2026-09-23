'use strict';
// Administration Système — frontend/js/admin-system.js. Couverture statique
// (comme tests/frontend-maincourante.test.js) : comportement interactif
// complet vérifié en navigateur réel Playwright (rapport de mission),
// verrouillé ici au niveau source pour ne jamais revenir silencieusement.
//
// FINITION VISUELLE (Vue générale) verrouillée ici :
//  1. L'en-tête n'annonce "Système opérationnel" que si le socle critique
//     (application + PostgreSQL) est réellement opérationnel — jamais un
//     résumé optimiste incluant des services "non configurés".
//  2. La carte État des services distingue Indisponible de Non configuré/
//     À vérifier — jamais fusionnés.
//  3. Répartition des événements / Sites les plus actifs : omis de la
//     grille sans donnée réelle, jamais une grande carte vide.
//  4. Main courante 7 jours : empty-state compact si 0, jamais un "0" nu
//     flottant dans une carte par ailleurs vide (mais le 0 réel reste
//     affiché quand il a un sens — Sites par statut, État des services).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../frontend/js/admin-system.js'), 'utf8');

test('le badge d\'en-tête dit "Système opérationnel", jamais "Tous les services opérationnels" (ne pas laisser croire que les services non configurés le sont)', () => {
  assert.match(src, /t\('Système opérationnel'/);
  // Seul le commentaire explicatif de la finition peut encore nommer
  // l'ancien texte — jamais l'appel t(...) réellement rendu à l'écran.
  assert.doesNotMatch(src, /t\('Tous les services opérationnels'/);
});

test('le badge d\'en-tête ne se base que sur le socle critique (application + PostgreSQL), jamais sur tous les services confondus', () => {
  assert.match(src, /CRITICAL_SERVICES\s*=\s*\['application',\s*'postgresql'\]/);
  assert.match(src, /criticalOk\s*=\s*CRITICAL_SERVICES\.every/);
});

test('l\'État des services distingue Indisponible de Non configuré / À vérifier — jamais fusionnés en un seul badge générique', () => {
  assert.match(src, /'unavailable'\s*\?\s*`<span class="badge danger">\$\{t\('Indisponible'/);
  assert.match(src, /'not_configured'\s*\?\s*`<span class="badge muted">\$\{t\('Non configuré'/);
});

test('Répartition des événements et Sites les plus actifs sont omis de la grille sans données réelles, jamais une grande carte "Donnée non disponible"', () => {
  assert.match(src, /hasCategoryData\s*\?\s*\{[\s\S]{0,120}Répartition des événements/);
  assert.match(src, /hasTopSites\s*\?\s*\{[\s\S]{0,120}Sites les plus actifs/);
  // Le filtre .filter(Boolean) doit suivre : un widget absent (null) est
  // réellement retiré du tableau avant rendu, pas juste masqué en CSS.
  assert.match(src, /\]\.filter\(Boolean\)/);
});

test('Sites par statut et État des services restent toujours affichés (un vrai zéro n\'est jamais un motif de masquage)', () => {
  const widgetsBlock = src.slice(src.indexOf('const widgets ='), src.indexOf('.filter(Boolean)'));
  assert.match(widgetsBlock, /Sites par statut/);
  assert.doesNotMatch(widgetsBlock, /hasSitesByStatus/, 'Sites par statut ne doit jamais être conditionné à la présence de données — ses catégories sont réelles et fixes même à 0');
});

test('Main courante 7 jours affiche un empty-state compact à 0, un vrai nombre sinon — jamais un "0" nu isolé', () => {
  assert.match(src, /const mc7dHtml = mc7d > 0/);
  assert.match(src, /Aucun événement sur les 7 derniers jours/);
});

test('les Actions rapides (6 boutons réels) sont toujours présentes dans la Vue générale', () => {
  for (const label of ['Ajouter un site', 'Créer un utilisateur', 'Configurer Main courante', 'Gérer les accès', "Voir l'audit", 'Données & archivage']) {
    assert.match(src, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  // Chaque bouton appelle une vraie fonction du module, jamais un placeholder.
  assert.match(src, /AdminSystem\.openSiteWizard\(\)/);
  assert.match(src, /AdminSystem\.openCreateUserModal\(\)/);
});

test('les 6 KPI (icon2 + valeur + pied de carte réel) restent inchangés par la finition', () => {
  const kpiKeys = ['Sites', 'Utilisateurs', 'Codes Main courante', 'Postes actifs', 'Circuits de ronde', 'Caméras'];
  const kpiBlock = src.slice(src.indexOf('const kpiDefs ='), src.indexOf('const kpiHtml ='));
  for (const key of kpiKeys) assert.match(kpiBlock, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

/* ============================================================ */
/*  Suppression de site — jamais un bouton trivial : motif requis, */
/*  refus si dépendances réelles, jamais un DELETE sans confirmation*/
/* ============================================================ */
test('le bouton "Supprimer" du tableau Sites entre en mode sélection, jamais un DELETE immédiat au clic', () => {
  assert.match(src, /onclick="AdminSystem\.toggleSitesSelectMode\(\)"/);
  assert.match(src, /function toggleSitesSelectMode\(\)/);
});

test('la suppression groupée exige un motif non vide avant tout appel DELETE', () => {
  const block = src.slice(src.indexOf('function confirmDeleteSelectedSites'), src.indexOf('function confirmDeleteSelectedSites') + 1200);
  assert.match(block, /if \(!reason\) \{ notify\('Motif requis', 'error'\); return; \}/);
  assert.match(block, /API\.del\('\/admin\/sites\/' \+ id, \{ reason \}\)/);
});

test('la suppression groupée avertit explicitement qu\'un site avec des données réelles sera refusé, jamais une promesse de succès systématique', () => {
  const block = src.slice(src.indexOf('function confirmDeleteSelectedSites'), src.indexOf('function confirmDeleteSelectedSites') + 1200);
  assert.match(block, /Refusée automatiquement pour tout site avec des données réelles associées/);
});

test('la suppression individuelle (fiche site) exige aussi un motif et affiche l\'erreur réelle du backend en cas de refus', () => {
  const block = src.slice(src.indexOf('function confirmDeleteSite'), src.indexOf('function confirmDeleteSite') + 1100);
  assert.match(block, /if \(!reason\) \{ notify\('Motif requis', 'error'\); return; \}/);
  assert.match(block, /catch \(e\) \{ notify\(e\.message \|\| 'Erreur', 'error'\); \}/);
});

test('DELETE réel : le bouton Supprimer de la fiche site appelle confirmDeleteSite, jamais un lien mort', () => {
  assert.match(src, /onclick="AdminSystem\.confirmDeleteSite\('\$\{site\.id\}'/);
});
