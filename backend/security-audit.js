'use strict';
/**
 * PG-10 — journal de sécurité global transversal (`public.security_audit`,
 * migration 006). Point d'écriture UNIQUE : aucune route n'insère directement,
 * tout passe par record() — même contrat que backend/scope.js pour la
 * résolution de périmètre (« ne disperse pas dans toutes les routes »).
 *
 * Ne remplace pas alert_audit / alert_config_audit / membership_audit : ceux-ci
 * restent l'autorité de leur domaine (before/after détaillé). security_audit
 * n'enregistre que l'événement de sécurité synthétique.
 *
 * Fail-closed vs best-effort est une décision du SITE D'APPEL, pas de ce
 * module : record() propage toujours ses erreurs comme n'importe quel appel
 * SQL. Un appelant à l'intérieur d'une transaction de mutation critique
 * (user.create, membership.create, alert.create, alert.action,
 * alert.rules.update) doit laisser l'erreur se propager — l'échec de l'audit
 * fait alors échouer/rollback la mutation elle-même (jamais de faux success).
 * Un appelant hors mutation (login, session révoquée, refus d'accès) doit
 * envelopper l'appel et journaliser une erreur d'audit sans bloquer la
 * réponse HTTP : un audit de refus momentanément indisponible ne doit pas
 * transformer un 401/403 légitime en 500, ni pire, en un accès accordé.
 */
const db = require('./database');

const OUTCOMES = ['success', 'denied', 'failure'];
const ORIGINS = ['http', 'system', 'migration', 'automation'];
const OUTCOME_SET = new Set(OUTCOMES);
const ORIGIN_SET = new Set(ORIGINS);

// Never let these — or anything that looks like them — reach `detail`, even
// under a differently-cased or nested key. Centralised here: the one place
// that decides what is safe to persist.
const FORBIDDEN_DETAIL_PATTERN = /password|passwd|hash|jwt|token|secret|api[_-]?key|cookie|session|authoriz|database_url|dsn|\bsql\b|stack/i;

function sanitizeDetail(detail) {
  if (detail == null) return null;
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    throw new TypeError('security-audit: detail doit être un objet plat ou null');
  }
  const clean = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    if (FORBIDDEN_DETAIL_PATTERN.test(key)) continue;
    if (Array.isArray(value)) {
      if (value.some(v => v !== null && typeof v === 'object')) {
        throw new TypeError('security-audit: detail doit rester plat (tableau de valeurs simples uniquement) : ' + key);
      }
      clean[key] = value; continue;
    }
    if (value !== null && typeof value === 'object') {
      throw new TypeError('security-audit: detail doit rester plat (pas de valeur imbriquée) : ' + key);
    }
    if (typeof value === 'string' && FORBIDDEN_DETAIL_PATTERN.test(value) && value.length > 40) {
      // Long values matching a forbidden pattern (e.g. a stray bearer token
      // string) are dropped rather than guessed at — never persisted "just in case".
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * @param event.eventType|resourceType|action   requis, texte libre (évolutif : pas de CHECK figé en base)
 * @param event.outcome    'success' | 'denied' | 'failure'
 * @param event.origin     'http' | 'system' | 'migration' | 'automation'
 * @param client  exécuteur .query() — le module database, ou le client de la
 *                transaction de mutation en cours (requis pour rester dans la
 *                même transaction que la mutation qu'un événement 'success' décrit)
 */
async function record(event, client = db) {
  const {
    requestId = null, correlationId = null,
    actorUserId = null, actorUsername = null, actorRole = null,
    tenantId = null, siteId = null, zoneId = null,
    eventType, resourceType, resourceId = null, action,
    outcome, origin,
    ipAddress = null, userAgent = null,
    detail = null,
  } = event || {};
  if (!eventType || !resourceType || !action) {
    throw new TypeError('security-audit: event_type, resource_type et action sont requis');
  }
  if (!OUTCOME_SET.has(outcome)) throw new TypeError('security-audit: outcome invalide : ' + outcome);
  if (!ORIGIN_SET.has(origin)) throw new TypeError('security-audit: origin invalide : ' + origin);
  const clean = sanitizeDetail(detail);
  const result = await client.query(
    `INSERT INTO public.security_audit
       (request_id, correlation_id, actor_user_id, actor_username, actor_role,
        tenant_id, site_id, zone_id, event_type, resource_type, resource_id,
        action, outcome, origin, ip_address, user_agent, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [requestId, correlationId, actorUserId, actorUsername, actorRole,
     tenantId, siteId, zoneId, eventType, resourceType, resourceId,
     action, outcome, origin, ipAddress, userAgent,
     clean === null ? null : JSON.stringify(clean)]);
  return { id: result.rows[0].id };
}

// Best-effort helper for non-transactional call sites (login, denials,
// revoked sessions): never lets an audit-write failure affect the response
// already decided by the caller. Logs the failure code only — never the event.
async function recordBestEffort(event, client = db) {
  try { return await record(event, client); }
  catch (error) {
    console.error('[AUDIT]', event && event.eventType, 'échec écriture :', (error && (error.code || error.name)) || 'inconnue');
    return null;
  }
}

module.exports = { record, recordBestEffort, sanitizeDetail, OUTCOMES, ORIGINS, FORBIDDEN_DETAIL_PATTERN };
