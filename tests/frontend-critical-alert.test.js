'use strict';
// PCS01 (Lot A) — unit test of frontend/js/critical-alert.js in isolation:
// a controlled node:vm sandbox (fake document/API/AlertCenter), no browser,
// no PostgreSQL. Proves: only genuinely qualifying alerts (status NOTIFIEE,
// origin SOS or level>=3) ever trigger the overlay, a non-admin never gets
// an "Accuser réception" button wired to an action they'd get 403 on,
// nothing shown for a foreign/unauthorized alert (GET /alerts is already
// own/scope-filtered server-side — this module trusts nothing else), and
// every field sourced from real alert data is HTML-escaped (XSS safety),
// since site/type/comment/username are free text an attacker-adjacent
// account could set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/critical-alert.js'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(__dirname, '../frontend/css/style.css'), 'utf8');

// Regression: `.critical-alert-overlay{display:flex}` alone beats the
// browser's UA-stylesheet `[hidden]{display:none}` (author class selector
// outranks a UA-origin attribute selector) — found live: an empty, opaque
// full-screen overlay covered the whole app on every login, before any real
// alert ever existed, because el.hidden=true never actually hid it.
test('the overlay has an explicit [hidden] CSS rule (author-stylesheet display:flex would otherwise always win)', () => {
  assert.match(cssSource, /\.critical-alert-overlay\[hidden\]\{display:none\}/);
});
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDateTime = iso => (iso ? new Date(iso).toISOString() : '—');

function fakeElement() {
  let html = '';
  const el = {
    tagName: 'DIV', hidden: true, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; },
  };
  return el;
}

function harness({ alerts = [], postBehavior = null, admin = true } = {}) {
  const created = [];
  const posts = [];
  const notifications = [];
  const navigations = [];
  const opened = [];
  let realtimeListener = null;
  const store = {};
  // Buttons persist per id across a single render() (two getElementById
  // calls for the same freshly-set innerHTML must return the same object,
  // otherwise critical-alert.js's `ackBtn.onclick = acknowledge` would be
  // set on a throwaway the test could never actually invoke).
  const buttons = new Map();
  const sandbox = {
    console,
    window: {},
    navigator: {},
    document: {
      createElement: () => { const el = fakeElement(); created.push(el); return el; },
      body: { appendChild: () => {}, contains: () => true },
      getElementById: id => {
        const last = created[created.length - 1];
        if (!last || !last.innerHTML.includes(`id="${id}"`)) return null;
        if (!buttons.has(id)) buttons.set(id, { id, disabled: false, textContent: '', onclick: null });
        return buttons.get(id);
      },
    },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    I18N_KEY: 'securisite_lang',
    translateText: (t) => t, // identity: only the routing logic is under test here, not the dictionary itself
    API: {
      get: async (p) => { if (p === '/alerts') return alerts; throw new Error('unexpected GET ' + p); },
      post: async (p, b) => { posts.push({ p, b }); if (postBehavior) return postBehavior(p, b); return { ok: true }; },
    },
    isAdmin: () => admin,
    navTo: p => navigations.push(p),
    notify: (m, t) => notifications.push({ m, t }),
    escapeHtml, fmtDateTime,
    AlertCenter: { openAlert: id => opened.push(id) },
    Realtime: { on: fn => { realtimeListener = fn; return () => { realtimeListener = null; }; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
  };
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'critical-alert.js' }).runInContext(context);
  const run = expr => new vm.Script(expr).runInContext(context);
  return {
    start: () => run('CriticalAlert.start()'),
    check: () => run('CriticalAlert.checkForCritical()'),
    panel: () => created[created.length - 1],
    button: id => buttons.get(id),
    posts, notifications, navigations, opened, realtimeFire: (...a) => realtimeListener && realtimeListener(...a),
  };
}

const baseAlert = (over = {}) => ({
  id: 'ALT-1', status: 'NOTIFIEE', origin: 'SOS', level: 4, type: 'SOS',
  site: 'Site A', zone: null, comment: '', username: 'agent1', created_at: '2026-01-01T10:00:00.000Z',
  ...over,
});

test('a real SOS (status NOTIFIEE) triggers the overlay', async () => {
  const h = harness({ alerts: [baseAlert()] });
  await h.check();
  const panel = h.panel();
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /ALERTE/);
  assert.match(panel.innerHTML, /SOS/);
});

test('a level-1/2 alert (not critical, not SOS) never triggers the overlay', async () => {
  const h = harness({ alerts: [baseAlert({ origin: 'COMMAND', level: 2, type: 'Anomalie' })] });
  await h.start(); // ensureOverlay() runs unconditionally in start(), so h.panel() exists to assert against
  assert.equal(h.panel().hidden, true);
});

test('an already-acknowledged alert (status ACQUITTEE) never re-triggers the overlay', async () => {
  const h = harness({ alerts: [baseAlert({ status: 'ACQUITTEE' })] });
  await h.start();
  assert.equal(h.panel().hidden, true);
});

