/**
 * PCS01 (Lot B) — abonnement Web Push côté navigateur. Le backend
 * (backend/push.js, PG-13) et le service worker (frontend/sw.js) existent
 * déjà et sont prêts ; ce module est le premier client à les utiliser
 * réellement.
 *
 * Aucune clé VAPID réelle n'est activée en production à ce jour (voir
 * docs/push.md — HUMAN CHECKPOINT). GET /api/push/public-key renvoie donc
 * `publicKey: null` : ce module le détecte et affiche les notifications
 * hors-application comme indisponibles — jamais une capacité fabriquée.
 * Le jour où un fournisseur réel est activé (Lot D), ce même code
 * fonctionne sans modification.
 */
const PushSubscribe = (() => {
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  // Web Push exige une clé au format Uint8Array, la clé publique VAPID
  // arrive en base64url standard (RFC 8292) — conversion sans dépendance.
  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64Safe);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function status() {
    if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false, available: false };
    const { publicKey } = await API.get('/push/public-key');
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    return {
      supported: true, available: Boolean(publicKey),
      permission: Notification.permission, subscribed: Boolean(sub), publicKey,
    };
  }

  async function enable() {
    if (!supported()) throw new Error('Notifications non supportées par ce navigateur');
    const { publicKey } = await API.get('/push/public-key');
    if (!publicKey) throw new Error('Notifications push pas encore activées côté serveur');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Permission refusée');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await API.post('/push/subscribe', sub.toJSON());
    return true;
  }

  async function disable() {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    if (!sub) return true;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await API.del('/push/subscribe', { endpoint }).catch(() => {});
    return true;
  }

  return { supported, status, enable, disable };
})();
