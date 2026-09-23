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
const CACHE_VERSION = 'securisite-shell-v19';
const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'css/alerts.css',
  'js/api.js',
  'js/ui.js',
  'js/realtime.js',
  'js/soc-kpis.js',
  'js/map-provider.js',
  'js/map.js',
  'js/alerts.js',
  'js/notifications.js',
  'js/sos.js',
  'js/critical-alert.js',
  'js/push.js',
  'js/maincourante-workflows.js',
  'js/admin-system.js',
  'js/app.js',
  'assets/iron-global-securite-logo.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png',
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

// BUG BLOQUANT (Groupes → Ouvrir, LOT GROUPES) — cause racine reproduite et
// prouvée en navigateur réel (profil Playwright persistant) : la stratégie
// cache-first précédente (`cached || network`, réseau en arrière-plan
// seulement) servait TOUJOURS la version en cache tant qu'aucun nouveau
// install()/activate() n'avait eu lieu — soit à CHAQUE modification de
// fichier qui ne changeait pas CACHE_VERSION (le cas normal en itération
// locale), soit même juste après un bump de CACHE_VERSION, le PREMIER
// rechargement d'un onglet déjà ouvert servait encore l'ancien cache pendant
// que le réseau le rafraîchissait silencieusement en arrière-plan — il
// fallait systématiquement DEUX rechargements avant qu'un correctif serveur
// devienne visible. Reproduit précisément : un admin-system.js cassé
// volontairement (référence non définie) servi une première fois reste
// servi identique au rechargement suivant MÊME APRÈS correction du fichier
// sur le serveur ; seul un second rechargement révèle le correctif. C'est
// cette fenêtre qui explique qu'un onglet resté ouvert pendant les
// itérations puisse afficher une sidebar à jour (index.html) mais un
// admin-system.js pas encore rafraîchi (fichiers mis en cache
// indépendamment, pas atomiquement) — un clic sur "Ouvrir" appelant alors
// une fonction manquante/obsolète, silencieusement.
//
// Correctif minimal : réseau EN PREMIER, cache uniquement en repli (hors
// ligne, ou échec réseau) — jamais l'inverse. Un rechargement en ligne voit
// donc toujours le code réellement servi par le serveur, sans délai d'un
// cycle ; le mode hors-ligne (raison d'être initiale du cache) reste
// couvert par le .catch(). Pour une application de sûreté, servir du code
// à jour prime sur le gain de vitesse d'un cache-first.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never our own origin's /api/*, and never a cross-origin request (a proxied
  // camera stream, an external resource): only the app shell is cached.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // offline (or network failure): fall back to cache
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

// PCS01 (Lot B) : ouvre/reprend le focus, puis pointe précisément sur
// l'alerte concernée — jamais juste "l'app générique". Une fenêtre déjà
// ouverte reçoit l'id par postMessage (frontend/js/app.js l'écoute) ; sans
// fenêtre, ?alert=<id> sur l'URL d'ouverture, lu au chargement.
self.addEventListener('notificationclick', event => {
  const alertId = event.notification.data && event.notification.data.id;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) if ('focus' in client) { client.postMessage({ type: 'securisite:open-alert', id: alertId }); return client.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(alertId ? './?alert=' + encodeURIComponent(alertId) : './');
    })
  );
});
