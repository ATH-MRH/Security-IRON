'use strict';
/**
 * PG-13 — service central push : point d'écriture unique pour
 * `push_subscriptions`, et seul consommateur du fournisseur actif
 * (backend/push/fake-provider.js par défaut — voir son en-tête pour la
 * décision de ne pas activer de fournisseur réel dans cette passe). Écoute
 * le même bus que backend/realtime.js (PG-12) : SSE et push sont deux
 * consommateurs indépendants du même flux d'événements, aucune duplication
 * de logique de déclenchement dans alert-core/service.js.
 */
const db = require('./database');
const scope = require('./scope');
const realtime = require('./realtime');
const fakeProvider = require('./push/fake-provider');

let provider = fakeProvider;
function setProvider(p) { provider = p; }
function getProvider() { return provider; }

function validSubscription(subscription) {
  return subscription && typeof subscription.endpoint === 'string' && subscription.endpoint.trim() &&
    subscription.keys && typeof subscription.keys.p256dh === 'string' && subscription.keys.p256dh.trim() &&
    typeof subscription.keys.auth === 'string' && subscription.keys.auth.trim();
}

async function subscribe(userId, subscription) {
  if (!validSubscription(subscription)) fail('Abonnement push invalide');
  await db.query(`
    INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);
  return { ok: true };
}
async function unsubscribe(userId, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) fail('endpoint requis');
  await db.query('DELETE FROM public.push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
  return { ok: true };
}
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }

// Never the alert's content — the same {type, id, at} shape as the SSE
// payload (backend/realtime.js): a push is a wake-up hint, the client
// refetches through the already-authorized REST API. Own/scope filtering per
// subscriber mirrors backend/realtime-routes.js exactly (PG-8's own scope
// service, never a second implementation of that decision).
async function deliverFor(event) {
  const rows = await db.all('SELECT id, user_id, endpoint, p256dh, auth FROM public.push_subscriptions');
  for (const row of rows) {
    try {
      const s = await scope.resolveScope(row.user_id);
      const tenantId = s.resolveTenant();
      if (!s.hasAccess || tenantId == null) continue;
      const access = s.tenantAccess(tenantId);
      const relevant = access === 'scope' ? event.payload.tenantId === tenantId : event.payload.createdBy === row.user_id;
      if (!relevant) continue;
      const payload = JSON.stringify({ type: event.type, id: event.payload.id, at: event.at });
      const result = await provider.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload);
      if (result && result.expired) await db.query('DELETE FROM public.push_subscriptions WHERE id = $1', [row.id]);
    } catch (error) {
      console.error('[PUSH]', event.type, (error && (error.code || error.name)) || 'inconnue');
    }
  }
}

// Explicit init(), not a require()-time side effect: server.js calls this
// once at startup; tests call it on their own disposable environment. Not
// awaited by the emitter (fire-and-forget, errors logged in deliverFor) —
// a push failure must never affect the mutation that triggered it.
let unsubscribeBus = null;
function init() {
  if (unsubscribeBus) return unsubscribeBus;
  unsubscribeBus = realtime.subscribe(() => true, event => { deliverFor(event).catch(() => {}); });
  return unsubscribeBus;
}
function stop() { if (unsubscribeBus) { unsubscribeBus(); unsubscribeBus = null; } }

module.exports = { subscribe, unsubscribe, deliverFor, init, stop, setProvider, getProvider };
