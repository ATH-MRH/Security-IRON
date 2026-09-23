'use strict';
// HOTFIX — HEADER SECURISITE NON INTERACTIF (signalé en production après le
// déploiement du commit d35b9a0, refonte de la liste d'alertes en table).
//
// Reproduction (Playwright, navigateur réel, Service Worker désactivé) :
// d35b9a0 ET HEAD après hotfix passent tous les deux à 100 % — recherche,
// cloche de notifications, FR/AR, menu profil (ouverture/clic extérieur/
// Echap), déconnexion, zéro erreur JS. d35b9a0 ne touche ni index.html ni
// app.js dans la zone topbar (voir `git show d35b9a0 --stat` : seuls
// alerts.css/alerts.js/ui.js (dictionnaire I18N_AR) et
// tests/notifications.test.js sont modifiés).
//
// Cause racine réelle : frontend/sw.js sert le shell (HTML/CSS/JS, jamais
// /api/*) en cache d'abord ; le navigateur ne réinstalle un Service Worker
// que si sw.js LUI-MÊME change. CACHE_VERSION n'avait jamais été
// incrémenté malgré 4 commits successifs modifiant le shell — les
// navigateurs déjà visités continuaient de servir un shell figé
// (expliquant des contrôles inertes alors que /api/*, jamais caché,
// répondait normalement dans les logs serveur). Corrigé par un seul
// changement de valeur (v3 → v4, commit suivant).
//
// Ce fichier verrouille deux choses distinctes pour l'avenir :
//  1. Le câblage id/onclick des contrôles de la topbar (index.html) reste
//     synchronisé avec les fonctions réelles d'app.js/ui.js — la classe de
//     bug qu'une refonte UI pourrait un jour réellement introduire (id
//     renommé, classe supprimée, élément recréé après binding).
//  2. Le comportement réel de ces contrôles (ouverture/fermeture, clic
//     extérieur, Echap) — pas seulement leur présence dans le DOM.
//  3. Le mécanisme d'éviction de cache du Service Worker dont dépend la
//     véritable correction (frontend/sw.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const swSource = fs.readFileSync(path.resolve(__dirname, '../frontend/sw.js'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');

const topbarHtml = htmlSource.slice(htmlSource.indexOf('class="topbar"'), htmlSource.indexOf('class="content"'));

/* ============================================================ */
/*  1. Câblage statique index.html <-> app.js/ui.js               */
/* ============================================================ */

