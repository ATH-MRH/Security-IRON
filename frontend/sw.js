'use strict';
/**
 * PG-14 — service worker minimal : app shell installable/hors-ligne, et
 * gestionnaires push/notificationclick prêts pour PG-13 (backend/push.js).
 * Aucun fournisseur push réel n'est encore activé (voir docs/push.md) :
 * ces gestionnaires restent inertes tant qu'aucun abonnement réel n'existe,
 * mais le code est prêt — rien à ajouter ici le jour de l'activation.
 *
 * /api/* n'est JAMAIS intercepté : ces réponses sont dynamiques et
 * authentifiées, les mettre en cache serait activement dangereux pour une
 * application de sûreté (données périmées, fuite entre sessions sur un
 * poste partagé). Seul l'app shell (HTML/CSS/JS/manifest/icône/vendor
 * statique) est mis en cache.
 */
const CACHE_VERSION = 'securisite-shell-v1';
const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'css/alerts.css',
  'js/api.js',
  'js/ui.js',
  'js/alerts.js',
  'js/notifications.js',
  'js/sos.js',
  'js/app.js',
  'assets/iron-global-securite-logo.png',
  'vendor/chart.umd.min.js',
  'vendor/qrcode.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE_VERSION).map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never our own origin's /api/*, and never a cross-origin request (a proxied
  // camera stream, an external resource): only the app shell is cached.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to whatever is cached, if anything
      // Cache-first when available (instant, works offline); still refreshes
      // the cache in the background so the next load picks up changes.
      return cached || network;
    })
  );
});

// PG-13 : la charge utile ne porte jamais que {type, id, at} — jamais le
// contenu de la ressource (backend/push.js). La notification reste générique ;
// un clic ouvre/reprend le focus sur l'application, qui recharge la ressource
// réelle via l'API déjà autorisée.
self.addEventListener('push', event => {
  let data = { type: 'alert', id: null, at: null };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* payload non-JSON : notification générique */ }
  const title = data.type === 'alert:created' ? 'Nouvelle alerte SécuriSite'
    : data.type === 'alert:updated' ? 'Alerte SécuriSite mise à jour'
    : 'SécuriSite';
  event.waitUntil(self.registration.showNotification(title, {
    body: 'Ouvrir le centre d’alertes pour les détails.',
    icon: 'assets/iron-global-securite-logo.png',
    badge: 'assets/iron-global-securite-logo.png',
    tag: data.id ? 'securisite-' + data.id : 'securisite',
    data,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) if ('focus' in client) return client.focus();
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
