'use strict';
/**
 * PG-30 (correctif de sécurité, revue RC — SSRF sur /api/camera/proxy) —
 * défense réseau en profondeur, appliquée même à une destination déjà
 * allowlistée par un opérateur (backend/camera-registry.js) : une erreur de
 * configuration ou une reliaison DNS (DNS rebinding) ne doit jamais suffire
 * à faire contacter au serveur une adresse sensible.
 *
 * Toujours refusées, quelle que soit la configuration caméra :
 *   - loopback (127.0.0.0/8, ::1)
 *   - non spécifiée (0.0.0.0/8, ::)
 *   - link-local (169.254.0.0/16, fe80::/10) — inclut les métadonnées cloud
 *     (169.254.169.254, souvent la cible n°1 d'une SSRF réelle)
 *   - multicast (224.0.0.0/4, ff00::/8) et broadcast (255.255.255.255)
 * Toujours AUTORISÉES par défaut : les plages RFC1918 (10/8, 172.16/12,
 * 192.168/16) et toute autre adresse unicast normale — une caméra de
 * vidéosurveillance vit légitimement sur un LAN privé ; les bloquer
 * aveuglément casserait l'usage normal du produit (voir docs/camera-proxy.md).
 * Aucune exception par caméra à la liste ci-dessus : aucun scénario caméra
 * légitime ne justifie une destination loopback/link-local/multicast.
 *
 * `guardedLookup` a exactement la signature attendue par l'option `lookup`
 * de http.request/https.request (Node) : l'adresse validée est donc celle
 * RÉELLEMENT utilisée pour la connexion TCP, pas une vérification séparée
 * suivie d'une résolution DNS distincte — ce qui laisserait une fenêtre de
 * reliaison DNS entre la vérification et la connexion.
 */
const dns = require('node:dns');
const net = require('node:net');

let lookupImpl = dns.lookup; // test-injectable, voir configureLookup

function configureLookup(fn) { lookupImpl = fn || dns.lookup; }
function resetLookup() { lookupImpl = dns.lookup; }

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const DENY_V4 = [
  ['127.0.0.0', 8],  // loopback
  ['0.0.0.0', 8],    // non spécifiée / "this network"
  ['169.254.0.0', 16], // link-local, inclut les métadonnées cloud
  ['224.0.0.0', 4],  // multicast
];
function isBlockedV4(ip) {
  if (ip === '255.255.255.255') return true;
  return DENY_V4.some(([base, bits]) => inCidr4(ip, base, bits));
}
function isBlockedV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 (link-local)
  if (lower.startsWith('ff')) return true;           // ff00::/8 (multicast)
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isBlockedV4(v4);
  }
  return false;
}
function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true; // adresse ni v4 ni v6 reconnue : refusée par prudence
}

// Vérification synchrone immédiate pour un hostname déjà littéral (une IP) :
// nécessaire car Node saute l'option `lookup` pour un hostname qui est déjà
// une adresse IP littérale (net.isIP() vrai) — sans ce contrôle explicite,
// une caméra configurée avec une IP littérale sensible échapperait à
// guardedLookup, qui ne serait alors jamais appelé pour elle.
function assertAllowedTarget(hostname) {
  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw Object.assign(new Error('Destination réseau refusée : ' + hostname), { code: 'ESSRFBLOCKED' });
  }
}

// Signature Node : lookup(hostname, options, callback) ou lookup(hostname, callback)
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (list.length === 0) return callback(Object.assign(new Error('Aucune adresse résolue'), { code: 'ENOTFOUND' }));
    const blocked = list.find(a => isBlockedAddress(a.address || a));
    if (blocked) {
      const addr = blocked.address || blocked;
      return callback(Object.assign(new Error('Destination réseau refusée : ' + addr), { code: 'ESSRFBLOCKED' }));
    }
    if (options.all) return callback(null, list);
    const first = list[0];
    callback(null, first.address || first, first.family || (net.isIPv6(first.address || first) ? 6 : 4));
  });
}

module.exports = { guardedLookup, assertAllowedTarget, isBlockedAddress, configureLookup, resetLookup };
