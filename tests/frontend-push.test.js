'use strict';
// PCS01 (Lot B) — unit test of frontend/js/push.js in isolation: a
// controlled node:vm sandbox (fake navigator/Notification/serviceWorker/
// API), no real browser, no PostgreSQL. Proves: no capability is ever
// fabricated when the server has no real VAPID key configured (available:
// false must disable the whole flow before ever touching
// Notification.requestPermission or pushManager.subscribe), a denied
// permission never proceeds to subscribe, and enable()/disable() call the
// exact existing backend routes (POST/DELETE /push/subscribe) with the
// real PushSubscription shape — never a second, parallel mechanism.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/push.js'), 'utf8');

function harness({
  publicKey = null,
  permission = 'default',
  existingSubscription = null,
  subscribeBehavior = null,
  swReady = true,
} = {}) {
  const gets = [];
  const posts = [];
  const dels = [];
  let currentSub = existingSubscription;
  const pushManager = {
    getSubscription: async () => currentSub,
    subscribe: async (opts) => {
      if (subscribeBehavior) return subscribeBehavior(opts);
      currentSub = {
        endpoint: 'https://push.example/ep-1',
        toJSON: () => ({ endpoint: 'https://push.example/ep-1', keys: { p256dh: 'a', auth: 'b' } }),
        unsubscribe: async () => { currentSub = null; return true; },
      };
      return currentSub;
    },
  };
  const registration = { pushManager };
  const notification = { permission, requestPermission: async () => permission };
  const sandbox = {
    console,
    navigator: swReady ? { serviceWorker: { ready: Promise.resolve(registration) } } : {},
    // Mirrors real-browser semantics (window IS the global scope, so
    // window.Notification === the bare Notification global) — push.js's
    // supported() checks `'X' in window`, so a sandbox where `window` is a
    // plain object disconnected from the true globals would wrongly report
    // "unsupported" even when every capability is actually present.
    window: { PushManager: function () {}, Notification: notification },
    Notification: notification,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    API: {
      get: async (p) => { gets.push(p); if (p === '/push/public-key') return { publicKey }; throw new Error('unexpected GET ' + p); },
      post: async (p, b) => { posts.push({ p, b }); return { ok: true }; },
      del: async (p, b) => { dels.push({ p, b }); return { ok: true }; },
    },
  };
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: 'push.js' }).runInContext(context);
  const run = expr => new vm.Script(expr).runInContext(context);
  return {
    status: () => run('PushSubscribe.status()'),
    enable: () => run('PushSubscribe.enable()'),
    disable: () => run('PushSubscribe.disable()'),
    supported: () => run('PushSubscribe.supported()'),
    gets, posts, dels,
    currentSub: () => currentSub,
  };
}

test('supported() is false when serviceWorker/PushManager/Notification are missing (older/unsupported browser)', () => {
  const context = vm.createContext({ navigator: {}, window: {} });
  new vm.Script(source, { filename: 'push.js' }).runInContext(context);
  const supported = new vm.Script('PushSubscribe.supported()').runInContext(context);
  assert.equal(supported, false);
});

test('status() reports available:false when the server has no real VAPID key configured — never a fabricated capability', async () => {
  const h = harness({ publicKey: null });
  const s = await h.status();
  assert.equal(s.available, false);
  assert.equal(s.supported, true);
});

test('status() reports available:true and the current permission/subscription state when a real key exists', async () => {
  const h = harness({ publicKey: 'real-key', permission: 'granted', existingSubscription: { endpoint: 'x' } });
  const s = await h.status();
  assert.equal(s.available, true);
  assert.equal(s.permission, 'granted');
  assert.equal(s.subscribed, true);
});

test('enable() refuses outright when no real VAPID key is configured — never calls Notification.requestPermission at all', async () => {
  const h = harness({ publicKey: null });
  await assert.rejects(h.enable(), /pas encore activées/i);
  assert.equal(h.posts.length, 0);
});

test('enable() refuses when the user denies the permission prompt — never subscribes anyway', async () => {
  const h = harness({ publicKey: 'real-key', permission: 'denied' });
  await assert.rejects(h.enable(), /refusée/i);
  assert.equal(h.posts.length, 0);
});

test('enable() with a real key and granted permission subscribes and posts the real PushSubscription JSON to the existing backend route', async () => {
  const h = harness({ publicKey: 'real-key', permission: 'granted' });
  const ok = await h.enable();
  assert.equal(ok, true);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].p, '/push/subscribe');
  assert.equal(h.posts[0].b.endpoint, 'https://push.example/ep-1');
});

test('disable() with no existing subscription is a harmless no-op — never calls unsubscribe/DELETE', async () => {
  const h = harness({ publicKey: 'real-key', existingSubscription: null });
  const ok = await h.disable();
  assert.equal(ok, true);
  assert.equal(h.dels.length, 0);
});

test('disable() with an existing subscription unsubscribes locally and calls DELETE /push/subscribe with that exact endpoint', async () => {
  const sub = {
    endpoint: 'https://push.example/ep-existing',
    unsubscribe: async () => true,
  };
  const h = harness({ publicKey: 'real-key', existingSubscription: sub });
  const ok = await h.disable();
  assert.equal(ok, true);
  assert.equal(h.dels.length, 1);
  assert.equal(h.dels[0].p, '/push/subscribe');
  assert.equal(h.dels[0].b.endpoint, 'https://push.example/ep-existing');
});

test('the module never reads or embeds a real key itself — it only ever forwards what GET /push/public-key returns', () => {
  assert.doesNotMatch(source, /BEGIN PUBLIC KEY|-----|VAPID_PUBLIC/i);
  assert.match(source, /API\.get\('\/push\/public-key'\)/);
});
