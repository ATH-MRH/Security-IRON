'use strict';
/**
 * Classification transport partagée par le gestionnaire global (server.js) et le
 * routeur Alert Core (backend/alerts.js).
 *
 * - Erreur métier (err.status 400–499) : statut et message conservés tels quels.
 * - Conflit transitoire PostgreSQL reconnu (interblocage, sérialisation, verrou
 *   indisponible) ou expiration d'un verrou Alert Core : HTTP 503 générique.
 * - Schéma / configuration Alert Core indisponible : HTTP 503 générique.
 * - Tout le reste : HTTP 500 « Erreur serveur ».
 *
 * Aucune divulgation de SQL, nom de table, contrainte, hôte ni identifiant : le
 * message d'une erreur technique n'est jamais renvoyé ni journalisé, seul le code
 * SQLSTATE ou le nom de l'erreur l'est côté serveur.
 */
const TRANSIENT_SQLSTATE = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
]);
const TRANSIENT_CODE = new Set([...TRANSIENT_SQLSTATE, 'ALERT_LOCK_TIMEOUT']);
const UNAVAILABLE_CODE = new Set(['ALERT_SCHEMA_UNAVAILABLE', 'ALERT_CONFIG_MISSING']);

function classifyError(err) {
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return { kind: 'business', status: err.status, body: { error: String(err.message || 'Requête invalide') } };
  }
  const code = err && err.code;
  if (TRANSIENT_CODE.has(code)) {
    return { kind: 'transient', status: 503, body: { error: 'Opération temporairement indisponible' } };
  }
  if (UNAVAILABLE_CODE.has(code)) {
    return { kind: 'unavailable', status: 503, body: { error: 'Service momentanément indisponible' } };
  }
  return { kind: 'technical', status: 500, body: { error: 'Erreur serveur' } };
}

function logError(tag, err, classification) {
  const c = classification || classifyError(err);
  if (c.kind === 'business') return;
  console.error('[' + tag + ']', c.kind, (err && (err.code || err.name)) || 'inconnue');
}

function sendError(res, err, tag) {
  const c = classifyError(err);
  logError(tag || 'HTTP', err, c);
  res.status(c.status).json(c.body);
}

module.exports = { classifyError, logError, sendError, TRANSIENT_SQLSTATE, TRANSIENT_CODE, UNAVAILABLE_CODE };