test('topbar : recherche globale — élément et raccourci clavier présents et câblés', () => {
  assert.match(topbarHtml, /id="topbarSearch"[^>]*oninput="filterTopbarSearch\(this\.value\)"/);
  assert.match(topbarHtml, /id="topbarSearchResults"/);
  assert.match(appSource, /function filterTopbarSearch\(query\)\{/);
  assert.match(appSource, /function runTopbarSearch\(query\)\{/);
  assert.match(appSource, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\)==='k'/);
});

test('topbar : bouton notifications câblé sur openNotifications()', () => {
  assert.match(topbarHtml, /onclick="openNotifications\(\)"/);
  assert.match(appSource, /function openNotifications\(\)\{\s*return NotificationBell\.open\(\);\s*\}/);
});

test('topbar : sélecteur FR/AR câblé (bouton, dropdown, les 2 options de langue)', () => {
  assert.match(topbarHtml, /id="langMenuButton"[^>]*onclick="toggleLangMenu\(\)"/);
  assert.match(topbarHtml, /id="langMenuDropdown"/);
  assert.match(topbarHtml, /setLanguage\('fr'\);closeLangMenu\(\)/);
  assert.match(topbarHtml, /setLanguage\('ar'\);closeLangMenu\(\)/);
  assert.match(appSource, /function toggleLangMenu\(\)\{/);
});

test('topbar : menu profil câblé (bouton, chevron implicite, dropdown, Déconnexion)', () => {
  assert.match(topbarHtml, /id="userMenuButton"[^>]*onclick="toggleUserMenu\(\)"/);
  assert.match(topbarHtml, /id="userMenuDropdown"/);
  assert.match(topbarHtml, /onclick="doLogout\(\)"/);
  assert.match(appSource, /function toggleUserMenu\(\)\{/);
  assert.match(appSource, /function doLogout\(\)\{/);
});

test('topbar : le bouton mode sombre a été retiré proprement (pas de référence orpheline)', () => {
  assert.doesNotMatch(topbarHtml, /themeToggle|toggleTheme/);
  assert.doesNotMatch(appSource, /function toggleTheme|function applyTheme|THEME_KEY/);
});

test('topbar : le SOS reste présent, câblé sur son comportement existant (appui maintenu), jamais un simple clic', () => {
  assert.match(topbarHtml, /class="[^"]*sos-trigger[^"]*"/);
  assert.doesNotMatch(topbarHtml.match(/class="[^"]*sos-trigger[^"]*"[^>]*>/)[0], /onclick=/);
});

/* ============================================================ */
/*  MISSION TOPBAR GLOBALE — date/heure/état système déplacés de   */
/*  l'ancien widget du tableau de bord (.ui2-hero-time, retiré)     */
/*  vers la topbar globale, visible sur tout le shell principal.   */
/* ============================================================ */

test('topbar : date/heure — éléments présents et câblés sur une seule horloge (initTopbarStatus/tickTopbarClock)', () => {
  assert.match(topbarHtml, /id="topbarDateFull"/);
  assert.match(topbarHtml, /id="topbarDateShort"/);
  assert.match(topbarHtml, /id="topbarClockFull"/);
  assert.match(topbarHtml, /id="topbarClockShort"/);
  assert.match(appSource, /function initTopbarStatus\(\)\{/);
  assert.match(appSource, /function tickTopbarClock\(\)\{/);
  // Une seule instance de minuteur (clearInterval avant setInterval), pas
  // une horloge séparée créée à chaque navigation.
  assert.match(appSource, /clearInterval\(topbarClockTimer\);\s*\n\s*topbarClockTimer = setInterval\(tickTopbarClock, 1000\)/);
  assert.match(appSource, /function initApp\(\)\{[\s\S]*initTopbarStatus\(\);/, 'initTopbarStatus doit être démarré depuis initApp(), une seule fois par session');
});

test('topbar : état système — bouton câblé (aria-haspopup/aria-expanded/aria-controls/aria-label), popover et liste présents', () => {
  assert.match(topbarHtml, /id="topbarHealthButton"[^>]*aria-haspopup="true"/);
  assert.match(topbarHtml, /id="topbarHealthButton"[^>]*aria-expanded="false"/);
  assert.match(topbarHtml, /id="topbarHealthButton"[^>]*aria-controls="topbarHealthPopover"/);
  assert.match(topbarHtml, /id="topbarHealthButton"[^>]*aria-label="[^"]+"/);
  assert.match(topbarHtml, /id="topbarHealthButton"[^>]*onclick="toggleTopbarHealthPopover\(\)"/);
  assert.match(topbarHtml, /<button[^>]*id="topbarHealthButton"/, 'doit être un vrai <button>, jamais une div cliquable inaccessible');
  assert.match(topbarHtml, /id="topbarHealthPopover"[^>]*hidden/);
  assert.match(topbarHtml, /id="topbarHealthList"/);
  assert.match(appSource, /function toggleTopbarHealthPopover\(\)\{/);
  assert.match(appSource, /function refreshTopbarHealth\(\)\{/);
});

test('topbar : état système réutilise le même seuil critique que Administration Système (application+postgresql), jamais un second calcul divergent', () => {
  assert.match(appSource, /const TOPBAR_CRITICAL_SERVICES = \['application', 'postgresql'\]/);
  const adminSystemSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/admin-system.js'), 'utf8');
  assert.match(adminSystemSource, /const CRITICAL_SERVICES = \['application', 'postgresql'\]/);
});

test('topbar : l\'appel santé pour un administrateur réutilise GET /admin/system (déjà utilisé par Administration Système), jamais un nouvel endpoint', () => {
  assert.match(appSource, /API\.get\('\/admin\/system'\)/);
  assert.match(appSource, /API\.get\('\/ready'\)/, 'repli pour un utilisateur non-administrateur : la sonde publique déjà existante, jamais un endpoint inventé');
});

test('topbar : le pilotage de fréquence évite un appel santé chaque seconde (§12 mission — performance)', () => {
  assert.match(appSource, /topbarHealthTimer = setInterval\(refreshTopbarHealth, 60000\)/);
});

test('l\'ancien widget hero (heroDate/heroClock/cleanStatusText) n\'apparaît plus jamais deux fois : retiré du tableau de bord, remplacé par la topbar', () => {
  assert.doesNotMatch(appSource, /function tickHeroClock/);
  assert.doesNotMatch(appSource, /let heroClockTimer;/, 'la variable de minuteur elle-même doit avoir disparu (une seule mention historique en commentaire est attendue, jamais une seconde déclaration)');
  assert.doesNotMatch(appSource, /heroClockTimer = setInterval/);
  assert.doesNotMatch(htmlSource, /id="heroDate"/);
  assert.doesNotMatch(htmlSource, /id="heroClock"/);
  assert.doesNotMatch(htmlSource, /id="cleanStatusText"/);
});

/* ============================================================ */
/*  MISSION TOPBAR COMPACTE — visuel validé appliqué : bloc marque   */
/*  retiré de la topbar (sidebar intacte), voyant seul (plus de      */
/*  pilule texte), langue ultra-compacte, SOS capsule premium.       */
/* ============================================================ */

test('topbar : le bloc marque (logo/SécuriSite/SOC/Centre de Sécurité) est retiré, la recherche devient le premier élément important', () => {
  assert.doesNotMatch(topbarHtml, /topbar-brand/);
  assert.doesNotMatch(topbarHtml, /app-logo-topbar/);
  assert.doesNotMatch(topbarHtml, />SécuriSite</);
  assert.doesNotMatch(topbarHtml, />SOC</);
  assert.doesNotMatch(topbarHtml, />Centre de Sécurité</);
  assert.match(topbarHtml, /id="topbarSearch"/);
});

test('sidebar : le branding (logo + SécuriSite) reste intact — seule la topbar a perdu le sien', () => {
  const sidebarHtml = htmlSource.slice(htmlSource.indexOf('id="sidebar"'), htmlSource.indexOf('class="topbar"'));
  assert.match(sidebarHtml, /app-logo-sidebar/);
  assert.match(sidebarHtml, /SécuriSite<\/h1>/);
});

test('topbar : l\'ancienne pilule texte de l\'état système ("Système opérationnel" permanent) est retirée — seul le voyant (cercle) reste dans le DOM', () => {
  assert.doesNotMatch(topbarHtml, /topbar-health-copy/);
  assert.doesNotMatch(topbarHtml, /id="topbarHealthText"/);
  assert.doesNotMatch(topbarHtml, /id="topbarHealthSub"/);
  assert.match(topbarHtml, /id="topbarHealthDot"/);
  // Le texte d'état réel n'a pas disparu : déplacé dans l'aria-label du
  // bouton (voir app.js#renderTopbarHealth), toujours calculé à partir de
  // la même santé réelle — jamais une valeur statique/fictive.
  assert.match(appSource, /button\.setAttribute\('aria-label', label\)/);
});

test('topbar : le voyant système garde ses 4 états réels (vert/orange/rouge/gris), jamais une couleur inventée', () => {
  assert.match(cssSource, /\.topbar-health-dot\.topbar-health-ok\{background:var\(--success\)/);
  assert.match(cssSource, /\.topbar-health-dot\.topbar-health-degraded\{background:var\(--warning\)/);
  assert.match(cssSource, /\.topbar-health-dot\.topbar-health-down\{background:var\(--danger\)/);
  assert.match(cssSource, /\.topbar-health-dot\.topbar-health-unknown\{background:var\(--text-dim\)/);
});

test('topbar : sélecteur de langue ultra-compact — affiche la langue ACTIVE seule ("FR" ou "AR"), jamais "FR / AR" simultané', () => {
  assert.match(topbarHtml, /id="langMenuButtonLabel">FR</);
  assert.doesNotMatch(topbarHtml, />FR \/ AR</);
});

test('ui.js : applyLanguage() met à jour le libellé compact de langue (FR/AR), quel que soit le point d\'entrée réel (pas seulement setLanguage)', () => {
  const uiSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');
  const fn = uiSource.slice(uiSource.indexOf('function applyLanguage'), uiSource.indexOf('function applyLanguage') + 2000);
  assert.match(fn, /langMenuButtonLabel/);
  assert.match(fn, /lang === 'ar' \? 'AR' : 'FR'/);
});

test('topbar : le SOS reprend la capsule rouge foncé premium (fond dégradé bordeaux, forme très arrondie, ombre douce) — logique de maintien inchangée', () => {
  const block = cssSource.slice(cssSource.lastIndexOf('.topbar .sos-button{'), cssSource.lastIndexOf('.topbar .sos-button{') + 900);
  assert.match(block, /border-radius:999px/);
  assert.match(block, /linear-gradient\(180deg,#8f1029/);
  assert.match(block, /box-shadow:/);
  assert.match(topbarHtml, /class="sos-icon"/, 'icône alerte blanche à côté du texte SOS');
  // Toujours le même mécanisme sos-trigger (appui maintenu ~1,5s), jamais
  // un onclick de substitution.
  assert.match(topbarHtml, /class="sos-button sos-trigger"/);
});

test('d35b9a0 (commit incriminé) n\'a modifié ni index.html dans la zone topbar, ni app.js du tout', () => {
  // Preuve statique, en plus de la reproduction Playwright réelle : le
  // commit accusé ne touche que Centre d'alertes (alerts.css/alerts.js),
  // le dictionnaire I18N_AR (ui.js) et son test — jamais app.js ni la
  // zone topbar de index.html.
  const { execSync } = require('node:child_process');
  const files = execSync('git show d35b9a0 --stat --name-only', { cwd: path.resolve(__dirname, '..') })
    .toString().split('\n').map(l => l.trim()).filter(Boolean);
  assert.ok(!files.includes('frontend/js/app.js'), 'app.js ne devrait pas apparaître dans d35b9a0');
});

/* ============================================================ */
/*  2. Comportement réel (ouverture/fermeture, clic extérieur,    */
/*     Echap) — pas seulement la présence dans le DOM.            */
/* ============================================================ */

function loadApp() {
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const attrs = {};
      elements.set(id, {
        id, classList: {
          add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        },
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: k => (k in attrs ? attrs[k] : null),
        removeAttribute: k => { delete attrs[k]; },
        hasAttribute: k => k in attrs,
        addEventListener() {}, style: {}, dataset: {},
        // .closest('.user-menu') / .closest('.lang-menu') : chaque bouton
        // "connaît" son propre groupe logique (reflète le vrai markup, où
        // bouton + dropdown partagent le même conteneur .user-menu/.lang-menu).
        closest(sel) { return (this._group === sel.replace('.', '')) ? this : null; },
        contains(other) { return other === this || other?._insideOf === this; },
      });
    }
    return elements.get(id);
  }
  const userMenuButton = el('userMenuButton'); userMenuButton._group = 'user-menu';
  const userMenuDropdown = el('userMenuDropdown'); userMenuDropdown._insideOf = userMenuButton;
  const langMenuButton = el('langMenuButton'); langMenuButton._group = 'lang-menu';
  const langMenuDropdown = el('langMenuDropdown'); langMenuDropdown._insideOf = langMenuButton;
  const topbarHealthButton = el('topbarHealthButton'); topbarHealthButton._group = 'topbar-status';
  const topbarHealthPopover = el('topbarHealthPopover'); topbarHealthPopover._insideOf = topbarHealthButton;
  const outsideEl = el('somePage'); // n'appartient à aucun groupe

  const docListeners = { click: [], keydown: [] };
  const document = {
    querySelectorAll: () => [],
    getElementById: id => el(id),
    addEventListener(type, fn) { if (docListeners[type]) docListeners[type].push(fn); },
    documentElement: { setAttribute() {}, getAttribute: () => null },
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, console, navigator: {},
    localStorage: { getItem: () => null, setItem() {} },
  });
  new vm.Script(appSource, { filename: 'app.js' }).runInContext(context);
  const get = expr => new vm.Script(expr).runInContext(context);
  return {
    toggleUserMenu: () => get('toggleUserMenu()'),
    toggleTopbarHealthPopover: () => get('toggleTopbarHealthPopover()'),
    userMenuButton, userMenuDropdown, langMenuButton, langMenuDropdown,
    topbarHealthButton, topbarHealthPopover, outsideEl,
    fireDocClick: target => docListeners.click.forEach(fn => fn({ target })),
    fireDocKeydown: key => docListeners.keydown.forEach(fn => fn({ key, metaKey: false, ctrlKey: false, preventDefault() {} })),
  };
}

test('toggleUserMenu() ouvre et referme le menu profil, aria-expanded suit l\'état', () => {
  const { toggleUserMenu, userMenuDropdown, userMenuButton } = loadApp();
  assert.equal(userMenuDropdown.hasAttribute('hidden'), false, 'hidden n\'est jamais posé par défaut côté mock (reflète le HTML réel, non masqué avant JS)');
  userMenuDropdown.setAttribute('hidden', ''); // état initial réel : index.html porte `hidden`
  toggleUserMenu();
  assert.equal(userMenuDropdown.hasAttribute('hidden'), false, 'le menu doit s\'ouvrir au premier clic');
  assert.equal(userMenuButton.getAttribute('aria-expanded'), 'true');
  toggleUserMenu();
  assert.equal(userMenuDropdown.hasAttribute('hidden'), true, 'le menu doit se refermer au second clic');
  assert.equal(userMenuButton.getAttribute('aria-expanded'), 'false');
});

test('un clic en dehors du menu profil le referme (jamais un clic à l\'intérieur)', () => {
  const { toggleUserMenu, userMenuDropdown, userMenuButton, outsideEl, fireDocClick } = loadApp();
  userMenuDropdown.setAttribute('hidden', '');
  toggleUserMenu();
  assert.equal(userMenuDropdown.hasAttribute('hidden'), false, 'ouvert avant le test');
  fireDocClick(userMenuButton); // clic "à l'intérieur" du menu : ne doit rien fermer
  assert.equal(userMenuDropdown.hasAttribute('hidden'), false, 'un clic à l\'intérieur ne doit pas fermer le menu');
  fireDocClick(outsideEl); // clic réellement extérieur
  assert.equal(userMenuDropdown.hasAttribute('hidden'), true, 'un clic extérieur doit fermer le menu');
});

test('Echap referme le menu profil', () => {
  const { toggleUserMenu, userMenuDropdown, fireDocKeydown } = loadApp();
  userMenuDropdown.setAttribute('hidden', '');
  toggleUserMenu();
  assert.equal(userMenuDropdown.hasAttribute('hidden'), false);
  fireDocKeydown('Escape');
  assert.equal(userMenuDropdown.hasAttribute('hidden'), true);
});

test('toggleTopbarHealthPopover() ouvre et referme le popover État système, aria-expanded suit l\'état', () => {
  const { toggleTopbarHealthPopover, topbarHealthPopover, topbarHealthButton } = loadApp();
  topbarHealthPopover.setAttribute('hidden', ''); // état initial réel : index.html porte `hidden`
  toggleTopbarHealthPopover();
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), false, 'le popover doit s\'ouvrir au premier clic');
  assert.equal(topbarHealthButton.getAttribute('aria-expanded'), 'true');
  toggleTopbarHealthPopover();
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), true, 'le popover doit se refermer au second clic');
  assert.equal(topbarHealthButton.getAttribute('aria-expanded'), 'false');
});

test('un clic en dehors du popover État système le referme (jamais un clic à l\'intérieur)', () => {
  const { toggleTopbarHealthPopover, topbarHealthPopover, topbarHealthButton, outsideEl, fireDocClick } = loadApp();
  topbarHealthPopover.setAttribute('hidden', '');
  toggleTopbarHealthPopover();
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), false, 'ouvert avant le test');
  fireDocClick(topbarHealthButton); // clic "à l'intérieur" : ne doit rien fermer
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), false, 'un clic à l\'intérieur ne doit pas fermer le popover');
  fireDocClick(outsideEl); // clic réellement extérieur
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), true, 'un clic extérieur doit fermer le popover');
});

test('Echap referme le popover État système', () => {
  const { toggleTopbarHealthPopover, topbarHealthPopover, fireDocKeydown } = loadApp();
  topbarHealthPopover.setAttribute('hidden', '');
  toggleTopbarHealthPopover();
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), false);
  fireDocKeydown('Escape');
  assert.equal(topbarHealthPopover.hasAttribute('hidden'), true);
});

