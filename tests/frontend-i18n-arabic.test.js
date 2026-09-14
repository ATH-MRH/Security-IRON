'use strict';
// Regression guard for the Arabic (AR) language support incident: the
// I18N_AR dictionary in frontend/js/ui.js was never extended as later
// features (Alert Center/SOC, SOS, map, admin console, ATLAS) were added on
// top of it, and exact-match lookups silently left any icon-prefixed label
// (e.g. "📊 Rapports") untranslated even though the base phrase itself WAS
// translated — together making Arabic support look like it had "disappeared"
// as the app grew, well after it last actually worked.
//
// No browser/DOM available in this suite: ui.js is a plain script (no
// module.exports), loaded into a vm context the same way
// tests/frontend-soc-kpis.test.js already does for frontend/js/soc-kpis.js —
// top-level `const`/function declarations in a script run via
// vm.Script#runInContext remain readable by a later script run in the same
// context, which is all `translateText`/`I18N_AR` need to be exercised for
// real (not just pattern-matched via a source-level regex).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const uiSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');
const alertsCssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/alerts.css'), 'utf8');

function loadUi() {
  const context = vm.createContext({});
  new vm.Script(uiSource, { filename: 'ui.js' }).runInContext(context);
  const get = expr => new vm.Script(expr).runInContext(context);
  return {
    I18N_AR: JSON.parse(JSON.stringify(get('I18N_AR'))),
    translateText: (text, lang) => get(`translateText(${JSON.stringify(text)}, ${JSON.stringify(lang)})`),
  };
}

test('the AR dictionary loads and is substantial (not emptied out)', () => {
  const { I18N_AR } = loadUi();
  assert.ok(Object.keys(I18N_AR).length > 400,
    'I18N_AR should hold several hundred entries covering the whole app, not just the original dashboard');
});

test('translateText: exact-match keys still resolve identically in fr/ar/fr-ar (no regression from the icon-prefix fix)', () => {
  const { translateText } = loadUi();
  assert.equal(translateText('Tableau de bord', 'fr'), 'Tableau de bord');
  assert.equal(translateText('Tableau de bord', 'ar'), 'لوحة التحكم');
  assert.equal(translateText('Tableau de bord', 'fr-ar'), 'Tableau de bord / لوحة التحكم');
  // A key that itself legitimately starts with a symbol ("+ ...") must keep
  // matching exactly and never get mangled by the symbol-stripping fallback.
  assert.equal(translateText('+ Utilisateur', 'ar'), '+ مستخدم');
});

test('translateText: an icon/arrow-prefixed label now resolves via the base phrase (the actual regression)', () => {
  const { translateText } = loadUi();
  assert.equal(translateText('📊 Rapports', 'ar'), '📊 التقارير');
  assert.equal(translateText('🚨 Incidents récents', 'ar'), '🚨 الحوادث الأخيرة');
  assert.equal(translateText('✏️ Modifier', 'ar'), '✏️ تعديل');
  assert.equal(translateText('➡️ Entrée', 'ar'), '➡️ دخول');
});

test('translateText: a trailing symbol (checkmark, dash) is preserved around the translation', () => {
  const { translateText } = loadUi();
  assert.equal(translateText('Confirmée ✓', 'ar'), 'مؤكَّدة ✓');
  assert.equal(translateText('— Aucune plaque —', 'ar'), '— لا توجد لوحة —');
});

test('translateText: unknown text is returned completely untouched, in every language', () => {
  const { translateText } = loadUi();
  const freeText = 'Marie Dupont';
  for (const lang of ['fr', 'ar', 'fr-ar']) assert.equal(translateText(freeText, lang), freeText);
});

test('applyLanguage sets dir=rtl and lang=ar only for Arabic, and syncs every language switcher', () => {
  assert.match(uiSource, /document\.documentElement\.dir\s*=\s*lang\s*===\s*'ar'\s*\?\s*'rtl'\s*:\s*'ltr'/);
  assert.match(uiSource, /document\.documentElement\.lang\s*=\s*lang\s*===\s*'ar'\s*\?\s*'ar'\s*:\s*'fr'/);
  // Both the topbar and the login-screen switcher must be kept in sync —
  // by class, not a single #id, so the login one (added because AR was
  // otherwise unreachable before authenticating) is never left stale.
  assert.match(uiSource, /querySelectorAll\('\.lang-select'\)/);
});

test('a language switcher exists both on the login screen and in the app topbar', () => {
  const loginOverlay = htmlSource.slice(htmlSource.indexOf('id="loginOverlay"'), htmlSource.indexOf('<!-- ===== App'));
  assert.match(loginOverlay, /class="lang-select"/, 'login screen must offer a language switcher (AR was unreachable before login otherwise)');
  assert.match(loginOverlay, /<option value="ar">/);
  const topbar = htmlSource.slice(htmlSource.indexOf('class="topbar-right"'), htmlSource.indexOf('class="content"'));
  assert.match(topbar, /class="lang-select"/);
  assert.match(topbar, /<option value="ar">/);
});

