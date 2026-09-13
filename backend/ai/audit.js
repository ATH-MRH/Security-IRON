'use strict';
/**
 * PG-24 — audit IA append-only : réutilise `public.security_audit`
 * (migration 006, PG-10 + migration 010, PG-24 : `origin='ai'`) plutôt
 * qu'une table dédiée. Migration 006 anticipait déjà ce lot : « Un IA aura
 * une origine dédiée plus tard (PG-19+) : ajout par migration ». Un seul
 * journal de sécurité transversal, déjà append-only (triggers), déjà RLS
 * (lecture réservée aux memberships `soc` de leur propre tenant), déjà
 * testé — pas une deuxième table à maintenir et auditer séparément.
 *
 * Champs (MASTER ROADMAP §28) : provider/model → `detail.provider`/
 * `detail.model` ; request type → `event_type` (`ai.<requestType>`) et
 * `detail.request_type` ; actor → `actor_user_id`/`actor_username` ;
 * tenant → `tenant_id` ; resource → `resource_type`/`resource_id` ;
 * timestamp → `created_at` ; correlation/request id → `correlation_id`/
 * `request_id` (PG-10/PG-18) ; résultat/référence → `detail.result_ref`.
 *
 * « Ne stocker que le contexte nécessaire » : jamais le texte généré en
 * clair — seulement une empreinte SHA-256 (`result_ref`), suffisante pour
 * vérifier après coup qu'une réponse donnée correspond à cet événement,
 * sans dupliquer/persister le contenu lui-même (et sans jamais y faire
 * fuiter, même indirectement, ce que `buildSafeContext` — PG-19 — a déjà
 * retiré du contexte envoyé au provider).
 *
 * « Ne jamais stocker : password/JWT/secret/API key/DATABASE_URL » :
 * `detail` passe par `backend/security-audit.js#sanitizeDetail` — même
 * protection que tout le reste de `security_audit`, réutilisée telle
 * quelle, jamais dupliquée. Défense en profondeur : aucun de ces éléments
 * n'est de toute façon jamais construit ici.
 *
 * « Décision humaine éventuelle » : `detail.human_decision` existe dans le
 * schéma mais reste `null` pour ce lot — le câblage qui l'alimenterait
 * (enregistrer qu'un humain a confirmé/rejeté une suggestion PG-21, en
 * respectant append-only : une NOUVELLE ligne, jamais une modification de
 * celle-ci) est un lot distinct, non entrepris ici faute d'être le
 * périmètre de PG-24 — champ présent, honnêtement non alimenté plutôt que
 * deviné.
 *
 * Best-effort (`recordBestEffort`) : un audit IA manquant ne doit jamais
 * empêcher une réponse déjà générée d'atteindre l'utilisateur — même
 * principe que les refus d'accès (PG-10) : ce n'est pas une mutation
 * critique dont l'échec doit tout annuler, contrairement à
 * `alert.create`/`alert.action` qui restent fail-closed dans leur propre
 * transaction.
 */
const { createHash } = require('node:crypto');
const securityAudit = require('../security-audit');

function hashResult(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

async function recordAiEvent({ user, requestType, resourceType = 'ai', resourceId = null, provider, model = null, resultText }) {
  return securityAudit.recordBestEffort({
    requestId: user?.requestId ?? null,
    correlationId: user?.correlationId ?? null,
    actorUserId: user?.id ?? null, actorUsername: user?.username ?? null, actorRole: user?.role ?? null,
    tenantId: user?.tenantId ?? null,
    origin: 'ai', eventType: 'ai.' + requestType, resourceType, resourceId,
    action: 'generate', outcome: 'success',
    ipAddress: user?.ipAddress ?? null, userAgent: user?.userAgentHeader ?? null,
    detail: {
      provider: provider ?? null, model, request_type: requestType,
      result_ref: hashResult(resultText), human_decision: null,
    },
  });
}

module.exports = { recordAiEvent, hashResult };