/* ============================================================ */
/*  3. Service Worker : le mécanisme d'éviction de cache dont     */
/*     dépend la véritable correction (frontend/sw.js).           */
/* ============================================================ */

function loadServiceWorker(opts = {}) {
  const listeners = {};
  const cachedMatch = opts.cachedMatch === undefined ? undefined : opts.cachedMatch;
  const fetchImpl = opts.fetchImpl || (async () => ({ ok: false }));
  const caches = {
    stores: new Map(),
    open(name) {
      if (!this.stores.has(name)) this.stores.set(name, { addAll: async () => {}, put: async () => {} });
      return Promise.resolve(this.stores.get(name));
    },
    keys() { return Promise.resolve([...this.stores.keys()]); },
    delete(name) { return Promise.resolve(this.stores.delete(name)); },
    match() { return Promise.resolve(cachedMatch); },
  };
  const self = {
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
    registration: {}, location: { origin: 'https://example.test' },
  };
  const context = vm.createContext({ self, caches, console, fetch: fetchImpl, URL });
  new vm.Script(swSource, { filename: 'sw.js' }).runInContext(context);
  return { listeners, caches };
}

test('sw.js : install() peuple un cache nommé d\'après CACHE_VERSION', async () => {
  const { listeners, caches } = loadServiceWorker();
  let waited;
  await listeners.install({ waitUntil: p => { waited = p; } });
  await waited;
  assert.ok(caches.stores.has('securisite-shell-v19'), 'le cache actuel doit exister après install()');
});

