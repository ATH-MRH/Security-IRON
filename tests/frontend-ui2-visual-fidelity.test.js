'use strict';
// Regression guard for the SécuriSite UI 2.0 visual-fidelity correction
// pass: a first redesign attempt was rejected for (1) offering a bilingual
// FR+AR default that showed both languages at once instead of exactly one,
// (2) an outline/contour SOS button instead of a solid filled circle, (3) a
// duplicated KPI row under the new one, and (4) a dashboard whose header +
// hero + 4-KPI row + two 3-panel rows did not fit a 16:9 screen without
// heavy scrolling. These tests pin down the structural/CSS facts that make
// each of those regressions impossible to reintroduce silently.
//
// No browser/DOM available in this suite: ui.js is a plain script, loaded
// into a vm context the same way tests/frontend-i18n-arabic.test.js does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const uiSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');

function loadUi() {
  const context = vm.createContext({});
  new vm.Script(uiSource, { filename: 'ui.js' }).runInContext(context);
  const get = expr => new vm.Script(expr).runInContext(context);
  return {
    I18N_AR: JSON.parse(JSON.stringify(get('I18N_AR'))),
    translateText: (text, lang) => get(`translateText(${JSON.stringify(text)}, ${JSON.stringify(lang)})`),
  };
}

const dashboardHtml = htmlSource.slice(
  htmlSource.indexOf('id="page-dashboard"'),
  htmlSource.indexOf('<!-- CARTE', htmlSource.indexOf('id="page-dashboard"')) === -1
    ? htmlSource.indexOf('id="page-dashboard"') + 20000
    : htmlSource.length
);

/* ============================================================ */
/*  Une seule langue affichée à la fois — jamais FR+AR ensemble  */
/* ============================================================ */

test('the language switchers (login + topbar) only offer French or Arabic, never a combined FR+AR option', () => {
  const loginOverlay = htmlSource.slice(htmlSource.indexOf('id="loginOverlay"'), htmlSource.indexOf('<!-- ===== App'));
  const topbar = htmlSource.slice(htmlSource.indexOf('class="topbar-right"'), htmlSource.indexOf('class="content"'));
  for (const block of [loginOverlay, topbar]) {
    assert.match(block, /<option value="fr">/);
    assert.match(block, /<option value="ar">/);
    assert.doesNotMatch(block, /<option value="fr-ar">/, 'no combined FR+AR option may be offered to the user');
  }
});

test('applyLanguage() silently migrates a previously-persisted bilingual setting to French-only (never re-shows both languages)', () => {
  const documentElement = { lang: '', dir: '' };
  const store = { securisite_lang: 'fr-ar' };
  const localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  const document = { documentElement, querySelectorAll: () => [] };
  const context = vm.createContext({ document, localStorage, Node: { TEXT_NODE: 3 } });
  new vm.Script(uiSource, { filename: 'ui.js' }).runInContext(context);
  new vm.Script('applyLanguage()').runInContext(context);
  assert.equal(store.securisite_lang, 'fr', 'a stale fr-ar preference must be migrated to fr, not preserved');
  assert.equal(documentElement.lang, 'fr');
  assert.equal(documentElement.dir, 'ltr');
});

test('a single DOM text node never renders both languages at once for a translated string', () => {
  const { translateText } = loadUi();
  assert.equal(translateText('Tableau de bord', 'fr'), 'Tableau de bord');
  assert.equal(translateText('Tableau de bord', 'ar'), 'لوحة التحكم');
  assert.doesNotMatch(translateText('Tableau de bord', 'ar'), /Tableau de bord/, 'ar mode must show Arabic only, no French left alongside it');
  assert.doesNotMatch(translateText('Tableau de bord', 'fr'), /لوحة التحكم/, 'fr mode must show French only, no Arabic left alongside it');
});

/* ============================================================ */
/*  SOS : cercle plein rouge, jamais un simple contour            */
/* ============================================================ */

