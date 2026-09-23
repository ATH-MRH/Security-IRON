'use strict';
// LOT GROUPES — Module « Groupes » + affectation des sites (frontend).
// Couverture statique (même convention que tests/frontend-admin-system.test.js) :
// comportement interactif complet vérifié en navigateur réel Playwright
// (rapport de mission), verrouillé ici au niveau source pour ne jamais
// revenir silencieusement. Groupe = tenant, Sites du groupe = sites.tenant_id,
// Utilisateur du groupe = memberships (backend/admin-groups.js) — jamais un
// second référentiel front, jamais une copie des sites OPS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../frontend/js/admin-system.js'), 'utf8');
const html = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');

test('sidebar : une entrée "Groupes" existe, positionnée entre Sites et Zones & postes', () => {
  const navBlock = html.slice(html.indexOf('id="adminNavSection"'), html.indexOf('</div>', html.indexOf('data-admin-tab="ai"')));
  const sitesIdx = navBlock.indexOf('data-admin-tab="sites"');
  const groupsIdx = navBlock.indexOf('data-admin-tab="groups"');
  const zonesIdx = navBlock.indexOf('data-admin-tab="zones"');
  assert.ok(sitesIdx !== -1 && groupsIdx !== -1 && zonesIdx !== -1, 'les trois entrées doivent exister');
  assert.ok(sitesIdx < groupsIdx && groupsIdx < zonesIdx, 'ordre attendu : Sites → Groupes → Zones & postes');
  assert.match(navBlock.slice(groupsIdx - 80, groupsIdx + 80), /<span>Groupes<\/span>/);
});

test('showTab : l\'onglet "groups" est bien routé vers renderGroups, jamais un onglet mort', () => {
  assert.match(src, /groups:\s*renderGroups/);
  assert.match(src, /\['groups', 'Groupes', 'المجموعات'\]/);
});