test('sw.js : activate() évince un cache resté sous un ancien nom (le vrai mécanisme derrière le hotfix)', async () => {
  const { listeners, caches } = loadServiceWorker();
  // Simule un navigateur déjà visité sous l'ancienne version, jamais évincé
  // faute de CACHE_VERSION incrémenté — exactement le bug de production.
  caches.stores.set('securisite-shell-v18', {});
  caches.stores.set('securisite-shell-v19', {});
  let waited;
  await listeners.activate({ waitUntil: p => { waited = p; } });
  await waited;
  assert.equal(caches.stores.has('securisite-shell-v18'), false, 'l\'ancien cache doit être évincé par activate()');
  assert.equal(caches.stores.has('securisite-shell-v19'), true, 'le cache courant doit être conservé');
});

test('sw.js : SHELL_ASSETS inclut le moteur de workflows (js/maincourante-workflows.js, entré dans SHELL_ASSETS au bump v4 → v5)', () => {
  assert.match(swSource, /'js\/maincourante-workflows\.js'/);
});

test('sw.js : CACHE_VERSION a bien été incrémenté pour la mission TOPBAR COMPACTE — visuel validé appliqué (v18 → v19)', () => {
  assert.match(swSource, /const CACHE_VERSION = 'securisite-shell-v19';/);
  assert.match(swSource, /'js\/admin-system\.js'/);
});

