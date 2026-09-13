'use strict';
// PG-25 (hardening) — regression guards for three stored-XSS findings fixed
// in frontend/js/app.js: (1) pietons row injected the WHOLE record via
// onclick='editPieton(${JSON.stringify(p)})' — nom/point/notes are
// unvalidated free text (POST /pietons), and a single quote in any of them
// broke out of the single-quoted onclick attribute; (2) LAPI history/table
// rendered plaque_detectee/image/confiance/statut/action (all free text,
// POST /lapi) without escapeHtml(); (3) the badges table rendered `ref`
// (can be caller-supplied, POST /badges) unescaped in both a text cell and
// two onclick attributes.
//
// app.js is a 1000+-line, DOM-heavy monolith with no existing sandboxing
// harness (unlike alerts.js) — fully mocking renderPietons()/
// renderLapiHistory()/renderBadges() end-to-end is disproportionate to
// prove three specific, already-identified patterns. A source-level
// regression check is the pragmatic, still-meaningful tool here: it fails
// loudly if the dangerous pattern is ever reintroduced, and passes only
// once the safe replacement is genuinely in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../frontend/js/app.js'), 'utf8');

test('no onclick attribute ever embeds a raw JSON.stringify() of a data record', () => {
  // This exact shape (onclick='fn(${JSON.stringify(row)})') is what made
  // the pietons row exploitable: JSON.stringify() never escapes a literal
  // single quote, and the attribute itself was single-quote-delimited.
  assert.doesNotMatch(source, /onclick=['"][a-zA-Z_]+\(\$\{JSON\.stringify/);
});

test('editPieton takes only an opaque id and looks the record up from cache — never receives raw fields inline', () => {
  assert.match(source, /function editPieton\(id\)\{\s*const p=\(cache\.pietons\|\|\[\]\)\.find\(x=>x\.id===id\)/);
  assert.match(source, /onclick="editPieton\('\$\{p\.id\}'\)"/);
  assert.doesNotMatch(source, /editPieton\(p\)/);
});

test('the pietons table cell for badge is escaped (was raw <code>${p.badge}</code>)', () => {
  assert.match(source, /<code>\$\{escapeHtml\(p\.badge\|\|''\)\}<\/code>/);
});

test('LAPI thumbnails escape both the image src attribute and the plate text', () => {
  assert.match(source, /<img src="\$\{escapeHtml\(l\.image\|\|''\)\}"/);
  assert.match(source, /<div class="plate-tag">\$\{escapeHtml\(l\.plaque_detectee\|\|'\?'\)\}<\/div>/);
});

test('the LAPI table escapes plate/confidence/status/action, all free text from POST /lapi', () => {
  assert.match(source, /<strong>\$\{escapeHtml\(l\.plaque_detectee\|\|'\?'\)\}<\/strong>/);
  assert.match(source, /escapeHtml\(String\(l\.confiance/);
  assert.match(source, /escapeHtml\(l\.statut\|\|''\)/);
  assert.match(source, /escapeHtml\(l\.action\)/);
});

test('the badges table escapes ref (caller-suppliable via POST /badges) in text and in every onclick using it', () => {
  assert.match(source, /const ref = escapeHtml\(b\.ref\)/);
  assert.match(source, /onclick="reimprimerBadge\('\$\{ref\}'\)"/);
  assert.match(source, /onclick="desactiverBadge\('\$\{ref\}'\)"/);
  assert.match(source, /onclick="deleteBadge\('\$\{ref\}'\)"/);
});

test('none of the three fixed render functions interpolate a raw record field without escapeHtml, String(), or a known-safe id/enum', () => {
  // Direct proof that the historical vulnerable literals are gone verbatim.
  assert.doesNotMatch(source, /onclick='editPieton\(\$\{JSON\.stringify\(p\)\}\)'/);
  assert.doesNotMatch(source, /<img src="\$\{l\.image\|\|''\}"/);
  assert.doesNotMatch(source, /<div class="plate-tag">\$\{l\.plaque_detectee\|\|'\?'\}<\/div>/);
  assert.doesNotMatch(source, /<strong>\$\{l\.plaque_detectee\|\|'\?'\}<\/strong>/);
  assert.doesNotMatch(source, /<td>\$\{l\.confiance\}%<\/td>/);
  assert.doesNotMatch(source, /<strong>\$\{b\.ref\}<\/strong>/);
});
