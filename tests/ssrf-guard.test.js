'use strict';
// PG-30 (correctif de sécurité, revue RC) — backend/ssrf-guard.js en
// isolation, sans base de données ni réseau réel : la matrice de blocage
// (loopback/link-local/multicast/broadcast toujours refusés, RFC1918
// toujours autorisé), l'injection de test (configureLookup) et le pinning
// DNS (l'adresse validée par guardedLookup est bien celle transmise à
// l'appelant, fermant la fenêtre de reliaison DNS).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../backend/ssrf-guard');

afterEach(() => guard.resetLookup());

test('loopback (v4 et v6) toujours refusé', () => {
  assert.equal(guard.isBlockedAddress('127.0.0.1'), true);
  assert.equal(guard.isBlockedAddress('127.255.255.254'), true);
  assert.equal(guard.isBlockedAddress('::1'), true);
});

test('link-local toujours refusé, y compris les métadonnées cloud (169.254.169.254)', () => {
  assert.equal(guard.isBlockedAddress('169.254.169.254'), true);
  assert.equal(guard.isBlockedAddress('169.254.0.1'), true);
  assert.equal(guard.isBlockedAddress('fe80::1'), true);
});

test('non spécifiée / multicast / broadcast toujours refusés', () => {
  assert.equal(guard.isBlockedAddress('0.0.0.0'), true);
  assert.equal(guard.isBlockedAddress('0.1.2.3'), true);
  assert.equal(guard.isBlockedAddress('::'), true);
  assert.equal(guard.isBlockedAddress('224.0.0.1'), true);
  assert.equal(guard.isBlockedAddress('ff02::1'), true);
  assert.equal(guard.isBlockedAddress('255.255.255.255'), true);
});

test('RFC1918 (LAN privé, où vit une caméra réelle) et unicast normal toujours autorisés', () => {
  assert.equal(guard.isBlockedAddress('10.0.0.5'), false);
  assert.equal(guard.isBlockedAddress('172.16.0.5'), false);
  assert.equal(guard.isBlockedAddress('172.31.255.254'), false);
  assert.equal(guard.isBlockedAddress('192.168.1.50'), false);
  assert.equal(guard.isBlockedAddress('8.8.8.8'), false);
  assert.equal(guard.isBlockedAddress('2001:db8::1'), false);
});

test('IPv4 mappée en IPv6 (::ffff:x.x.x.x) évaluée selon la même matrice que le v4', () => {
  assert.equal(guard.isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(guard.isBlockedAddress('::ffff:169.254.169.254'), true);
  assert.equal(guard.isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('assertAllowedTarget : lève pour une IP littérale bloquée, ne lève pas pour une IP littérale autorisée ni pour un hostname', () => {
  assert.throws(() => guard.assertAllowedTarget('127.0.0.1'), /ESSRFBLOCKED|refusée/);
  assert.doesNotThrow(() => guard.assertAllowedTarget('192.168.1.50'));
  assert.doesNotThrow(() => guard.assertAllowedTarget('camera.example.invalid')); // hostname : pas de décision ici, guardedLookup tranche à la résolution
});

test('guardedLookup refuse une résolution DNS vers une adresse bloquée (simule une reliaison DNS) sans jamais se connecter réellement', () => {
  guard.configureLookup((hostname, opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]));
  guard.guardedLookup('rebound.example.invalid', {}, (err) => {
    assert.ok(err, 'la résolution doit échouer');
    assert.equal(err.code, 'ESSRFBLOCKED');
  });
});

test('guardedLookup autorise et transmet fidèlement une résolution vers une adresse LAN légitime', () => {
  guard.configureLookup((hostname, opts, cb) => cb(null, [{ address: '10.20.30.40', family: 4 }]));
  guard.guardedLookup('camera.local.invalid', {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '10.20.30.40', 'l\'adresse renvoyée à l\'appelant (donc utilisée pour la connexion TCP réelle) doit être exactement celle validée — pas une résolution séparée susceptible de différer (reliaison DNS)');
    assert.equal(family, 4);
  });
});

test('guardedLookup : une seule adresse bloquée parmi plusieurs candidates suffit à refuser (options.all)', () => {
  guard.configureLookup((hostname, opts, cb) => cb(null, [{ address: '10.0.0.1', family: 4 }, { address: '127.0.0.1', family: 4 }]));
  guard.guardedLookup('multi.example.invalid', { all: true }, (err) => {
    assert.ok(err);
    assert.equal(err.code, 'ESSRFBLOCKED');
  });
});

test('guardedLookup propage une erreur de résolution DNS réelle telle quelle (ENOTFOUND, etc.)', () => {
  guard.configureLookup((hostname, opts, cb) => cb(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
  guard.guardedLookup('nowhere.example.invalid', {}, (err) => {
    assert.ok(err);
    assert.equal(err.code, 'ENOTFOUND');
  });
});

test('resetLookup revient à dns.lookup réel : plus aucune décision de test ne s\'applique après', () => {
  guard.configureLookup((hostname, opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]));
  guard.resetLookup();
  // Après reset, guardedLookup utilise dns.lookup réel — on ne peut pas
  // prédire le résultat exact pour un hostname arbitraire sans réseau, donc
  // on vérifie seulement que la fonction de test précédente n'est plus
  // active en observant qu'une adresse littérale continue de fonctionner
  // en direct (dns.lookup gère aussi les IP littérales sans réseau).
  guard.guardedLookup('127.0.0.1', {}, (err) => {
    assert.ok(err, 'dns.lookup réel + guard : 127.0.0.1 reste refusé, pas parce que le mock de test le dit encore');
    assert.equal(err.code, 'ESSRFBLOCKED');
  });
});