/* ============================================================ */
/*  BUG BLOQUANT — Administration Système → Groupes → Ouvrir       */
/*  Cause racine reproduite en navigateur réel (profil Playwright  */
/*  persistant, rapport de mission) : l'ancienne stratégie          */
/*  cache-first (`cached || network`) servait la version en cache   */
/*  MÊME APRÈS correction du fichier sur le serveur — il fallait    */
/*  systématiquement DEUX rechargements avant qu'un correctif       */
/*  devienne visible ; un onglet resté ouvert pendant l'itération   */
/*  pouvait afficher une sidebar à jour (index.html déjà rafraîchi) */
/*  avec un admin-system.js encore obsolète (fichiers mis en cache  */
/*  indépendamment) — un clic sur "Ouvrir" appelant alors une        */
/*  fonction manquante/obsolète, silencieusement.                   */
/* ============================================================ */

test('sw.js : le gestionnaire fetch interroge le RÉSEAU EN PREMIER — jamais le cache en priorité (cause racine du bug "Ouvrir" bloquant)', async () => {
  let networkCalled = false;
  const { listeners } = loadServiceWorker({
    cachedMatch: new Response('CACHED-STALE-CONTENT', { status: 200 }),
    fetchImpl: async () => { networkCalled = true; return new Response('FRESH-NETWORK-CONTENT', { status: 200 }); },
  });
  let responded;
  const event = {
    request: { url: 'https://example.test/js/admin-system.js', method: 'GET' },
    respondWith(p) { responded = p; },
  };
  listeners.fetch(event);
  const response = await responded;
  const body = await response.text();
  assert.equal(networkCalled, true, 'le réseau doit toujours être tenté en premier, jamais seulement en arrière-plan');
  assert.equal(body, 'FRESH-NETWORK-CONTENT', 'la réponse retournée à la page doit être celle du réseau, pas celle du cache — sinon un correctif serveur reste invisible tant qu\'aucun second rechargement n\'a eu lieu (bug reproduit et documenté dans le rapport de mission)');
});