// Extracts every string a user would actually see: element text content and
// placeholder/title/aria-label attributes, mirroring what applyLanguage()
// itself walks at runtime (minus the DOM — this parses the static markup).
function visibleStrings(html) {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const texts = new Set();
  const tagTextRe = />([^<>{}\n][^<>]*)</g;
  let m;
  while ((m = tagTextRe.exec(noScript))) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t && /[A-Za-zÀ-ÿ]/.test(t) && t.length > 1) texts.add(t);
  }
  const attrRe = /(placeholder|title|aria-label)="([^"]+)"/g;
  while ((m = attrRe.exec(html))) {
    const t = m[2].trim();
    if (t && /[A-Za-zÀ-ÿ]/.test(t)) texts.add(t);
  }
  return texts;
}

function stripSymbols(s) {
  const lead = (s.match(/^[^\p{L}\p{N}]+\s*/u) || [''])[0];
  const rest = s.slice(lead.length);
  const trail = (rest.match(/\s*[^\p{L}\p{N}]+$/u) || [''])[0];
  return rest.slice(0, rest.length - trail.length);
}

// Deliberately never translated: native language names in the switcher
// itself, short international/technical codes and abbreviations (kept as-is
// in Arabic UIs too, same as "PDF" or "URL"), and one example placeholder
// person name (form sample data, not UI chrome).
const ALLOWED_UNTRANSLATED = new Set([
  'FR / AR', 'Français', 'SOS', 'OK',
  '📥 CSV', '24h', '7j', 'VL', 'PL', '2R', 'N1', 'N2', 'N3', 'N4',
  'Marie Dupont',
]);

test('every visible French string in index.html resolves to an Arabic translation (menus, tables, forms, alerts, SOC, SOS, admin, login)', () => {
  const { I18N_AR } = loadUi();
  const resolvable = t => (t in I18N_AR) || (stripSymbols(t) !== t && stripSymbols(t) in I18N_AR);
  const unresolved = [...visibleStrings(htmlSource)]
    .filter(t => !ALLOWED_UNTRANSLATED.has(t))
    .filter(t => !resolvable(t));
  assert.deepEqual(unresolved, [],
    'these strings are shown to users but have no Arabic translation (add them to I18N_AR in frontend/js/ui.js, ' +
    'or to ALLOWED_UNTRANSLATED above if genuinely not meant to be translated): ' + JSON.stringify(unresolved));
});

/* ============================================================ */
/*  RTL layout: the structural rules must self-mirror under      */
/*  [dir="rtl"] — style.css had zero RTL-aware rules at all       */
/*  before this fix (sidebar/main used hardcoded left offsets).   */
/* ============================================================ */

test('the sidebar and main content area use direction-aware (logical) positioning, not hardcoded left/right', () => {
  assert.match(cssSource, /\.sidebar\{[^}]*inset-inline-start:0/);
  assert.match(cssSource, /\.sidebar\{[^}]*border-inline-end:1px solid var\(--border\)/);
  // All four breakpoints/theme variants of .main must use the logical
  // property — a single leftover margin-left would silently misplace the
  // page content (never flip to the right of a right-hand sidebar) in RTL.
  const mainMargins = [...cssSource.matchAll(/\.main\{[^}]*margin-inline-start:(\d+px|0)/g)];
  assert.ok(mainMargins.length >= 4, 'expected margin-inline-start on every .main variant, found ' + mainMargins.length);
  assert.doesNotMatch(cssSource, /\.main\{[^}]*margin-left:/, 'a hardcoded margin-left on .main would break RTL layout');
});

test('table headers and severity/accent bars (alerts, main courante, LAPI, admin console) mirror under RTL', () => {
  assert.match(cssSource, /^th\{\s*background:var\(--bg-2\);padding:12px 14px;text-align:start;/m);
  for (const selector of ['.kpi-card', '.alert-item', '.mc-content', '.lapi-status-banner', '.admin-kpi']) {
    const re = new RegExp(selector.replace('.', '\\.') + '\\{[^}]*border-inline-start');
    assert.match(cssSource, re, selector + ' should use a logical border-inline-start accent, not border-left');
  }
});

test('the SOC Alert Center panel (alerts.css) mirrors its accent bars and text alignment under RTL', () => {
  assert.match(alertsCssSource, /\.ac-alert \{[^}]*text-align:start/);
  assert.match(alertsCssSource, /\.ac-alert \{[^}]*border-inline-start:4px/);
  assert.match(alertsCssSource, /\.ac-timeline\{[^}]*border-inline-start:1px/);
  assert.doesNotMatch(alertsCssSource, /border-left/, 'alerts.css should have no physical border-left left over');
});

test('the search icon repositions under RTL instead of staying pinned to the visual left', () => {
  assert.match(cssSource, /\.search-box::before\{[^}]*inset-inline-start:12px/);
});

test('the SOS button lives in the topbar as a normal flex item (moved out of its old fixed floating position)', () => {
  const topbar = htmlSource.slice(htmlSource.indexOf('class="topbar-right"'), htmlSource.indexOf('class="content"'));
  assert.match(topbar, /id="sosButton"/, 'SOS button should be inside .topbar-right');
  assert.doesNotMatch(cssSource, /\.sos-button\{[^}]*position:fixed/, 'SOS button should no longer be a fixed floating button');
});

test('a form <select> dropdown arrow explicitly moves to the correct edge under [dir="rtl"]', () => {
  assert.match(cssSource, /\[dir="rtl"\]\s*\.form-group select\{/);
});
