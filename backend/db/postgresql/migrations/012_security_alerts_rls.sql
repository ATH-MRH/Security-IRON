-- PCS01 (Lot E) — deuxième défense RLS pour security_alerts (PG-9, migration
-- 005), longtemps hors périmètre faute de colonne tenant_id (voir l'en-tête
-- de cette même migration 005) — comblé depuis par la migration 009. La
-- table qui a le plus besoin d'une deuxième ligne de défense (SOS/alertes
-- critiques) est aussi la seule des 6 tables métier multitenant à n'en
-- avoir toujours aucune ; cette migration ferme cet écart, sans toucher à
-- security_alerts elle-même (aucun ALTER de colonne, aucune donnée modifiée).
--
-- Distinct de current_actor_tenant_ids() (migration 005) sur un point
-- précis : le job d'escalade planifié (backend/alert-core/service.js
-- #escalateDue, server.js) doit voir/traiter les alertes de TOUS les
-- tenants, sans acteur humain associé à cette exécution — le poser comme un
-- acteur (avec ses propres memberships) serait une fiction, et le faire
-- tourner avec un rôle BYPASSRLS romprait le principe du moindre privilège
-- pour la seule tâche qui en a besoin. `securisite.system_job = 'escalation'`
-- est un second marqueur de session, distinct de securisite.actor_user_id,
-- posé UNIQUEMENT par ce job précis (backend/alert-core/service.js), jamais
-- accessible depuis une requête HTTP ni dérivé d'une entrée utilisateur —
-- SET LOCAL, donc jamais persistant au-delà de sa propre transaction, exactement
-- comme securisite.actor_user_id (voir migration 005).
--
-- Fonction à ZÉRO argument (SETOF uuid), comme current_actor_tenant_ids() :
-- backend/db/postgresql/provision-roles.js#apply et backend/db/postgresql/
-- readiness.js accordent/vérifient EXECUTE sur chaque nom de
-- RLS_FUNCTIONS avec la signature générique "nomfonction()" — une fonction
-- à paramètre aurait exigé de faire diverger ce mécanisme partagé pour ce
-- seul cas, un risque et une complexité que ce lot évite délibérément.

CREATE FUNCTION securisite_meta.security_alerts_visible_tenant_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $rls$
  SELECT id FROM public.tenants
    WHERE status = 'active' AND current_setting('securisite.system_job', true) = 'escalation'
  UNION
  SELECT tid FROM securisite_meta.current_actor_tenant_ids() AS tid
    WHERE current_setting('securisite.system_job', true) IS DISTINCT FROM 'escalation';
$rls$;
-- SECURITY DEFINER, comme current_actor_tenant_ids() (voir migration 005) :
-- s'exécute avec les privilèges du propriétaire (OWNER), qui possède aussi
-- tenants/memberships et n'est donc jamais bloqué par leur propre RLS.
REVOKE ALL ON FUNCTION securisite_meta.security_alerts_visible_tenant_ids() FROM PUBLIC;

ALTER TABLE public.security_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY security_alerts_actor_tenant ON public.security_alerts
  FOR ALL USING (tenant_id IN (SELECT securisite_meta.security_alerts_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT securisite_meta.security_alerts_visible_tenant_ids()));
