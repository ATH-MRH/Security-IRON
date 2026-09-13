'use strict';
// PG-19 — backend/ai/provider.js : l'interface AIProvider elle-même. Pas de
// base de données ici (architecture pure) : les fonctionnalités qui la
// consommeront réellement (PG-20 résumés, PG-21 assistant SOC) auront leurs
// propres tests avec périmètre/scope. Ce fichier prouve le contrat, la
// rédaction défensive, et que "l'IA est assistante, jamais autorité" reste
// vrai structurellement, pas seulement documenté.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../backend/ai/provider');

afterEach(() => ai.resetProvider()); // un provider de test ne doit jamais fuiter d'un test à l'autre

test('no real provider is wired by default: LocalAIProvider, simulated, no network dependency', async () => {
  assert.equal(ai.getProvider(), ai.LocalAIProvider);
  const r = await ai.complete({ prompt: 'Résume cette alerte' });
  assert.equal(r.provider, 'local');
  assert.equal(r.simulated, true);
  assert.match(r.text, /IA non configurée/);
  assert.ok(typeof r.generatedAt === 'string' && !Number.isNaN(Date.parse(r.generatedAt)));
});

test('complete() resolves quickly and deterministically: no real network call is ever made by the default provider', async () => {
  const start = Date.now();
  await ai.complete({ prompt: 'x' });
  assert.ok(Date.now() - start < 50, 'a real network call would never be this fast');
});

test('buildSafeContext redacts a forbidden key at any nesting depth, arrays included', () => {
  const context = {
    alert: { id: 'A1', site: 'S', password: 'hunter2', timeline: [{ action: 'ACQUITTEE', jwt: 'abc.def.ghi' }] },
    user: { username: 'agent', session_token: 'tok-123456789012345678901234567890123456789012345' },
  };
  const safe = ai.buildSafeContext(context);
  assert.equal(safe.alert.id, 'A1');
  assert.equal(safe.alert.site, 'S');
  assert.equal(safe.alert.password, undefined);
  assert.equal(safe.alert.timeline[0].action, 'ACQUITTEE');
  assert.equal(safe.alert.timeline[0].jwt, undefined);
  assert.equal(safe.user.session_token, undefined);
});

test('buildSafeContext also strips a long secret-looking VALUE even under an innocuous key', () => {
  // Same detection as backend/security-audit.js#sanitizeDetail: a forbidden
  // keyword found inside a long value (not just a key name) — e.g. a stray
  // "Authorization: Bearer …" string pasted into a free-text comment field.
  const safe = ai.buildSafeContext({ note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(safe.note, '[retiré]');
});

test('buildSafeContext(null) is null, never an error', () => {
  assert.equal(ai.buildSafeContext(null), null);
  assert.equal(ai.buildSafeContext(undefined), null);
});

test('complete() always redacts context before it ever reaches the active provider, even a spy provider', async () => {
  let received;
  ai.configureProvider({ name: 'spy', async complete(args) { received = args; return { text: 'ok', provider: 'spy', generatedAt: new Date().toISOString() }; } });
  await ai.complete({ prompt: 'Résume', context: { alert: { password_hash: 'x', level: 3 } } });
  assert.equal(received.context.alert.password_hash, undefined);
  assert.equal(received.context.alert.level, 3);
});

test('configureProvider rejects anything without a complete() method — the contract is enforced, not just documented', () => {
  assert.throws(() => ai.configureProvider(null), TypeError);
  assert.throws(() => ai.configureProvider({}), TypeError);
  assert.throws(() => ai.configureProvider({ complete: 'not a function' }), TypeError);
});

test('configureProvider swaps the active provider; resetProvider restores the local default', async () => {
  ai.configureProvider({ name: 'other', async complete() { return { text: 'from other', provider: 'other', generatedAt: new Date().toISOString() }; } });
  assert.equal((await ai.complete({ prompt: 'x' })).provider, 'other');
  ai.resetProvider();
  assert.equal(ai.getProvider(), ai.LocalAIProvider);
});

test('the AIProvider contract has no write/action method of any kind — only complete()', () => {
  // Structural check for "assistant, never authority": nothing on the
  // module surface could plausibly mutate an alert, only produce text.
  const surface = Object.keys(ai);
  for (const name of surface) {
    assert.doesNotMatch(name, /create|update|delete|act|write|mutate|transition/i, name + ' looks like a write/action capability');
  }
});
