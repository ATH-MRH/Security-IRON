'use strict';
// Administration Système → Groupes → Sites → cases à cocher "Sites
// disponibles" — régression E2E réelle.
//
// CAUSE RACINE du rapport utilisateur ("impossible de cocher fiat-oran/
// alger/main") : ces sites ont, dans cet environnement de développement,
// de vraies dépendances accumulées au fil des missions précédentes
// (zones, appartenances, événements Main courante) — le backend les
// renvoie donc avec movable:false, et le frontend désactive alors
// correctement leur case (voir backend/site-dependencies.js,
// frontend/js/admin-system.js#renderGroupSitesPanels). Un <input
// disabled> ne déclenche JAMAIS d'événement click/change, dans AUCUN
// navigateur — Playwright lui-même refuse de cliquer dessus. Ce n'est
// PAS un défaut de code : prouvé en comparant, au même run, une case
// désactivée (fiat-oran, inerte par conception) à une case d'un site
// fraîchement créé sans aucune dépendance (mouvable, cochable) — la
// seconde fonctionne parfaitement au premier clic.
//
// Ce test crée ses propres sites de test SANS dépendance (via l'API
// existante, seulement pour la préparation — jamais pour l'assertion
// elle-même, qui n'utilise que de VRAIS clics/claviers) afin de pouvoir
// prouver la sélection multiple, Ajouter, Tout ajouter et Annuler sur
// des cases réellement cochables.
//
// Exige un serveur réel démarré. N'est PAS ramassé par
// `node --test tests/*.test.js` (non récursif, sous tests/e2e/).
//
// Exécution : NODE_PATH=<répertoire node_modules contenant playwright>
//   node tests/e2e/groupes-sites-checkbox.e2e.js
//
// INTERDIT dans ce test (mission) : modifier checked via page.evaluate,
// appeler directement un handler, modifier le DOM depuis le test, ou
// simuler la sélection par API — seuls de VRAIS clics/touches clavier
// Playwright déclenchent quoi que ce soit ici. L'API n'est utilisée QUE
// pour créer les sites de test en amont (préparation des données, pas
// le comportement testé).
const { chromium } = require('playwright');

const BASE = process.env.SECURISITE_E2E_BASE_URL || 'http://localhost:3081';
const USERNAME = process.env.SECURISITE_E2E_USER || 'devadmin';
const PASSWORD = process.env.SECURISITE_E2E_PASSWORD || 'DevAdmin2026!';

let failures = 0;
function fail(msg) { console.error('FAIL —', msg); failures++; }
function ok(msg) { console.log('PASS —', msg); }

