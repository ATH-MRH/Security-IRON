-- PG-24 : audit IA — réutilise public.security_audit (migration 006) plutôt
-- qu'une table dédiée. La migration 006 anticipait déjà ce lot :
--   « Un IA aura une origine dédiée plus tard (PG-19+) : ajout par
--     migration, une valeur imprévue est un signal utile, pas une
--     contrainte à assouplir sans réflexion. »
-- Un seul journal de sécurité transversal, déjà append-only (triggers
-- migration 006), déjà RLS (lecture réservée aux memberships 'soc' de leur
-- propre tenant), déjà testé — pas une deuxième table à maintenir et à
-- auditer séparément.
--
-- event_type distingue les quatre types d'appel IA (ai.summary,
-- ai.assistant, ai.correlation, ai.search — voir backend/ai/audit.js) ;
-- resource_type/resource_id portent l'alerte/incident concerné quand il y
-- en a un (NULL pour un résumé de shift ou une recherche multi-ressources).
-- detail (JSONB, sanitizeDetail()) porte provider/model/request_type/
-- result_ref (hash du texte généré — jamais le texte lui-même, voir
-- backend/ai/audit.js) — jamais un secret, la contrainte est déjà générique
-- (FORBIDDEN_DETAIL_PATTERN) et n'a pas besoin d'être dupliquée ici.

ALTER TABLE public.security_audit DROP CONSTRAINT security_audit_origin_check;
ALTER TABLE public.security_audit ADD CONSTRAINT security_audit_origin_check
  CHECK (origin IN ('http', 'system', 'migration', 'automation', 'ai'));
