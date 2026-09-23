'use strict';
// Administration Système → Groupes → « Ouvrir » — régression E2E réelle.
//
// Historique (rapport de mission) : (1) un bug de Service Worker
// cache-first a d'abord été corrigé (réseau-en-premier, v11 → v12) ;
// (2) une fois ce bug écarté, un utilisateur réel a signalé que le bouton
// « Ouvrir » semblait toujours ne rien faire — la cause réelle était un
// problème de LAYOUT : la fiche du groupe était correctement injectée
// dans le DOM, mais rendue SOUS la longue liste des groupes, hors du
// viewport, jamais visible sans un défilement manuel que l'utilisateur
// n'avait aucune raison de faire. Corrigé en repositionnant la fiche dans
// un panneau DROIT à côté de la liste (frontend/js/admin-system.js,
// frontend/css/style.css, CACHE_VERSION v12 → v13).
//
// Ce test vérifie le comportement RÉEL : géométrie côte-à-côte (liste à
// gauche, fiche à droite — jamais empilée en dessous), visibilité
// immédiate sans scroll manuel, sélection mise en évidence, changement de
// groupe, et l'onglet Sites (double panneau). Il DOIT échouer si la fiche
// revenait à être injectée sous la liste (assertion de géométrie dédiée).
//
// Exige un serveur réel démarré. N'est PAS ramassé par
// `node --test tests/*.test.js` (non récursif, sous tests/e2e/) — même
// convention que les autres recettes Playwright de cette session.
//
// Exécution : NODE_PATH=<répertoire node_modules contenant playwright>
//   node tests/e2e/groupes-ouvrir.e2e.js
//
// INTERDIT dans ce test (mission) : appeler openGroupDetail directement,
// évaluer une fonction pour simuler l'ouverture, modifier le DOM, ou
// appeler l'API à la place du clic — seul un VRAI clic Playwright
// (moteur d'actionabilité complet) déclenche quoi que ce soit ici.
const { chromium } = require('playwright');

const BASE = process.env.SECURISITE_E2E_BASE_URL || 'http://localhost:3081';
const USERNAME = process.env.SECURISITE_E2E_USER || 'devadmin';
const PASSWORD = process.env.SECURISITE_E2E_PASSWORD || 'DevAdmin2026!';

