'use strict';
// Production incident follow-up: the login screen shipped to
// security.irongs.com displayed "DÉMO : admin / securisite" and pre-filled
// the actual demo credentials into the username/password inputs — visible
// to anyone reaching the login page, in production. Source-level regression
// guard, same style as tests/frontend-xss-hardening.test.js: no rendering
// harness exists for this static login markup, and a direct text check on
// the shipped file is exactly what would have caught this before it reached
// production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8');
const ui = fs.readFileSync(path.resolve(__dirname, '../frontend/js/ui.js'), 'utf8');

test('the login screen never displays demo credentials', () => {
  assert.doesNotMatch(html, /D[ÉE]MO\s*:?\s*admin\s*\/\s*securisite/i);
});

test('the login username/password inputs carry no pre-filled value', () => {
  const loginUser = html.match(/<input[^>]*id="loginUser"[^>]*>/);
  const loginPass = html.match(/<input[^>]*id="loginPass"[^>]*>/);
  assert.ok(loginUser, 'loginUser input present');
  assert.ok(loginPass, 'loginPass input present');
  assert.doesNotMatch(loginUser[0], /\bvalue\s*=/);
  assert.doesNotMatch(loginPass[0], /\bvalue\s*=/);
});

test('the i18n dictionary carries no translation of the removed demo-credentials string', () => {
  assert.doesNotMatch(ui, /D[ÉE]MO\s*:\s*admin\s*\/\s*securisite/i);
});
