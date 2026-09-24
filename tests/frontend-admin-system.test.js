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
const uiSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');
const cssSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');

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
  assert.match(block, /API\.del\('\/admin\/sites\/' \+ s\.id, \{ reason \}\)/);
});

test('la suppression groupée avertit explicitement qu\'un site avec des données réelles sera refusé, jamais une promesse de succès systématique', () => {
  const block = src.slice(src.indexOf('function confirmDeleteSelectedSites'), src.indexOf('function confirmDeleteSelectedSites') + 1200);
  assert.match(block, /Refusée automatiquement pour tout site avec des données réelles associées/);
});

test('la suppression individuelle (fiche site) exige aussi un motif ; un refus 409 (dépendances) ouvre la modale de gestion, jamais un simple toast', () => {
  const block = src.slice(src.indexOf('function confirmDeleteSite'), src.indexOf('function confirmDeleteSelectedSites'));
  assert.match(block, /if \(!reason\) \{ notify\('Motif requis', 'error'\); return; \}/);
  assert.match(block, /if \(e\.status === 409\) \{ closeModal\(\); showSiteDeleteRefusedModal\(\{ id, name, code \}\); return; \}/);
  assert.match(block, /notify\(e\.message \|\| 'Erreur', 'error'\);/, 'toute autre erreur (400/404/...) garde le toast générique existant');
});