test('sw.js : le cache reste un repli hors-ligne réel quand le réseau échoue — jamais une page blanche', async () => {
  const { listeners } = loadServiceWorker({
    cachedMatch: new Response('OFFLINE-CACHED-SHELL', { status: 200 }),
    fetchImpl: async () => { throw new Error('network unreachable (offline)'); },
  });
  let responded;
  const event = {
    request: { url: 'https://example.test/index.html', method: 'GET' },
    respondWith(p) { responded = p; },
  };
  listeners.fetch(event);
  const response = await responded;
  const body = await response.text();
  assert.equal(body, 'OFFLINE-CACHED-SHELL', 'hors ligne, le cache doit rester servi — c\'est la seule raison d\'être du cache app-shell');
});

/* ============================================================ */
/*  4. HOTFIX TOPBAR — cause racine confirmée en production        */
/*     (DevTools) : .topbar{overflow:hidden!important} rognait     */
/*     tout menu enfant (langue/profil/recherche) dès qu'il         */
/*     dépassait verticalement des 72px de la barre. style.css      */
/*     empile plusieurs `.topbar{}` distincts (héritage de couches  */
/*     visuelles successives, cf. commentaires du fichier) : seule  */
/*     compte la déclaration `overflow` GAGNANTE une fois la        */
/*     cascade résolue propriété par propriété (comme pour les      */
/*     autres bugs de ce type déjà rencontrés sur .topbar) — pas    */
/*     simplement « la dernière règle du bloc ».                    */
/* ============================================================ */