test('the SOS button is a solid filled red circle, not an outline/contour style', () => {
  const start = cssSource.search(/^\.sos-button\{/m);
  assert.notEqual(start, -1, '.sos-button base rule must exist (not only nested/descendant selectors)');
  const sosRule = cssSource.slice(start, cssSource.indexOf('}', start) + 1);
  assert.match(sosRule, /background:var\(--danger\)/, 'SOS must be filled with the danger color, not just outlined');
  assert.doesNotMatch(sosRule, /background:var\(--surface\)/, 'SOS must not render as a hollow/outline button');
});

test('the hero SOS button and the topbar SOS button both use the same solid .sos-button styling', () => {
  const topbar = htmlSource.slice(htmlSource.indexOf('class="topbar-right"'), htmlSource.indexOf('class="content"'));
  assert.match(topbar, /class="sos-button sos-trigger"/);
  assert.match(dashboardHtml, /class="sos-button sos-trigger ui2-hero-sos"/, 'the hero SOS variant must still carry the base solid .sos-button class');
});

/* ============================================================ */
/*  Exactement UNE rangée de 4 cartes KPI sous le hero            */
/* ============================================================ */

test('exactly one 4-card KPI row sits directly under the hero (no duplicate row)', () => {
  const heroEnd = dashboardHtml.indexOf('</div>', dashboardHtml.indexOf('id="cleanHeroStatus"'));
  const afterHero = dashboardHtml.slice(dashboardHtml.indexOf('class="kpi-grid ui2-kpi-grid"'));
  const firstGrid3 = afterHero.indexOf('class="ui2-grid-3"');
  const kpiRowBlock = afterHero.slice(0, firstGrid3 === -1 ? undefined : firstGrid3);
  const kpiCardCount = (kpiRowBlock.match(/class="kpi-card [a-z]+ ui2-kpi"/g) || []).length;
  assert.equal(kpiCardCount, 4, `expected exactly 4 KPI cards directly under the hero, found ${kpiCardCount}`);
  // The relocated legacy KPI row (Présents/Visiteurs/Véhicules/Incidents
  // ouverts) must not immediately follow the new row — it now lives further
  // down, just above the "Flux d'accès" chart section.
  assert.doesNotMatch(kpiRowBlock, /kpi-presents/, 'the legacy KPI row must not be duplicated directly under the new hero KPI row');
});

test('only one element carries the ui2-kpi-grid class in the whole dashboard', () => {
  const matches = dashboardHtml.match(/class="kpi-grid ui2-kpi-grid"/g) || [];
  assert.equal(matches.length, 1, 'exactly one new-style KPI row is expected, found ' + matches.length);
});

/* ============================================================ */
/*  Blocs principaux du tableau de bord présents                  */
/* ============================================================ */

test('the dashboard has the hero, 4-KPI row, and both 3-panel rows (map/incidents/live-feed, then charts/assistant)', () => {
  assert.match(dashboardHtml, /id="cleanHeroStatus"/);
  assert.match(dashboardHtml, /class="kpi-grid ui2-kpi-grid"/);
  const grid3Count = (dashboardHtml.match(/class="ui2-grid-3"/g) || []).length;
  assert.equal(grid3Count, 2, 'expected exactly two 3-panel rows on the dashboard');
  assert.match(dashboardHtml, /id="dashMapCanvas"/, 'Carte des sites panel');
  assert.match(dashboardHtml, /id="dashIncidentsRecents"/, 'Incidents récents panel');
  assert.match(dashboardHtml, /id="dashLiveFeed"/, 'Flux en direct panel');
  assert.match(dashboardHtml, /id="chartHourly"/, 'Activité par heure chart');
  assert.match(dashboardHtml, /id="chartAlertsDonut"/, 'Répartition des alertes chart');
  assert.match(dashboardHtml, /id="dashAssistantQuestion"/, 'Assistant SOC panel');
});

test('the hero keeps its photo band, greeting, date/clock, status and SOS — no element removed', () => {
  assert.match(dashboardHtml, /id="heroUsername"/);
  assert.match(dashboardHtml, /id="heroDate"/);
  assert.match(dashboardHtml, /id="heroClock"/);
  assert.match(dashboardHtml, /id="cleanStatusText"/);
  assert.match(dashboardHtml, /class="ui2-hero-photo"/);
  assert.match(dashboardHtml, /\bui2-hero-sos\b/);
});

/* ============================================================ */
/*  Densité : les blocs Chart.js ont une hauteur bornée           */
/*  (régression : un canvas Chart.js sans maintainAspectRatio:    */
/*  false grandit sans limite dans une grille CSS et empêche le   */
/*  dashboard de tenir sur un écran 16:9).                        */
/* ============================================================ */

test('the two new dashboard charts constrain their canvas height (maintainAspectRatio:false + a bounded wrapper)', () => {
  assert.match(cssSource, /\.ui2-chart-box\{[^}]*height:\d+px/, 'chart canvases must sit in a height-bounded box');
  const appSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');
  const hourlyFn = appSource.slice(appSource.indexOf('function drawChartHourly'), appSource.indexOf('function drawChartAlertsDonut'));
  const donutFn = appSource.slice(appSource.indexOf('function drawChartAlertsDonut'));
  assert.match(hourlyFn, /maintainAspectRatio:\s*false/, 'chartHourly must not be left to grow unbounded');
  assert.match(donutFn.slice(0, donutFn.indexOf('\n}')), /maintainAspectRatio:\s*false/, 'chartAlertsDonut must not be left to grow unbounded');
});

/* ============================================================ */
/*  Navigation : les 12 pages restent accessibles                 */
/* ============================================================ */

test('the sidebar still exposes navigation to all existing pages (no page removed by the redesign)', () => {
  const sidebar = htmlSource.slice(htmlSource.indexOf('id="sidebar"'), htmlSource.indexOf('class="sidebar-footer"'));
  const navItems = [...sidebar.matchAll(/data-page="([a-z-]+)"/g)].map(m => m[1]);
  assert.equal(navItems.length, 15, `expected 15 sidebar nav items, found ${navItems.length}: ${navItems.join(', ')}`);
  for (const page of ['dashboard', 'carte', 'alertes', 'incidents', 'vehicules', 'lapi', 'pietons', 'visiteurs', 'employes', 'parking', 'badges', 'rapports', 'utilisateurs', 'parametres', 'maincourante']) {
    assert.ok(navItems.includes(page), `expected nav item for "${page}"`);
  }
});