test('DELETE réel : le bouton Supprimer de la fiche site appelle confirmDeleteSite (avec le code du site), jamais un lien mort', () => {
  assert.match(src, /onclick="AdminSystem\.confirmDeleteSite\('\$\{site\.id\}'/);
  const btnLine = src.split('\n').find(l => l.includes("AdminSystem.confirmDeleteSite('${site.id}'"));
  assert.ok(btnLine, 'bouton Supprimer introuvable dans la fiche site');
  assert.match(btnLine, /\$\{site\.code\}/, 'le code du site doit être transmis — nécessaire au libellé de la modale de refus ("Le site « nom (code) »")');
});

/* ============================================================ */
/*  MISSION CORRECTION CIBLÉE — SITES : gestion d'une suppression   */
/*  refusée (dépendances réelles) — interface administrative       */
/*  claire, jamais un message technique brut ; AUCUNE protection    */
/*  existante contournée (409/FK/motif/audit/permissions/RLS).     */
/* ============================================================ */
test('un refus (409) ouvre une modale expliquant pourquoi, jamais le texte technique brut ("N refusé(s)")', () => {
  assert.doesNotMatch(src, /refusé\(s\) \(dépendances réelles\)/, 'l\'ancien message technique groupé ne doit plus jamais être affiché');
  assert.match(src, /function showSiteDeleteRefusedModal\(site\)\s*\{/);
  assert.match(src, /Suppression impossible — dépendances existantes/);
  assert.match(src, /La suppression directe est bloquée afin de préserver l'intégrité et l'historique du système\./);
});

test('la modale de refus propose les 4 actions attendues : Voir les dépendances, Désactiver, Archiver, Annuler', () => {
  const block = src.slice(src.indexOf('function showSiteDeleteRefusedModal'), src.indexOf('function showMultipleSitesRefusedModal'));
  assert.match(block, /Voir les dépendances/);
  assert.match(block, /Désactiver/);
  assert.match(block, /Archiver/);
  // "Annuler" est le bouton natif de showModal() (ui.js, footer partagé par
  // toutes les modales) — jamais reconstruit dans admin-system.js.
  assert.match(block, /showModal\(/, 'la modale de refus doit utiliser le mécanisme showModal() partagé, pas un composant ad hoc');
  assert.match(uiSrc, /<button class="btn btn-outline" onclick="closeModal\(\)">Annuler<\/button>/);
});

test('Désactiver/Archiver réutilisent le cycle de vie EXISTANT (setSiteStatus -> PUT /sites/:id/status, déjà audité) — jamais un second mécanisme', () => {
  const block = src.slice(src.indexOf('function showSiteDeleteRefusedModal'), src.indexOf('function showMultipleSitesRefusedModal'));
  assert.match(block, /AdminSystem\.setSiteStatus\('\$\{site\.id\}','suspended'\)/);
  assert.match(block, /AdminSystem\.setSiteStatus\('\$\{site\.id\}','archived'\)/);
  // setSiteStatus() elle-même n'est pas redéfinie ici — un seul déclarant dans tout le fichier.
  const declCount = (src.match(/async function setSiteStatus\(/g) || []).length;
  assert.equal(declCount, 1);
});

test('"Voir les dépendances" utilise le endpoint réel existant (GET /sites/:id/dependencies), mêmes catégories que l\'onglet Dépendances de la fiche site — jamais un second calcul', () => {
  assert.match(src, /async function showRefusedModalDependencies\(id\)\s*\{/);
  assert.match(src, /API\.get\('\/admin\/sites\/' \+ id \+ '\/dependencies'\)/);
  // renderDependenciesTable() est la SEULE source de rendu du tableau de
  // dépendances, réutilisée par la fiche site (onglet Dépendances) ET par
  // la modale de refus — jamais deux gabarits divergents.
  assert.match(src, /function renderDependenciesTable\(deps, siteId, targetId\)\s*\{/);
  assert.match(src, /\$\{renderDependenciesTable\(deps, site\.id, 'siteTab-deps'\)\}/, 'la fiche site (onglet Dépendances) doit réutiliser le même gabarit');
  const tableBlock = src.slice(src.indexOf('function renderDependenciesTable'), src.indexOf('function renderDependenciesTable') + 1400);
  for (const cat of ['Zones', 'Postes', 'appartenances actives', 'Main courante', 'Rondes', 'quipements', 'ronde', 'APS', 'Présences', 'PCS01']) {
    assert.match(tableBlock, new RegExp(cat));
  }
});

test('la purge définitive n\'est PAS développée ici — seulement une indication vers Données & archivage (LOT 18, déjà nommé ailleurs)', () => {
  assert.doesNotMatch(src, /function purgeS/i, 'aucune fonction de purge ne doit être créée par cette mission');
  const block = src.slice(src.indexOf('function showSiteDeleteRefusedModal'), src.indexOf('function manageRefusedSite') + 200);
  assert.match(block, /La purge définitive des données est une opération d'administration avancée et doit être réalisée depuis <strong>Données &amp; archivage<\/strong>\./);
});

test('un refus multiple (sélection groupée) liste chaque site refusé avec une action "Gérer" — jamais fusionné en un seul compteur opaque', () => {
  assert.match(src, /function showMultipleSitesRefusedModal\(sites\)\s*\{/);
  assert.match(src, /function manageRefusedSite\(id, name, code\)\s*\{/);
  const block = src.slice(src.indexOf('function confirmDeleteSelectedSites'), src.indexOf('function statusBadge'));
  assert.match(block, /if \(refused\.length === 1\) showSiteDeleteRefusedModal\(refused\[0\]\);/);
  assert.match(block, /else if \(refused\.length > 1\) showMultipleSitesRefusedModal\(refused\);/);
});

test('le refus reste un vrai 409 backend (jamais un contournement) : confirmDeleteSite/confirmDeleteSelectedSites appellent toujours DELETE /admin/sites/:id avec un motif, la seule route existante', () => {
  assert.doesNotMatch(src, /\/admin\/sites\/[^']*\/force/i);
  assert.doesNotMatch(src, /skipDependenc/i);
  assert.match(src, /API\.del\('\/admin\/sites\/' \+ id, \{ reason \}\)/);
  assert.match(src, /API\.del\('\/admin\/sites\/' \+ s\.id, \{ reason \}\)/);
});

/* ============================================================ */
/*  MISSION — DÉPENDANCES SITE : drill-down et gestion des           */
/*  appartenances (correction ciblée du 24/09).                      */
/* ============================================================ */
test('renderDependenciesTable affiche le sous-titre demandé et met en évidence UNIQUEMENT les compteurs > 0 (⚠, gras), jamais une alerte sur une catégorie à 0', () => {
  assert.match(src, /Dépendances empêchant la suppression/);
  const block = src.slice(src.indexOf('function renderDependenciesTable'), src.indexOf('async function showRefusedModalDependencies'));
  assert.match(block, /const positive = value > 0/);
  assert.match(block, /⚠/);
  assert.doesNotMatch(block, /class="badge danger"/, 'aucune alerte rouge générique sur les dépendances — seule la mise en évidence ⚠/gras demandée');
});

test('"Voir" n\'apparaît QUE sur la catégorie "Utilisateurs / appartenances actives" (seule à avoir un détail réel derrière) — jamais un bouton mort sur les autres catégories', () => {
  const block = src.slice(src.indexOf('function renderDependenciesTable'), src.indexOf('async function showRefusedModalDependencies'));
  const voirCount = (block.match(/viewAction\)/g) || []).length + (block.match(/viewSiteMembershipDependencies/g) || []).length;
  assert.ok(voirCount >= 1);
  // Une seule des 10 catégories passe un viewAction non-undefined (le
  // 5e argument de row(), présent uniquement sur la ligne "Utilisateurs").
  assert.match(block, /row\('Utilisateurs \/ appartenances actives', deps\.active_memberships, `AdminSystem\.viewSiteMembershipDependencies/);
  for (const cat of ['Zones', 'Postes', 'Événements Main courante', 'Rondes', 'Équipements', 'Circuits de ronde', 'Profils APS', 'Présences (cycles APS)', 'PCS01']) {
    const re = new RegExp('row\\(\'' + cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\', deps\\.\\w+\\)\\}');
    assert.match(block, re, cat + ' ne doit prendre AUCUN 3e argument (pas de bouton Voir)');
  }
});

test('viewSiteMembershipDependencies charge le VRAI détail (GET /sites/:id/dependencies/memberships) et affiche les champs exacts demandés, en cartes empilées (jamais un tableau large coupé dans une modale à 390px)', () => {
  assert.match(src, /async function viewSiteMembershipDependencies\(siteId, targetId\)\s*\{/);
  assert.match(src, /API\.get\('\/admin\/sites\/' \+ siteId \+ '\/dependencies\/memberships'\)/);
  const block = src.slice(src.indexOf('async function viewSiteMembershipDependencies'), src.indexOf('async function backToSiteDependencies'));
  for (const field of ['Identifiant', 'Rôle', 'Groupe', 'Type de scope', 'Site', 'Créé le']) {
    assert.match(block, new RegExp('<dt>' + field + '</dt>'));
  }
  // Statut (badge) et Actions (bouton Gérer) vivent hors de <dl> mais
  // restent bien présents pour chaque appartenance.
  assert.match(block, /m\.status === 'active'/);
  assert.match(block, /AdminSystem\.manageMembershipModal/);
  // Identité réelle des lignes, jamais un placeholder.
  assert.match(block, /m\.nom_complet \|\| m\.username/);
  assert.match(block, /m\.username/);
  assert.match(block, /roleLabel\(m\.membership_role\)/);
  assert.match(block, /m\.tenant_name/);
  // "← Retour" ramène au tableau récapitulatif, dans le MÊME conteneur.
  assert.match(block, /← Retour aux dépendances/);
  assert.match(block, /AdminSystem\.backToSiteDependencies\('\$\{siteId\}','\$\{targetId\}'\)/);
});

test('la carte d\'appartenance reste utilisable à 390px : disposition en une seule colonne sous ce seuil', () => {
  const block = cssSrc.slice(cssSrc.indexOf('.dep-membership-card{'), cssSrc.indexOf('.dep-membership-card{') + 700);
  assert.match(block, /@media\(max-width:420px\)\{\.dep-membership-card-fields\{grid-template-columns:1fr\}\}/);
});

test('un compte Administrateur global est signalé dans la liste des appartenances, jamais confondu avec un rôle d\'appartenance ordinaire', () => {
  const block = src.slice(src.indexOf('async function viewSiteMembershipDependencies'), src.indexOf('async function backToSiteDependencies'));
  assert.match(block, /m\.account_role === 'admin'/);
  assert.match(block, /Admin global/);
});

test('manageMembershipModal ne propose que les 2 actions réellement compatibles avec le modèle memberships (Retirer / Réaffecter), jamais une 3e action fabriquée', () => {
  assert.match(src, /function manageMembershipModal\(membershipId, siteId, targetId\)\s*\{/);
  const block = src.slice(src.indexOf('function manageMembershipModal'), src.indexOf('async function archiveMembershipAction'));
  assert.match(block, /siteMembershipsCache\.find\(x => x\.membership_id === membershipId\)/, 'doit retrouver l\'objet complet depuis le cache — jamais du JSON brut réinjecté dans un attribut HTML (risque XSS inutile)');
  assert.match(block, /Retirer l'accès à ce site/);
  assert.match(block, /Réaffecter à un autre groupe\/site/);
  assert.match(block, /AdminSystem\.archiveMembershipAction/);
  assert.match(block, /AdminSystem\.reassignMembershipModal/);
});

test('manageMembershipModal rassure explicitement quand l\'utilisateur cible est Administrateur global : ses privilèges globaux ne dépendent jamais de cette appartenance', () => {
  const block = src.slice(src.indexOf('function manageMembershipModal'), src.indexOf('async function archiveMembershipAction'));
  assert.match(block, /m\.account_role === 'admin'/);
  assert.match(block, /ne retire JAMAIS ses privilèges globaux/);
});

test('archiveMembershipAction archive UNE appartenance précise (DELETE /admin/memberships/:id), rafraîchit les dépendances, et ne déclenche JAMAIS la suppression du site', () => {
  assert.match(src, /async function archiveMembershipAction\(membershipId, siteId, targetId\)\s*\{/);
  const block = src.slice(src.indexOf('async function archiveMembershipAction'), src.indexOf('async function reassignMembershipModal'));
  assert.match(block, /API\.del\('\/admin\/memberships\/' \+ membershipId\)/);
  assert.match(block, /await viewSiteMembershipDependencies\(siteId, targetId\)/, 'les dépendances doivent être rafraîchies automatiquement (§5 mission)');
  assert.doesNotMatch(block, /API\.del\('\/admin\/sites\//, 'la suppression du site ne doit JAMAIS être déclenchée automatiquement — l\'administrateur doit revenir cliquer lui-même sur Supprimer');
});

test('reassignMembershipModal réutilise le modèle existant (archive puis POST /admin/groups/:id/users) — jamais un mécanisme de "déplacement" inventé', () => {
  assert.match(src, /async function reassignMembershipModal\(membershipId, siteId, targetId\)\s*\{/);
  const block = src.slice(src.indexOf('async function reassignMembershipModal'), src.indexOf('async function reassignLoadSites'));
  assert.match(block, /API\.del\('\/admin\/memberships\/' \+ m\.membership_id\)/);
  assert.match(block, /API\.post\('\/admin\/groups\/' \+ groupId \+ '\/users', \{ user_id: m\.user_id, role, all_sites: allSites, site_ids: siteIds \}\)/);
});

test('MODALE — correctif visuel : header/footer fixes, seul le corps défile — vérifiable au niveau CSS partagé (ui.js#showModal)', () => {
  const modalBlock = cssSrc.slice(cssSrc.indexOf('.modal{'), cssSrc.indexOf('.modal-footer{') + 250);
  assert.match(modalBlock, /\.modal\{[^}]*display:flex;flex-direction:column/s);
  assert.match(modalBlock, /\.modal-header\{[^}]*flex:0 0 auto/s);
  assert.match(modalBlock, /\.modal-body\{[^}]*flex:1 1 auto;overflow-y:auto;min-height:0/s);
  assert.match(modalBlock, /\.modal-footer\{[^}]*flex:0 0 auto/s);
  // La faute d'origine : overflow-y:auto posé sur .modal lui-même (faisait
  // défiler header+body+footer comme un seul bloc) — ne doit plus exister.
  const modalOwnRule = cssSrc.slice(cssSrc.indexOf('.modal{'), cssSrc.indexOf('.modal-header{'));
  assert.doesNotMatch(modalOwnRule, /overflow-y\s*:\s*auto/, '.modal lui-même ne doit plus défiler — seul .modal-body doit le faire');
});

test('le footer de la modale reste utilisable sur mobile étroit (390px) : les boutons peuvent s\'empiler/s\'étirer plutôt que déborder', () => {
  const block = cssSrc.slice(cssSrc.indexOf('.modal-footer{'), cssSrc.indexOf('.modal-footer{') + 500);
  assert.match(block, /flex-wrap\s*:\s*wrap/);
  assert.match(block, /@media\(max-width:420px\)\{/);
});

test('après Retirer/Réaffecter, les dépendances mises à jour restent VISIBLES à l\'administrateur même quand la modale d\'origine (refus) a été remplacée par "Gérer" — jamais juste un toast qui ne montre pas le "1 -> 0"', () => {
  assert.match(src, /async function showUpdatedDependenciesModal\(siteId\)\s*\{/);
  const archiveBlock = src.slice(src.indexOf('async function archiveMembershipAction'), src.indexOf('async function reassignMembershipModal'));
  assert.match(archiveBlock, /if \(document\.getElementById\(targetId\)\) await viewSiteMembershipDependencies\(siteId, targetId\);/);
  assert.match(archiveBlock, /else await showUpdatedDependenciesModal\(siteId\);/);
  const reassignBlock = src.slice(src.indexOf('async function reassignMembershipModal'), src.indexOf('async function reassignLoadSites'));
  assert.match(reassignBlock, /if \(document\.getElementById\(targetId\)\) await viewSiteMembershipDependencies\(siteId, targetId\);/);
  assert.match(reassignBlock, /else await showUpdatedDependenciesModal\(siteId\);/);
});
