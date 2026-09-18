'use strict';
// Mobile usability: the sidebar was a fixed 232-268px column with no
// collapse behavior at all below 760px, leaving well under half a small
// phone's screen width for actual content. Below 860px it now goes
// off-canvas by default and opens as a drawer over the content via a ☰
// button in the topbar (frontend/js/app.js#toggleSidebar/openSidebar/
// closeSidebar), closing again on navigation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');

// app.js is a plain script (no module.exports) with a handful of top-level
// statements that just register event listeners (never fire synchronously)
// — a minimal element/classList stub is enough to load it for real and
// exercise toggleSidebar/openSidebar/closeSidebar's actual DOM effects,
// without needing every other dependency (API, Chart.js, …) those other,
// uncalled functions reference internally.
function loadApp() {
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const attrs = {};
      elements.set(id, {
        id,
        classList: {
          add: c => classes.add(c),
          remove: c => classes.delete(c),
          contains: c => classes.has(c),
        },
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: k => (k in attrs ? attrs[k] : null),
        addEventListener() {},
        style: {},
        dataset: {},
      });
    }
    return elements.get(id);
  }
  const document = {
    querySelectorAll: () => [],
    getElementById: id => el(id),
    addEventListener() {},
    documentElement: { setAttribute() {}, getAttribute: () => null },
  };
  const context = vm.createContext({ document, window: { addEventListener() {} }, console });
  new vm.Script(appSource, { filename: 'app.js' }).runInContext(context);
  const get = expr => new vm.Script(expr).runInContext(context);
  return {
    toggleSidebar: () => get('toggleSidebar()'),
    openSidebar: () => get('openSidebar()'),
    closeSidebar: () => get('closeSidebar()'),
    sidebar: el('sidebar'),
    backdrop: el('sidebarBackdrop'),
    menuToggle: el('menuToggle'),
  };
}

test('openSidebar/closeSidebar toggle the sidebar, its backdrop and the toggle button aria-expanded state', () => {
  const { openSidebar, closeSidebar, sidebar, backdrop, menuToggle } = loadApp();
  assert.equal(sidebar.classList.contains('open'), false);
  openSidebar();
  assert.equal(sidebar.classList.contains('open'), true);
  assert.equal(backdrop.classList.contains('show'), true);
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'true');
  closeSidebar();
  assert.equal(sidebar.classList.contains('open'), false);
  assert.equal(backdrop.classList.contains('show'), false);
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
});

test('toggleSidebar flips between open and closed', () => {
  const { toggleSidebar, sidebar } = loadApp();
  assert.equal(sidebar.classList.contains('open'), false);
  toggleSidebar();
  assert.equal(sidebar.classList.contains('open'), true);
  toggleSidebar();
  assert.equal(sidebar.classList.contains('open'), false);
});

test('navTo() always closes the mobile sidebar on navigation', () => {
  assert.match(appSource, /function navTo\(page\)\{\s*closeSidebar\(\);/);
});

test('the topbar has a ☰ toggle wired to the sidebar, and a backdrop that closes it on tap', () => {
  const topbarLeft = htmlSource.slice(htmlSource.indexOf('class="topbar-left"'), htmlSource.indexOf('class="topbar-right"'));
  assert.match(topbarLeft, /id="menuToggle"/);
  assert.match(topbarLeft, /onclick="toggleSidebar\(\)"/);
  assert.match(topbarLeft, /aria-controls="sidebar"/);
  assert.match(htmlSource, /id="sidebarBackdrop"[^>]*onclick="closeSidebar\(\)"/);
  assert.match(htmlSource, /<aside class="sidebar" id="sidebar">/);
});

test('below 860px the sidebar goes off-canvas and the content reclaims the full width', () => {
  const mobileBlock = cssSource.slice(cssSource.indexOf('@media(max-width:860px)'));
  const block = mobileBlock.slice(0, mobileBlock.indexOf('\n}') + 2);
  assert.match(block, /\.menu-toggle\{display:flex\}/);
  assert.match(block, /\.sidebar\.open\{inset-inline-start:0\}/);
  assert.match(block, /\.main\{margin-inline-start:0\}/);
  // Closed state must push the sidebar fully off whatever viewport it's
  // given, not just to 0 — a leftover sliver would still crowd the content.
  assert.match(cssSource, /\.sidebar\{[^}]*inset-inline-start:-280px/);
});

test('the menu toggle is hidden on desktop by default (no ☰ button outside the mobile breakpoint)', () => {
  assert.match(cssSource, /\.menu-toggle\{\s*display:none;/);
});
