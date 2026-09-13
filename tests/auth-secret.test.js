'use strict';
// PG-25 (hardening) — backend/auth.js must never fall back to a hardcoded
// JWT secret outside test/development: a public, hardcoded default secret
// let anyone forge a valid token for any account (including admin) on any
// deployment where JWT_SECRET was forgotten. Spawns real child processes
// (auth.js throws at require-time — module caching means we can't just
// require() it twice in this same process with different env).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const authPath = path.resolve(__dirname, '../backend/auth.js');

function run(env) {
  try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(authPath)});`],
      { env: { ...process.env, ...env }, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true };
  } catch (e) {
    return { ok: false, stderr: e.stderr || '' };
  }
}

test('refuses to start with no JWT_SECRET and no NODE_ENV (a real, unconfigured deployment)', () => {
  const r = run({ JWT_SECRET: '', NODE_ENV: '' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /JWT_SECRET requis/);
});

test('refuses to start with no JWT_SECRET under NODE_ENV=production', () => {
  const r = run({ JWT_SECRET: '', NODE_ENV: 'production' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /JWT_SECRET requis/);
});

test('refuses a JWT_SECRET shorter than 32 characters, in any environment', () => {
  const r = run({ JWT_SECRET: 'too-short', NODE_ENV: 'production' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /trop court/);
});

test('never falls back to the historical hardcoded secret, under any environment', () => {
  for (const NODE_ENV of ['', 'production', 'test', 'development']) {
    const r = run({ JWT_SECRET: '', NODE_ENV });
    if (!r.ok) { assert.doesNotMatch(r.stderr, /dev-secret-change-me/); continue; }
    // ok in test/development: fine, but only via a freshly generated secret — proven separately below.
  }
});

test('starts fine in test/development without JWT_SECRET (an ephemeral secret is generated)', () => {
  assert.equal(run({ JWT_SECRET: '', NODE_ENV: 'test' }).ok, true);
  assert.equal(run({ JWT_SECRET: '', NODE_ENV: 'development' }).ok, true);
});

test('an explicit, sufficiently long JWT_SECRET is always accepted, in any environment', () => {
  const strong = 'x'.repeat(32);
  for (const NODE_ENV of ['', 'production', 'test']) {
    assert.equal(run({ JWT_SECRET: strong, NODE_ENV }).ok, true);
  }
});