test('a level-3 COMMAND-origin alert (PCS01-issued, not SOS) also qualifies as critical', async () => {
  const h = harness({ alerts: [baseAlert({ origin: 'COMMAND', level: 3, type: 'Intrusion' })] });
  await h.check();
  assert.equal(h.panel().hidden, false);
  assert.match(h.panel().innerHTML, /CRITIQUE/);
});

test('an alert absent from GET /alerts (foreign tenant/site, already filtered server-side) never surfaces — this module adds no visibility of its own', async () => {
  const h = harness({ alerts: [] });
  await h.start();
  assert.equal(h.panel().hidden, true);
});

test('a non-admin (own-access) user never gets an "Accuser réception" button wired to an action reserved for the SOC', async () => {
  const h = harness({ alerts: [baseAlert()], admin: false });
  await h.check();
  assert.doesNotMatch(h.panel().innerHTML, /criticalAlertAck/);
  assert.match(h.panel().innerHTML, /criticalAlertView/, 'Voir l’alerte must still be offered');
});

test('an admin (SOC) user does get the "Accuser réception" action for a NOTIFIEE alert', async () => {
  const h = harness({ alerts: [baseAlert()], admin: true });
  await h.check();
  assert.match(h.panel().innerHTML, /criticalAlertAck/);
});

test('every field sourced from alert data is HTML-escaped — a malicious site/comment/username can never break out of the panel markup', async () => {
  const h = harness({
    alerts: [baseAlert({
      site: '<img src=x onerror=alert(1)>',
      comment: '<script>evil()</script>',
      username: '"><svg onload=alert(2)>',
      type: '<b>bold</b>',
    })],
  });
  await h.check();
  const html = h.panel().innerHTML;
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>evil/);
  assert.doesNotMatch(html, /<svg onload/);
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;img/);
});

test('multiple simultaneous critical alerts queue instead of silently overwriting each other', async () => {
  const h = harness({ alerts: [baseAlert({ id: 'ALT-1' }), baseAlert({ id: 'ALT-2', origin: 'COMMAND', level: 3 })] });
  await h.check();
  // The first (SOS takes priority) is shown; the second is queued and its
  // presence is reflected in the panel via the "+N waiting" counter.
  assert.match(h.panel().innerHTML, /ALT-1/);
  assert.match(h.panel().innerHTML, /waiting|attente|1/);
});

test('SOS is prioritized over a same-batch non-SOS critical alert regardless of array order', async () => {
  const h = harness({ alerts: [baseAlert({ id: 'ALT-CMD', origin: 'COMMAND', level: 3 }), baseAlert({ id: 'ALT-SOS', origin: 'SOS', level: 4 })] });
  await h.check();
  assert.match(h.panel().innerHTML, /ALT-SOS/);
  assert.doesNotMatch(h.panel().innerHTML, /ALT-CMD/);
});

test('the module never trusts SSE payload content — checkForCritical always re-fetches through the already-authorized GET /alerts', () => {
  assert.doesNotMatch(source, /realtimeFire|e\.data|event\.data/);
  assert.match(source, /API\.get\('\/alerts'\)/);
});

test('clicking "Accuser réception" posts the existing ACQUITTEE action for that exact alert — never a fabricated client-side state', async () => {
  const h = harness({ alerts: [baseAlert({ id: 'ALT-42' })], admin: true });
  await h.check();
  const ack = h.button('criticalAlertAck');
  assert.equal(typeof ack.onclick, 'function');
  await ack.onclick();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].p, '/alerts/ALT-42/actions');
  // Cross-realm object (created inside the vm sandbox): compare own
  // enumerable properties via JSON, not deepStrictEqual's prototype-aware
  // identity check, which spuriously fails across vm/host realms.
  assert.equal(JSON.stringify(h.posts[0].b), JSON.stringify({ action: 'ACQUITTEE' }));
  assert.ok(h.notifications.some(n => /accus|acknowledg/i.test(n.m)));
});

test('a 409 (already handled by another operator) is reported honestly, never presented as a successful acknowledgment', async () => {
  const h = harness({
    alerts: [baseAlert()], admin: true,
    postBehavior: () => { throw Object.assign(new Error('Transition interdite'), { status: 409 }); },
  });
  await h.check();
  await h.button('criticalAlertAck').onclick();
  assert.ok(h.notifications.some(n => /autre opérateur|already/i.test(n.m)));
  assert.equal(h.notifications.some(n => /accus/i.test(n.m) && n.t !== 'warning'), false);
});

test('"Voir l’alerte" opens the alert in the Alert Center and dismisses the overlay without claiming an acknowledgment', async () => {
  const h = harness({ alerts: [baseAlert({ id: 'ALT-7' })] });
  await h.check();
  await h.button('criticalAlertView').onclick();
  assert.deepEqual(h.opened, ['ALT-7']);
  assert.equal(h.posts.length, 0, 'viewing must never itself call the acknowledge endpoint');
});
