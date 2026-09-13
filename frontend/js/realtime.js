/**
 * PG-16 — client temps réel du SOC : consomme le flux SSE de PG-12
 * (backend/realtime.js) via le mécanisme de ticket à usage unique (PG-12 —
 * EventSource ne peut pas envoyer d'en-tête Authorization). N'affirme jamais
 * le contenu d'un événement : chaque notification ne fait que déclencher un
 * rechargement via l'API déjà autorisée (own/scope, PG-8) — jamais de
 * confiance dans la charge utile SSE elle-même.
 *
 * Reconnexion : un ticket est à usage unique et expire (30 s, PG-12) —
 * EventSource ne peut donc pas se reconnecter lui-même avec la même URL en
 * cas de coupure ; sur `error`, on ferme la connexion et on en établit une
 * nouvelle avec un ticket frais après un délai.
 *
 * Repli (fallback) : si le flux n'est pas joignable (navigateur sans
 * EventSource, ticket refusé, réseau coupé), un minuteur de repli émet un
 * événement générique 'poll' à intervalle régulier — les abonnés (tableau de
 * bord, cloche de notifications, centre d'alertes) l'utilisent pour se
 * rafraîchir même sans le flux, dégradant proprement plutôt que silencieusement.
 */
const Realtime = (() => {
  const RECONNECT_MS = 5000;
  const FALLBACK_POLL_MS = 15000;
  let source = null, reconnectTimer = null, fallbackTimer = null;
  let connected = false, stopped = true;
  const listeners = new Set();

  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(type, data) { for (const fn of listeners) { try { fn(type, data); } catch { /* un abonné ne doit jamais casser les autres */ } } }

  function startFallback() {
    if (fallbackTimer || stopped) return;
    fallbackTimer = setInterval(() => emit('poll', null), FALLBACK_POLL_MS);
  }
  function stopFallback() {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  }
  function scheduleReconnect() {
    if (reconnectTimer || stopped) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
  }

  function attach(es) {
    source = es;
    const onEvent = type => e => { connected = true; stopFallback(); let data = null; try { data = JSON.parse(e.data); } catch { /* charge utile inattendue : ignorée, jamais fatale */ } emit(type, data); };
    es.addEventListener('alert:created', onEvent('alert:created'));
    es.addEventListener('alert:updated', onEvent('alert:updated'));
    es.onopen = () => { connected = true; stopFallback(); };
    es.onerror = () => {
      connected = false;
      try { es.close(); } catch { /* déjà fermé */ }
      if (source === es) source = null;
      if (stopped) return;
      startFallback(); // reste utilisable pendant la tentative de reconnexion
      scheduleReconnect();
    };
  }

  async function connect() {
    stopped = false;
    if (!('EventSource' in window)) { startFallback(); return; }
    try {
      const { ticket } = await API.post('/realtime/ticket', {});
      if (stopped) return;
      attach(new EventSource('/api/realtime/stream?ticket=' + encodeURIComponent(ticket)));
    } catch {
      startFallback();
      scheduleReconnect();
    }
  }

  function stop() {
    stopped = true;
    if (source) { try { source.close(); } catch { /* ignore */ } source = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopFallback();
    connected = false;
  }

  function isConnected() { return connected; }

  return { connect, stop, on, isConnected };
})();