test('renderGroups : liste avec recherche, pills de filtre de statut et bouton "+ Nouveau groupe" — jamais une donnée fictive', () => {
  const block = src.slice(src.indexOf('async function renderGroups'), src.indexOf('async function reloadGroups'));
  assert.match(block, /oninput="AdminSystem\.reloadGroups\(\)"/);
  assert.match(block, /id="adminGroupsFilterPills"/);
  assert.match(block, /onclick="AdminSystem\.openGroupWizard\(\)"/);
  for (const col of ['Code', 'Nom', 'Sites', 'Utilisateurs', 'Statut', 'Actions']) {
    assert.match(block, new RegExp(col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('les pills de filtre (Tous/Actifs/Inactifs/Archivés) affichent un compteur réel par statut et filtrent côté client, sans requête serveur supplémentaire', () => {
  const block = src.slice(src.indexOf('function renderGroupsTable'), src.indexOf('function highlightSelectedGroupRow'));
  assert.match(block, /groupsCache\.forEach\(g => \{ counts\[g\.status\] = \(counts\[g\.status\] \|\| 0\) \+ 1; \}\)/);
  assert.match(block, /AdminSystem\.setGroupsStatusFilter/);
  assert.match(block, /const visible = groupsStatusFilter \? groupsCache\.filter/);
});

test('reloadGroups : appelle le vrai endpoint /admin/groups avec search/status/limit, jamais des groupes inventés', () => {
  const block = src.slice(src.indexOf('async function reloadGroups'), src.indexOf('function renderGroupsTable'));
  assert.match(block, /API\.get\('\/admin\/groups\?' \+ qs\.toString\(\)\)/);
});

test('la table des groupes affiche un empty-state explicite quand la liste (éventuellement filtrée par pill) est vide, jamais une table silencieusement blanche', () => {
  assert.match(src, /if \(!visible\.length\) \{ body\.innerHTML = `<tr><td colspan="6" class="empty-state">\$\{t\('Aucun groupe'/);
});

test('openGroupWizard : Code et Nom sont requis côté backend (POST /admin/groups), jamais un formulaire local seul', () => {
  const block = src.slice(src.indexOf('function openGroupWizard'), src.indexOf('async function openGroupDetail(id, initialTab)'));
  assert.match(block, /API\.post\('\/admin\/groups', \{/);
  assert.match(block, /code: document\.getElementById\('wizGroupCode'\)\.value\.trim\(\)/);
  assert.match(block, /name: document\.getElementById\('wizGroupName'\)\.value\.trim\(\)/);
});

test('openGroupDetail : charge groupe + sites du groupe + sites disponibles + utilisateurs en une seule fois (Promise.all), jamais un référentiel parallèle', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function switchGroupTab'));
  assert.match(block, /API\.get\('\/admin\/groups\/' \+ id\)/);
  assert.match(block, /API\.get\('\/admin\/groups\/' \+ id \+ '\/sites'\)/);
  assert.match(block, /API\.get\('\/admin\/groups\/' \+ id \+ '\/sites\/available'\)/);
  assert.match(block, /API\.get\('\/admin\/groups\/' \+ id \+ '\/users'\)/);
});

test('fiche groupe : 5 onglets réels (Informations, Sites, Utilisateurs, Permissions, Audit)', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function switchGroupTab') + 600);
  for (const tabId of ['info', 'sites', 'users', 'permissions', 'audit']) {
    assert.match(block, new RegExp(`data-tab="${tabId}"`));
  }
});

/* ============================================================ */
/*  Onglet Sites — double panneau, sélection locale (§11 mission) */
/* ============================================================ */
test('le panneau Sites ne persiste rien au clic : une sélection LOCALE (groupAssignedIds) est enregistrée seulement via saveGroupSites()', () => {
  assert.match(src, /let groupAssignedIds = new Set\(\);/);
  assert.match(src, /function addSelectedGroupSites\(\)/);
  assert.match(src, /function removeGroupSite\(id\)/);
  const saveBlock = src.slice(src.indexOf('async function saveGroupSites'), src.indexOf('function cancelGroupSitesChanges'));
  assert.match(saveBlock, /API\.put\('\/admin\/groups\/' \+ currentGroupId \+ '\/sites', \{ add, remove \}\)/);
});

test('le panneau Sites disponibles / Sites du groupe offre Ajouter, Tout ajouter, Retirer, Tout retirer et recherche', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesTabShell'), src.indexOf('function renderGroupSitesPanels'));
  assert.match(block, /AdminSystem\.addSelectedGroupSites\(\)/);
  assert.match(block, /AdminSystem\.addAllGroupSites\(\)/);
  assert.match(block, /AdminSystem\.removeAllGroupSites\(\)/);
  assert.match(block, /id="groupSiteAvailSearch"/);
  assert.match(block, /AdminSystem\.saveGroupSites\(\)/);
  assert.match(block, /AdminSystem\.cancelGroupSitesChanges\(\)/);
});

test('un site non déplaçable (dépendances réelles) est visuellement signalé et sa case est désactivée — jamais un échec découvert après coup', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesPanels'), src.indexOf('function toggleGroupAvailSelected'));
  assert.match(block, /\$\{s\.movable === false \? 'disabled' : ''\}/);
  assert.match(block, /Non déplaçable : des données réelles y sont rattachées/);
});

test('multi-sélection : addAllGroupSites ignore les sites non déplaçables et respecte le filtre de recherche courant', () => {
  const block = src.slice(src.indexOf('function addAllGroupSites'), src.indexOf('function affectedRestrictedUsers'));
  assert.match(block, /if \(s\.movable === false \|\| !matches\(s\)\) return;/);
});

test('§12 mission : retirer un site avec des utilisateurs restreints affiche un avertissement chiffré AVANT toute confirmation', () => {
  const block = src.slice(src.indexOf('function affectedRestrictedUsers'), src.indexOf('function removeAllGroupSites'));
  assert.match(block, /affectedRestrictedUsers\(id\)/);
  assert.match(block, /utilisateur\(s\) restreint\(s\) du groupe/);
  // Honnêteté : les appartenances sont immuables (voir backend) — jamais une
  // promesse de nettoyage automatique des accès que le backend ne tient pas.
  assert.match(block, /jamais supprimées automatiquement/);
});

test('la sélection groupée "Tout retirer" agrège le nombre réel d\'utilisateurs affectés sur tous les sites concernés, jamais un total inventé', () => {
  const block = src.slice(src.indexOf('function removeAllGroupSites'), src.indexOf('async function saveGroupSites'));
  assert.match(block, /ids\.reduce\(\(sum, id\) => sum \+ affectedRestrictedUsers\(id\), 0\)/);
});

/* ============================================================ */
/*  Onglet Utilisateurs                                           */
/* ============================================================ */
test('l\'onglet Utilisateurs affecte un compte EXISTANT uniquement (POST /admin/groups/:id/users), jamais une création de compte', () => {
  const block = src.slice(src.indexOf('async function openAssignGroupUserModal'), src.indexOf('function renderGroupPermissionsTab'));
  assert.match(block, /API\.get\('\/admin\/users'\)/);
  assert.match(block, /API\.post\('\/admin\/groups\/' \+ currentGroupId \+ '\/users'/);
  assert.doesNotMatch(block, /API\.post\('\/admin\/users'/, 'jamais un POST /admin/users (création de compte) depuis cette modale');
});

test('la modale d\'affectation ne propose QUE les sites RÉELLEMENT persistés de ce groupe — jamais les sites d\'un autre groupe (ex: FIAT visible pour un utilisateur DHL)', () => {
  const block = src.slice(src.indexOf('async function openAssignGroupUserModal'), src.indexOf('function renderGroupPermissionsTab'));
  assert.match(block, /groupOriginalAssignedIds\]\.map\(id => groupSiteById\.get\(id\)\)/);
  assert.doesNotMatch(block, /sites\/available/, 'la liste des sites cochables dans cette modale ne doit jamais venir du pool "disponibles" (autres groupes)');
});

test('"Tous les sites du groupe" ou au moins un site explicite est requis avant l\'appel API, jamais un envoi vide', () => {
  const block = src.slice(src.indexOf('async function openAssignGroupUserModal'), src.indexOf('function renderGroupPermissionsTab'));
  assert.match(block, /if \(!allSites && !siteIds\.length\) \{ notify\(/);
});

test('retirer un utilisateur du groupe archive ses appartenances (DELETE), jamais une suppression silencieuse sans confirmation', () => {
  const block = src.slice(src.indexOf('function confirmRemoveGroupUser'), src.indexOf('async function openAssignGroupUserModal'));
  assert.match(block, /API\.del\('\/admin\/groups\/' \+ currentGroupId \+ '\/users\/' \+ userId\)/);
  assert.match(block, /archivées \(jamais supprimées/);
});

/* ============================================================ */
/*  Onglet Permissions — périmètre séparé du RBAC existant         */
/* ============================================================ */
test('l\'onglet Permissions réutilise le référentiel Rôles & permissions existant — aucune seconde matrice RBAC recréée ici', () => {
  const block = src.slice(src.indexOf('function renderGroupPermissionsTab'), src.indexOf('async function loadGroupAudit'));
  assert.match(block, /AdminSystem\.showTab\('roles'\)/);
  assert.doesNotMatch(block, /API\.get\('\/admin\/roles'\)/, 'ne doit pas re-fetcher/recréer la matrice de permissions ici — un lien renvoie vers Rôles & permissions');
});

/* ============================================================ */
/*  Onglet Audit — réutilise security_audit, jamais un journal     */
/*  parallèle                                                      */
/* ============================================================ */
test('l\'onglet Audit appelle GET /admin/groups/:id/audit (security_audit réel), jamais des événements fabriqués', () => {
  const block = src.slice(src.indexOf('async function loadGroupAudit'), src.indexOf('/* ==', src.indexOf('async function loadGroupAudit') + 50));
  assert.match(block, /API\.get\('\/admin\/groups\/' \+ currentGroupId \+ '\/audit\?limit=100'\)/);
  assert.match(block, /Aucun événement/);
});

/* ============================================================ */
/*  Erreurs API / chargement — jamais un plantage silencieux       */
/* ============================================================ */
test('les actions Groupes gèrent l\'échec API avec le message réel du backend (jamais une erreur générique inventée)', () => {
  const catchCount = (src.match(/catch \(e\) \{ notify\(e\.message \|\| 'Erreur', 'error'\); \}/g) || []).length;
  assert.ok(catchCount >= 8, 'la plupart des actions Groupes (créer, sauvegarder, statut, sites, utilisateurs) doivent surfacer l\'erreur réelle');
});

test('un état de chargement explicite est affiché pendant le chargement de l\'audit du groupe', () => {
  const block = src.slice(src.indexOf('async function loadGroupAudit'), src.indexOf('/* ==', src.indexOf('async function loadGroupAudit') + 50));
  assert.match(block, /Chargement…/);
});

/* ============================================================ */
/*  FR/AR/RTL — toutes les nouvelles chaînes Groupes sont           */
/*  bilingues via t(fr, ar), jamais un mélange FR/AR non maîtrisé  */
/* ============================================================ */
test('les chaînes obligatoires du LOT GROUPES (§20 mission) sont toutes bilingues via t(fr, ar)', () => {
  const pairs = [
    ["t('Groupes', 'المجموعات')", true],
    ["t('Nouveau groupe', 'مجموعة جديدة')", true],
    ["t('Sites disponibles', 'المواقع المتاحة')", true],
    ["t('Sites du groupe', 'مواقع المجموعة')", true],
    ["t('Utilisateurs', 'المستخدمون')", true],
    ["t('Permissions', 'الصلاحيات')", true],
    ["t('Audit', 'التدقيق')", true],
    ["t('Tout ajouter →', 'إضافة الكل ←')", true],
    ["t('Tout retirer', 'إزالة الكل')", true],
    ["t('Enregistrer les modifications', 'حفظ التغييرات')", true],
    ["t('Annuler', 'إلغاء')", true],
    ["t('Actif', 'نشط')", true],
    ["t('Archivé', 'مؤرشف')", true],
  ];
  for (const [needle] of pairs) {
    assert.ok(src.includes(needle), `chaîne bilingue manquante ou modifiée : ${needle}`);
  }
});

test('le libellé de sidebar "Groupes" est lui aussi bilingue (entrée TABS)', () => {
  assert.match(src, /\['groups', 'Groupes', 'المجموعات'\]/);
});

test('le texte statique de la sidebar (index.html) "Groupes" est traduit dans I18N_AR (frontend/js/ui.js) — sinon il reste en français même en mode AR (bug réel constaté à la recette Playwright)', () => {
  const uiSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');
  assert.match(uiSrc, /'Groupes':\s*'المجموعات'/);
});

/* ============================================================ */
/*  Responsive — le double panneau se réduit en colonnes verticales*/
/*  (flex-wrap) sous le seuil mobile, jamais de scroll horizontal  */
/*  global                                                          */
/* ============================================================ */
test('le double panneau Sites disponibles / Sites du groupe utilise flex-wrap (colonnes verticales en mobile), jamais une largeur figée', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesTabShell'), src.indexOf('function renderGroupSitesPanels'));
  assert.match(block, /display:flex;gap:16px;flex-wrap:wrap/);
  assert.match(block, /min-width:280px/);
});

test('les tableaux de la fiche groupe restent dans des conteneurs .table-wrap (scroll horizontal contenu, jamais la page entière)', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesTabShell'), src.indexOf('function renderGroupUsersTable') + 400);
  assert.match(block, /class="table-wrap"/);
});

test('sw.js : CACHE_VERSION a bien été incrémenté depuis le LOT GROUPES (v11…v18, puis v19 mission TOPBAR COMPACTE)', () => {
  const swSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/sw.js'), 'utf8');
  assert.match(swSrc, /const CACHE_VERSION = 'securisite-shell-v19';/);
});

/* ============================================================ */
/*  CORRECTION CIBLÉE — cases à cocher "Sites disponibles"         */
/*  Cause racine : les checkboxes desactivées (movable:false, vraies */
/*  dépendances backend) sont correctement inertes — un <input        */
/*  disabled> ne reçoit jamais aucun événement, dans aucun navigateur.*/
/*  Aucun défaut dans toggleGroupAvailSelected ni le re-render.       */
/* ============================================================ */
test('.group-avail-check a une zone cliquable/tactile agrandie (17px, accent-color, focus-visible) sans toucher au layout du double panneau', () => {
  const cssSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');
  const block = cssSrc.slice(cssSrc.indexOf('.group-avail-check{'), cssSrc.indexOf('.group-avail-check{') + 400);
  assert.match(block, /width:17px;height:17px/);
  assert.match(block, /cursor:pointer/);
  assert.match(cssSrc, /\.group-avail-check:focus-visible\{/);
});

test('toggleGroupAvailSelected ne fait QUE gérer groupAvailSelected (add/delete) — aucune logique de re-render qui écraserait la sélection en cours', () => {
  const block = src.slice(src.indexOf('function toggleGroupAvailSelected'), src.indexOf('function toggleGroupAvailSelected') + 200);
  assert.match(block, /if \(checked\) groupAvailSelected\.add\(id\); else groupAvailSelected\.delete\(id\);/);
});

test('un site non mouvable (movable:false) reste rendu avec sa case disabled — comportement intentionnel documenté, pas un défaut à corriger', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesPanels'), src.indexOf('function toggleGroupAvailSelected'));
  assert.match(block, /\$\{s\.movable === false \? 'disabled' : ''\}/);
});

/* ============================================================ */
/*  CORRECTION VISUELLE — colonne liste lisible, ligne ouvrable,   */
/*  menu "⋯" compact (remplace le gros bouton "Ouvrir" par ligne)  */
/* ============================================================ */
test('la colonne liste passe à 40% (plus de colonnes "artificiellement minuscules") — plus de gros bouton "Ouvrir" par ligne', () => {
  const cssSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');
  assert.match(cssSrc, /\.admin-groups-list-col\{flex:0 0 40%/);
  const block = src.slice(src.indexOf('function renderGroupsTable'), src.indexOf('function renderGroupRowMenu'));
  assert.doesNotMatch(block, /btn btn-sm btn-outline" onclick="AdminSystem\.openGroupDetail/, 'le bouton texte "Ouvrir" par ligne doit avoir disparu, remplacé par la ligne cliquable + le menu ⋯');
});

test('chaque ligne du tableau est ouvrable au clic ET au clavier (Entrée/Espace), avec aria-selected — jamais role="button" sur un <tr> (sémantique de table préservée)', () => {
  const block = src.slice(src.indexOf('function renderGroupsTable'), src.indexOf('function renderGroupRowMenu'));
  assert.match(block, /class="admin-groups-row-clickable/);
  assert.match(block, /tabindex="0"/);
  assert.match(block, /onclick="AdminSystem\.openGroupDetail\('\$\{g\.id\}'\)"/);
  assert.match(block, /onkeydown="AdminSystem\.groupRowKeydown\(event,'\$\{g\.id\}'\)"/);
  assert.doesNotMatch(block, /role="button"/, 'un <tr> ne doit pas usurper role="button" — casse la sémantique de table pour un lecteur d\'écran');
});

test('le menu "⋯" par ligne stoppe sa propre propagation — ne déclenche jamais l\'ouverture de la ligne en même temps que son menu', () => {
  const block = src.slice(src.indexOf('function renderGroupRowMenu'), src.indexOf('function toggleGroupRowMenu'));
  assert.match(block, /admin-groups-row-menu-btn/);
  assert.match(block, /aria-haspopup="true"/);
  assert.match(block, /aria-label="\$\{escapeHtml\(t\('Actions pour'/);
  assert.match(block, /event\.stopPropagation\(\); AdminSystem\.toggleGroupRowMenu/);
  assert.match(block, /data-row-menu="\$\{g\.id\}" onclick="event\.stopPropagation\(\)"/);
});

test('le menu "⋯" par ligne réutilise Ouvrir/Modifier/Activer-Désactiver/Archiver déjà existants — aucune nouvelle logique métier', () => {
  const block = src.slice(src.indexOf('function renderGroupRowMenu'), src.indexOf('function toggleGroupRowMenu'));
  assert.match(block, /AdminSystem\.openGroupDetail\('\$\{g\.id\}'\)/);
  assert.match(block, /AdminSystem\.openGroupDetailAndEdit\('\$\{g\.id\}'\)/);
  assert.match(block, /AdminSystem\.setGroupStatus\('\$\{g\.id\}','active'\)/);
  assert.match(block, /AdminSystem\.setGroupStatus\('\$\{g\.id\}','suspended'\)/);
  assert.match(block, /AdminSystem\.setGroupStatus\('\$\{g\.id\}','archived'\)/);
  const editBlock = src.slice(src.indexOf('async function openGroupDetailAndEdit'), src.indexOf('function highlightSelectedGroupRow'));
  assert.match(editBlock, /await openGroupDetail\(id\);/);
  assert.match(editBlock, /toggleGroupEditMode\(\);/);
});

test('un seul menu de ligne ouvert à la fois ; Échap et un clic extérieur ferment tous les menus de ligne', () => {
  const block = src.slice(src.indexOf('function toggleGroupRowMenu'), src.indexOf('function groupRowKeydown'));
  assert.match(block, /dd\.dataset\.rowMenu !== id/);
  assert.match(block, /function closeAllGroupRowMenus/);
  assert.match(block, /if \(e\.key === 'Escape'\) closeAllGroupRowMenus\(\);/);
});

/* ============================================================ */
/*  Responsive — le tableau de la liste des groupes tient TOUJOURS */
/*  dans sa colonne (table-layout:fixed), jamais un débordement    */
/*  horizontal interne qui pousse la colonne Code hors-vue          */
/* ============================================================ */
test('.admin-groups-table utilise table-layout:fixed + largeurs en % — le tableau ne peut plus dépasser sa colonne, quelle que soit la largeur d\'écran', () => {
  const cssSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');
  const block = cssSrc.slice(cssSrc.indexOf('.admin-groups-table{'), cssSrc.indexOf('.admin-groups-empty-state{'));
  assert.match(block, /table-layout:fixed/);
  assert.match(block, /width:100%/);
  assert.match(block, /text-overflow:ellipsis/);
});

test('les colonnes Code et Nom exposent la valeur complète via title="…" même quand le texte est tronqué par ellipsis', () => {
  const block = src.slice(src.indexOf('function renderGroupsTable'), src.indexOf('function highlightSelectedGroupRow'));
  assert.match(block, /<strong title="\$\{escapeHtml\(g\.code\)\}">/);
  assert.match(block, /<td title="\$\{escapeHtml\(g\.name\)\}">/);
});

/* ============================================================ */
/*  MISSION — Alignement visuel strict sur la maquette validée     */
/* ============================================================ */
test('bloc visuel unique (.admin-groups-shell) — jamais deux .card génériques posées côte à côte', () => {
  const block = src.slice(src.indexOf('async function renderGroups'), src.indexOf('async function reloadGroups'));
  assert.match(block, /class="admin-groups-shell"/);
  assert.doesNotMatch(block, /class="card"/, 'la liste et le panneau détail ne doivent plus être deux .card indépendantes');
  assert.match(block, /class="admin-groups-page-title"/);
});

test('header de fiche : avatar déterministe + identité + méta (code/créé/modifié), jamais juste "Nom (code) Statut"', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function closeGroupDetail'));
  assert.match(block, /class="admin-group-avatar"/);
  assert.match(block, /groupAvatarColor\(group\.code\)/);
  assert.match(block, /groupAvatarText\(group\.code\)/);
  assert.match(block, /admin-group-header-meta/);
  assert.match(block, /Créé le/);
  assert.match(block, /Modifié le/);
});

test('header de fiche : actions séparées — Modifier / Plus d\'actions (menu) / Fermer discret en icône — jamais un bouton Fermer dominant', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function closeGroupDetail'));
  assert.match(block, /onclick="AdminSystem\.toggleGroupEditMode\(\)"/);
  assert.match(block, /class="admin-actions-menu"/);
  assert.match(block, /onclick="AdminSystem\.toggleGroupActionsMenu\(\)"/);
  assert.match(block, /class="btn-icon admin-groups-close-icon"/);
});

test('le menu "Plus d\'actions" se ferme au clic extérieur et à Échap (même pattern que le menu langue existant, app.js#toggleLangMenu)', () => {
  assert.match(src, /document\.addEventListener\('click', e => \{\s*const menu = document\.getElementById\('groupActionsMenuBtn'\)/);
  assert.match(src, /document\.addEventListener\('keydown', e => \{ if \(e\.key === 'Escape'\) closeGroupActionsMenu\(\); \}\)/);
});

test('les onglets affichent un compteur réel (Sites (n) / Utilisateurs (n)), jamais un chiffre inventé', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function closeGroupDetail'));
  assert.match(block, /data-tab="sites"[^>]*>\$\{t\('Sites', 'المواقع'\)\} \(\$\{sitesRes\.sites\.length\}\)/);
  assert.match(block, /data-tab="users"[^>]*>\$\{t\('Utilisateurs', 'المستخدمون'\)\} \(\$\{usersRes\.users\.length\}\)/);
});

test('onglet Informations : consultation par défaut (aucun input), "Modifier" (header) bascule vers l\'édition avec Enregistrer/Annuler', () => {
  const readBlock = src.slice(src.indexOf('function renderGroupInfoTab'), src.indexOf('function toggleGroupEditMode'));
  assert.doesNotMatch(readBlock.split('return `')[1].split('`;')[0], /<input/, 'le mode consultation ne doit afficher aucun champ input');
  assert.match(src, /function toggleGroupEditMode\(\) \{/);
  assert.match(src, /groupInfoEditMode = true;/);
  assert.match(src, /function cancelGroupInfoEdit\(\) \{/);
});

test('onglet Sites : bandeau explicatif présent, panneaux intitulés et "Tout retirer" replacé dans l\'en-tête du panneau droit', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesTabShell'), src.indexOf('function renderGroupSitesPanels'));
  assert.match(block, /admin-groups-sites-banner/);
  assert.match(block, /Sélectionnez les sites qui font partie de ce groupe/);
  assert.match(block, /admin-groups-sites-panel-header/);
});

test('onglet Sites : le retrait d\'un site utilise un bouton icône (🗑) accessible (title + aria-label), jamais un bouton texte "Retirer" nu', () => {
  const block = src.slice(src.indexOf('function renderGroupSitesPanels'), src.indexOf('function toggleGroupAvailSelected'));
  assert.match(block, /class="admin-groups-icon-btn"/);
  assert.match(block, /aria-label="\$\{escapeHtml\(t\('Retirer'/);
});

test('renderGroups : structure deux colonnes (liste + panneau droit), jamais la fiche injectée sous la liste', () => {
  const block = src.slice(src.indexOf('async function renderGroups'), src.indexOf('async function reloadGroups'));
  assert.match(block, /class="admin-groups-layout"/);
  assert.match(block, /class="admin-groups-list-col"/);
  assert.match(block, /class="admin-groups-detail-col"/);
  // adminGroupDetail doit être un ENFANT de la colonne droite (même bloc de
  // template), jamais un frère placé après la carte liste comme avant.
  assert.match(block, /admin-groups-detail-col">\s*<div id="adminGroupDetail">/);
});

test('openGroupDetail : surbrillance de sélection + activation du mode "fiche visible" (mobile) au clic réel sur Ouvrir', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function closeGroupDetail'));
  assert.match(block, /highlightSelectedGroupRow\(id\)/);
  assert.match(block, /adminGroupsLayout'\)\?\.classList\.add\('admin-groups-showing-detail'\)/);
});

test('closeGroupDetail (Fermer / ← Retour aux groupes) : ré-affiche l\'empty-state et repasse en mode liste sur mobile', () => {
  const block = src.slice(src.indexOf('function closeGroupDetail'), src.indexOf('function switchGroupTab'));
  assert.match(block, /groupDetailEmptyStateHtml\(\)/);
  assert.match(block, /admin-groups-showing-detail'\)/);
});

test('accessibilité : les boutons Groupes déclarent type="button" (jamais le "submit" implicite)', () => {
  const block = src.slice(src.indexOf('async function renderGroups'), src.indexOf('async function loadGroupAudit') + 500);
  assert.doesNotMatch(block, /<button class=/, 'tout <button> du bloc Groupes doit porter type="button" explicitement');
});

test('accessibilité : les onglets Groupes portent role="tab"/aria-selected et une navigation clavier réelle (flèches/Entrée/Espace)', () => {
  const block = src.slice(src.indexOf('async function openGroupDetail(id, initialTab)'), src.indexOf('function closeGroupDetail'));
  assert.match(block, /role="tablist"/);
  assert.match(block, /role="tab"/);
  assert.match(block, /aria-selected="true"/);
  assert.match(block, /onkeydown="AdminSystem\.groupTabKeydown/);
  const kbBlock = src.slice(src.indexOf('function groupTabKeydown'), src.indexOf('function groupTabKeydown') + 900);
  assert.match(kbBlock, /ArrowRight/);
  assert.match(kbBlock, /ArrowLeft/);
});
