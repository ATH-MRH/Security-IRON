'use strict';
// PCS01 (Lot D) — backend/push/web-push-provider.js : fournisseur Web Push
// réel (VAPID), contrat identique à backend/push/fake-provider.js (voir
// backend/push.js#setProvider). Aucune base de données requise ici : la
// seule dépendance externe (le module `web-push`) est monkey-patchée pour
// exercer les trois issues possibles de send() sans réseau réel — la
// livraison réelle de bout en bout (Playwright, vraie clé VAPID, vrai
// navigateur) est vérifiée séparément, hors suite automatisée (voir le
// rapport de vérification du lot).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const provider = require('../backend/push/web-push-provider');

const keys = webpush.generateVAPIDKeys();
const subscription = { endpoint: 'https://push.example/ep', keys: { p256dh: 'p', auth: 'a' } };

test('configureFromEnv: any of the three VAPID variables missing leaves the real provider inactive (HUMAN CHECKPOINT, docs/push.md)', () => {
  assert.equal(provider.configureFromEnv({}), false);
  assert.equal(provider.configureFromEnv({ SECURISITE_VAPID_PUBLIC_KEY: keys.publicKey }), false);
  assert.equal(provider.configureFromEnv({ SECURISITE_VAPID_PUBLIC_KEY: keys.publicKey, SECURISITE_VAPID_PRIVATE_KEY: keys.privateKey }), false);
});

test('configureFromEnv: all three variables present activates it (real VAPID keys, valid format required by web-push itself)', () => {
  assert.equal(provider.configureFromEnv({
    SECURISITE_VAPID_PUBLIC_KEY: keys.publicKey,
    SECURISITE_VAPID_PRIVATE_KEY: keys.privateKey,
    SECURISITE_VAPID_SUBJECT: 'mailto:soc@example.test',
  }), true);
});

test('send(): a successful delivery to the browser push service resolves {ok:true}', async t => {
  t.mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201 }));
  assert.deepEqual(await provider.send(subscription, 'payload'), { ok: true });
});

test('send(): a dead subscription (404/410 from the push service) resolves {ok:false, expired:true} — the only case backend/push.js#deliverFor deletes the row for', async t => {
  for (const statusCode of [404, 410]) {
    t.mock.method(webpush, 'sendNotification', async () => { throw Object.assign(new Error('gone'), { statusCode }); });
    assert.deepEqual(await provider.send(subscription, 'payload'), { ok: false, expired: true });
  }
});

test('send(): any other failure (network, throttling, malformed key…) resolves {ok:false} without expired — never thrown, exactly like fake-provider.js', async t => {
  t.mock.method(webpush, 'sendNotification', async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); });
  assert.deepEqual(await provider.send(subscription, 'payload'), { ok: false, expired: false });

  t.mock.method(webpush, 'sendNotification', async () => { throw new TypeError('network unreachable'); });
  assert.deepEqual(await provider.send(subscription, 'payload'), { ok: false, expired: false });
});