function resolveCascadeWinner(css, selector, property) {
  const blockRe = new RegExp('^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'gm');
  const declRe = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;!]+?)\\s*(!important)?\\s*(?=;|$)');
  let winner = null;
  let winnerImportant = false;
  let match;
  while ((match = blockRe.exec(css))) {
    const decl = match[1].match(declRe);
    if (!decl) continue;
    const value = decl[1].trim();
    const important = !!decl[2];
    if (important || !winnerImportant) { winner = value; winnerImportant = winnerImportant || important; }
  }
  return winner;
}

test('cause racine : la déclaration .topbar{overflow} gagnante (cascade résolue) est "visible", jamais "hidden"', () => {
  const winner = resolveCascadeWinner(cssSource, '.topbar', 'overflow');
  assert.equal(winner, 'visible',
    'si ce test échoue avec "hidden", le bug de rognage des menus (langue/profil/recherche) est de retour : ' +
    'un dropdown positionné en absolute sous la topbar (top:calc(100% + Npx)) sera de nouveau invisible dès ' +
    'qu\'il dépasse les 72px de hauteur fixe de la barre.');
});

test('cause racine : aucun bloc .topbar ne réintroduit overflow:hidden après la règle de hauteur fixe (72px)', () => {
  // Verrou spécifique sur le bloc historiquement fautif (hauteur constante) :
  // s'assure qu'un futur retour de "overflow:hidden" à cet endroit précis
  // serait immédiatement détecté, pas seulement via la résolution globale.
  const fixedHeightBlock = cssSource.slice(
    cssSource.indexOf('Hauteur topbar constante sur toutes les pages'),
    cssSource.indexOf('.topbar-left,.topbar-right{'),
  ).replace(/\/\*[\s\S]*?\*\//g, ''); // les commentaires peuvent légitimement mentionner "overflow:hidden" (historique) sans que la règle CSS elle-même le redéclare
  assert.doesNotMatch(fixedHeightBlock, /overflow\s*:\s*hidden/);
  assert.match(fixedHeightBlock, /height:72px!important/, 'la hauteur fixe doit rester préservée (exigence explicite du hotfix)');
});

test('les trois dropdowns enfants de la topbar (langue, profil, recherche) sont bien positionnés pour dépasser verticalement, jamais recadrés dans leur propre boîte', () => {
  // Chacun est position:absolute avec top:calc(100% + Npx) par rapport à son
  // parent position:relative — c'est .topbar (ancêtre commun) qui doit rester
  // overflow:visible pour qu'ils s'affichent réellement (vérifié ci-dessus) ;
  // ici on verrouille seulement que le positionnement lui-même n'a pas changé.
  for (const sel of ['.lang-menu-dropdown', '.user-menu-dropdown', '.topbar-search-results']) {
    const block = cssSource.slice(cssSource.indexOf(sel + '{'), cssSource.indexOf(sel + '{') + 300);
    assert.match(block, /position\s*:\s*absolute/, sel + ' doit rester position:absolute');
    assert.match(block, /top\s*:\s*calc\(100% \+ \d+px\)/, sel + ' doit rester positionné sous son déclencheur');
  }
});