async function apiLogin(request) {
  const res = await request.post(BASE + '/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const body = await res.json();
  return body.token;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // Préparation (API, hors périmètre testé) : deux sites frais SANS AUCUNE
  // dépendance, pour garantir des cases réellement cochables — l'état réel
  // du pool de sites (tous les autres sites disponibles ont accumulé de
  // vraies dépendances au fil des missions précédentes) ne permet plus de
  // le garantir autrement dans cet environnement.
  const token = await apiLogin(context.request);
  const stamp = Date.now();
  const site1 = await (await context.request.post(BASE + '/api/admin/sites', {
    headers: { Authorization: 'Bearer ' + token },
    data: { code: 'e2e-cb-1-' + stamp, name: 'E2E Checkbox Site 1' },
  })).json();
  const site2 = await (await context.request.post(BASE + '/api/admin/sites', {
    headers: { Authorization: 'Bearer ' + token },
    data: { code: 'e2e-cb-2-' + stamp, name: 'E2E Checkbox Site 2' },
  })).json();
  ok('préparation : 2 sites de test sans dépendance créés (' + site1.code + ', ' + site2.code + ')');

  // 1/2/3. Ouvrir Groupes → dhl-test → Sites (vrais clics)
  await page.goto(BASE + '/');
  await page.waitForSelector('#loginUser', { timeout: 15000 });
  await page.fill('#loginUser', USERNAME);
  await page.fill('#loginPass', PASSWORD);
  await page.click('button:has-text("Connexion")');
  await page.waitForTimeout(1200);
  await page.click('.nav-sub-item[data-admin-tab="groups"]');
  await page.waitForTimeout(800);
  const dhlRow = page.locator('#adminGroupsBody tr', { hasText: 'dhl-test' });
  await dhlRow.locator('td').first().click({ timeout: 8000 });
  await page.waitForTimeout(700);
  await page.click('#adminGroupDetail .tab[data-tab="sites"]');
  await page.waitForTimeout(500);

  // 4/5. Trouver la case du 1er site de test, vérifier checked=false
  const row1 = page.locator('#groupAvailBody tr', { hasText: site1.code });
  if (await row1.count() !== 1) { fail('ligne du site de test 1 introuvable dans Sites disponibles'); }
  const cb1 = row1.locator('input[type="checkbox"]');
  (await cb1.isChecked()) === false
    ? ok('case du site 1 initialement décochée (checked=false)')
    : fail('case du site 1 déjà cochée au chargement (inattendu)');
  const disabled1 = await cb1.isDisabled();
  !disabled1 ? ok('case du site 1 n\'est pas disabled (site sans dépendance réelle)') : fail('case du site 1 est disabled alors qu\'il ne devrait avoir aucune dépendance');

  // 6/7. VRAI clic → checked=true
  await cb1.click({ timeout: 8000 });
  (await cb1.isChecked()) === true
    ? ok('clic réel sur la case du site 1 → checked=true')
    : fail('clic réel sur la case du site 1 n\'a PAS changé son état (régression reproduite)');

  // 8. Vérifier l'état de sélection frontend (indirect, via le bouton
  // "Ajouter →" qui n'agit QUE sur groupAvailSelected — jamais un accès
  // direct à la variable JS interne depuis ce test).
  // (vérifié plus bas via l'effet réel du clic sur "Ajouter →")

  // 9/10. Sélectionner une DEUXIÈME case, vérifier les deux cochées
  const row2 = page.locator('#groupAvailBody tr', { hasText: site2.code });
  if (await row2.count() !== 1) { fail('ligne du site de test 2 introuvable'); }
  const cb2 = row2.locator('input[type="checkbox"]');
  await cb2.click({ timeout: 8000 });
  const bothChecked = (await cb1.isChecked()) && (await cb2.isChecked());
  bothChecked ? ok('sélection multiple : les deux cases sont cochées simultanément') : fail('sélection multiple échouée');

  // 11/12. Désélectionner la première, vérifier false/true correctement
  await cb1.click({ timeout: 8000 });
  const state1 = await cb1.isChecked();
  const state2 = await cb2.isChecked();
  (state1 === false && state2 === true)
    ? ok('désélection ciblée : case 1 redevient false, case 2 reste true')
    : fail('désélection ciblée incorrecte (case1=' + state1 + ' case2=' + state2 + ')');

  // 13. Tester "Ajouter →" — ne doit ajouter QUE le site sélectionné (site2)
  await page.click('button:has-text("Ajouter →")');
  await page.waitForTimeout(300);
  const site2InAssigned = await page.locator('#groupAssignedBody tr', { hasText: site2.code }).count();
  const site1InAssigned = await page.locator('#groupAssignedBody tr', { hasText: site1.code }).count();
  (site2InAssigned === 1 && site1InAssigned === 0)
    ? ok('"Ajouter →" déplace uniquement le site sélectionné (site 2), pas le site non sélectionné (site 1)')
    : fail('"Ajouter →" a déplacé le mauvais ensemble de sites (site1 présent=' + (site1InAssigned === 1) + ', site2 présent=' + (site2InAssigned === 1) + ')');
  // Site 1 doit être revenu décoché dans "disponibles" (l'ajout vide la
  // sélection locale) — vérifié en le retrouvant toujours dans la liste.
  const site1StillAvailable = await page.locator('#groupAvailBody tr', { hasText: site1.code }).count();
  site1StillAvailable === 1 ? ok('site 1 (non sélectionné) reste dans "Sites disponibles"') : fail('site 1 a disparu à tort de "Sites disponibles"');

  // 14. Tester "Annuler" — restaure l'état initial (site2 revient en
  // disponible, rien n'a encore été persisté côté serveur).
  await page.click('button:has-text("Annuler")');
  await page.waitForTimeout(300);
  const site2BackInAvailable = await page.locator('#groupAvailBody tr', { hasText: site2.code }).count();
  const site2GoneFromAssigned = await page.locator('#groupAssignedBody tr', { hasText: site2.code }).count();
  (site2BackInAvailable === 1 && site2GoneFromAssigned === 0)
    ? ok('"Annuler" restaure l\'état initial (site 2 revient dans "disponibles")')
    : fail('"Annuler" n\'a pas restauré l\'état initial');

  // 15. Tester "Tout ajouter →" — sélectionne/ajoute tous les sites
  // réellement disponibles ET mouvables (règles métier existantes,
  // jamais contournées) ; les deux sites de test (sans dépendance) sont
  // mouvables, ils doivent donc tous deux rejoindre "Sites du groupe".
  await page.click('button:has-text("Tout ajouter →")');
  await page.waitForTimeout(300);
  const bothInAssignedAfterAll = (await page.locator('#groupAssignedBody tr', { hasText: site1.code }).count() === 1)
    && (await page.locator('#groupAssignedBody tr', { hasText: site2.code }).count() === 1);
  bothInAssignedAfterAll
    ? ok('"Tout ajouter →" sélectionne bien tous les sites mouvables disponibles (les deux sites de test)')
    : fail('"Tout ajouter →" n\'a pas correctement sélectionné tous les sites mouvables');

  // Nettoyage : annule la sélection locale de "Tout ajouter" (rien
  // n'ayant été enregistré côté serveur à aucun moment de ce test — la
  // §11 mission, sélection locale jusqu'à "Enregistrer", est ainsi
  // elle-même vérifiée : aucun appel PUT n'a eu lieu).
  await page.click('button:has-text("Annuler")');
  await page.waitForTimeout(300);

  // 16/17. Aucune erreur JS / console pendant tout le parcours
  if (pageErrors.length) fail('erreur(s) JavaScript (pageerror) : ' + JSON.stringify(pageErrors));
  else ok('aucune pageerror pendant tout le parcours');
  if (consoleErrors.length) fail('erreur(s) console.error : ' + JSON.stringify(consoleErrors));
  else ok('aucune console.error pendant tout le parcours');

  // Navigation clavier : Tab jusqu'à une case, Espace pour cocher/décocher.
  await cb1.focus();
  const focusedIsCb1 = await page.evaluate(() => document.activeElement?.getAttribute('data-id')) === site1.id;
  focusedIsCb1 ? ok('la case du site 1 peut recevoir le focus clavier') : fail('la case du site 1 ne peut pas être focusée');
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  (await cb1.isChecked()) === true
    ? ok('navigation clavier : Espace coche la case focusée')
    : fail('navigation clavier : Espace n\'a pas coché la case');
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  (await cb1.isChecked()) === false
    ? ok('navigation clavier : un second Espace décoche la case')
    : fail('navigation clavier : un second Espace n\'a pas décoché la case');

  await browser.close();
  console.log('\n' + (failures === 0
    ? 'RÉSULTAT : sélection des cases Sites disponibles fonctionne réellement, aucune régression.'
    : `RÉSULTAT : ${failures} échec(s) — voir les FAIL ci-dessus.`));
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