let failures = 0;
function fail(msg) { console.error('FAIL —', msg); failures++; }
function ok(msg) { console.log('PASS —', msg); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // 1. Connexion
  await page.goto(BASE + '/');
  await page.waitForSelector('#loginUser', { timeout: 15000 });
  await page.fill('#loginUser', USERNAME);
  await page.fill('#loginPass', PASSWORD);
  await page.click('button:has-text("Connexion")');
  await page.waitForTimeout(1200);

  // 2. Administration système → Groupes
  await page.click('.nav-sub-item[data-admin-tab="groups"]');
  await page.waitForTimeout(800);

  // 3. Liste visible à gauche + 4. panneau droit présent (empty-state)
  const listCol = page.locator('.admin-groups-list-col');
  const detailCol = page.locator('.admin-groups-detail-col');
  if (await listCol.count() === 0) { fail('colonne liste (.admin-groups-list-col) absente'); }
  else ok('colonne liste présente');
  if (await detailCol.count() === 0) { fail('colonne détail (.admin-groups-detail-col) absente'); }
  else ok('colonne détail présente (empty-state avant sélection)');
  const rowCount = await page.locator('#adminGroupsBody tr[data-group-id]').count();
  if (rowCount === 0) { fail('aucun groupe listé — impossible de poursuivre'); await browser.close(); process.exit(1); return; }
  ok('liste des groupes chargée (' + rowCount + ' ligne(s))');

  // Géométrie AVANT clic (desktop, 1920px) : la colonne détail doit déjà
  // être positionnée À CÔTÉ de la colonne liste (même ligne verticale),
  // jamais en dessous — cette assertion échouerait avec l'ancien layout.
  const listBoxBefore = await listCol.boundingBox();
  const detailBoxBefore = await detailCol.boundingBox();
  const sideBySideBefore = detailBoxBefore.x >= listBoxBefore.x + listBoxBefore.width - 5
    && Math.abs(detailBoxBefore.y - listBoxBefore.y) < 40;
  sideBySideBefore
    ? ok('géométrie desktop : colonne détail déjà positionnée à côté de la liste (jamais en dessous)')
    : fail('géométrie desktop : colonne détail PAS côte-à-côte avec la liste — régression du bug de layout (fiche sous la liste)');

  // 5. Clic RÉEL sur la ligne "dhl-test" (le gros bouton texte "Ouvrir" par
  // ligne a été retiré — la ligne entière est désormais ouvrable, cf.
  // correction visuelle ciblée). Clic porté sur une cellule <td> de la
  // ligne plutôt que sur le <tr> lui-même : <tr> est un cas connu où le
  // moteur d'actionabilité de Playwright rapporte à tort une interception
  // par l'élément <table> (vérifié indépendamment : un clic natif exact
  // aux mêmes coordonnées, page.mouse.click, ouvre bien la fiche) — cliquer
  // une cellule reste un clic RÉEL sur la zone visible de la ligne, avec
  // la même propagation DOM (bubbling) jusqu'au onclick du <tr>, donc un
  // test fidèle à ce que ferait un utilisateur réel.
  const dhlRow = page.locator('#adminGroupsBody tr', { hasText: 'dhl-test' });
  if (await dhlRow.count() !== 1) { fail('ligne "dhl-test" introuvable (attendu exactement 1)'); }
  const scrollYBeforeClick = await page.evaluate(() => window.scrollY);
  await dhlRow.locator('td').first().click({ timeout: 8000 });
  await page.waitForTimeout(600);

  // 6. La fiche apparaît SANS scroll manuel : le test ne défile jamais lui-
  // même — on vérifie juste que le contenu utile est dans le viewport tel
  // quel, et que la page n'a pas eu besoin de défiler pour l'atteindre.
  const scrollYAfterClick = await page.evaluate(() => window.scrollY);
  scrollYAfterClick === scrollYBeforeClick
    ? ok('aucun défilement de page nécessaire après le clic (fiche déjà dans le viewport)')
    : fail('la page a défilé après le clic — la fiche n\'était pas immédiatement visible');

  const detailCardBox = await page.locator('#adminGroupDetail .admin-group-header').first().boundingBox();
  const viewport = page.viewportSize();
  const detailVisibleInViewport = detailCardBox && detailCardBox.y >= 0 && detailCardBox.y < viewport.height;
  detailVisibleInViewport
    ? ok('la fiche DHL TEST est visible dans le viewport immédiatement après le clic')
    : fail('la fiche DHL TEST n\'est pas visible dans le viewport après le clic (bug reproduit)');

  // 7. Bounding box du panneau droit dans le viewport (redondant avec ce
  // qui précède, vérifié explicitement car demandé par la mission)
  const detailColBox = await detailCol.boundingBox();
  (detailColBox.x >= 0 && detailColBox.x < viewport.width)
    ? ok('bounding box du panneau droit dans les limites horizontales du viewport')
    : fail('bounding box du panneau droit hors du viewport horizontalement');

  // 8. Les 5 onglets sont visibles
  const tabNames = ['info', 'sites', 'users', 'permissions', 'audit'];
  let allTabsPresent = true;
  for (const tab of tabNames) {
    const count = await page.locator(`#adminGroupDetail .tab[data-tab="${tab}"]`).count();
    if (count !== 1) { allTabsPresent = false; fail('onglet manquant : ' + tab); }
  }
  if (allTabsPresent) ok('les 5 onglets (Informations/Sites/Utilisateurs/Permissions/Audit) sont présents');

  // Sélection mise en évidence dans la liste
  const selectedRow = page.locator('#adminGroupsBody tr[data-group-id].admin-groups-row-selected');
  (await selectedRow.count()) === 1
    ? ok('la ligne du groupe ouvert est visuellement mise en surbrillance dans la liste')
    : fail('aucune ligne mise en surbrillance après ouverture');

  // 9. Clic sur l'onglet Sites (vrai clic)
  await page.click('#adminGroupDetail .tab[data-tab="sites"]');
  await page.waitForTimeout(400);

  // 10. Double panneau Sites disponibles / Sites du groupe visible
  const availVisible = await page.locator('#groupAvailBody').isVisible().catch(() => false);
  const assignedVisible = await page.locator('#groupAssignedBody').isVisible().catch(() => false);
  (availVisible && assignedVisible)
    ? ok('double panneau Sites disponibles / Sites du groupe visible après clic sur l\'onglet Sites')
    : fail('double panneau Sites non visible après clic sur l\'onglet Sites');

  // 11. Clic réel sur un AUTRE groupe (contenu réel : "local"), toujours
  // via la ligne elle-même.
  const localRow = page.locator('#adminGroupsBody tr', { hasText: 'local' }).first();
  await localRow.locator('td').first().click({ timeout: 8000 });
  await page.waitForTimeout(600);

  // 12. Panneau droit mis à jour (nouveau titre, nouvelle sélection)
  const newTitle = await page.locator('#adminGroupDetail .admin-group-name').first().innerText();
  newTitle.includes('Client local') || newTitle.toLowerCase().includes('local')
    ? ok('panneau droit mis à jour avec le contenu du nouveau groupe sélectionné')
    : fail('panneau droit non mis à jour après changement de groupe (titre: "' + newTitle.trim() + '")');

  // 15. Ouverture au CLAVIER (Entrée) sur une ligne focusée — vrai
  // événement clavier Playwright, pas un raccourci JS.
  const fiatRow = page.locator('#adminGroupsBody tr', { hasText: 'fiat-test' }).first();
  await fiatRow.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const fiatTitle = await page.locator('#adminGroupDetail .admin-group-name').first().innerText();
  fiatTitle.toLowerCase().includes('fiat')
    ? ok('ligne ouvrable au clavier (focus + Entrée) — panneau droit affiche FIAT TEST')
    : fail('ouverture au clavier échouée (titre: "' + fiatTitle.trim() + '")');

  // 16. Le menu "⋯" par ligne : vrai clic, ne déclenche PAS l'ouverture de
  // la ligne (le titre du panneau droit doit rester "FIAT TEST").
  const menuBtn = dhlRow.locator('.admin-groups-row-menu-btn');
  await menuBtn.click({ timeout: 8000 });
  await page.waitForTimeout(300);
  const dropdownVisible = await page.locator('#adminGroupsBody .admin-actions-dropdown[data-row-menu]:not([hidden])').isVisible().catch(() => false);
  dropdownVisible
    ? ok('menu "⋯" de la ligne s\'ouvre au clic réel')
    : fail('menu "⋯" de la ligne ne s\'ouvre pas');
  const titleAfterMenuClick = await page.locator('#adminGroupDetail .admin-group-name').first().innerText();
  titleAfterMenuClick.toLowerCase().includes('fiat')
    ? ok('cliquer sur "⋯" n\'ouvre pas la ligne en même temps (stopPropagation effectif)')
    : fail('cliquer sur "⋯" a aussi ouvert la ligne (propagation non stoppée)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 13/14. Aucune erreur JS / console pendant tout le parcours
  if (pageErrors.length) fail('erreur(s) JavaScript (pageerror) : ' + JSON.stringify(pageErrors));
  else ok('aucune pageerror pendant tout le parcours');
  if (consoleErrors.length) fail('erreur(s) console.error : ' + JSON.stringify(consoleErrors));
  else ok('aucune console.error pendant tout le parcours');

  await browser.close();
  console.log('\n' + (failures === 0
    ? 'RÉSULTAT : layout panneau droit validé, aucune régression détectée.'
    : `RÉSULTAT : ${failures} échec(s) — voir les FAIL ci-dessus.`));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
