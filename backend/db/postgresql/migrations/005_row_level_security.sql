-- PG-9 : PostgreSQL Row Level Security comme DEUXIÈME défense, indépendante de
-- l'enforcement applicatif (PG-8, backend/scope.js). Portée : les seules tables
-- qui portent réellement un tenant_id aujourd'hui — tenants, sites, zones,
-- memberships, membership_audit. Les tables historiques (incidents, pietons,
-- security_alerts, ...) n'ont toujours aucune colonne tenant/site/zone
-- (limite documentée depuis PG-8 / docs/postgresql-scope.md) : RLS n'y est
-- donc pas applicable tant qu'une migration dédiée n'ajoute pas ces colonnes.
--
-- Granularité volontairement au niveau du TENANT (pas site/zone) : RLS est un
-- filet de sécurité en cas de bug applicatif, pas une deuxième implémentation
-- de la hiérarchie fine de backend/scope.js — dupliquer cette logique ici
-- créerait une seconde source de vérité susceptible de diverger. Toute
-- appartenance active (tenant, site ou zone) sous un tenant rend ce tenant
-- entier visible via RLS ; l'application reste seule responsable du filtrage
-- fin site/zone.
--
-- Contexte transactionnel : securisite.actor_user_id (déjà utilisé par les
-- triggers d'audit PG-7, posé via SET LOCAL/set_config). Sans contexte —
-- aucun acteur, ou un acteur sans membership actif — RLS ne montre RIEN :
-- fail-closed par construction, jamais un GRANT de table qui suffit à lire.

CREATE FUNCTION securisite_meta.current_actor_tenant_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $rls$
  SELECT DISTINCT m.tenant_id
  FROM public.memberships m
  JOIN public.tenants t ON t.id = m.tenant_id AND t.status = 'active'
  WHERE m.status = 'active'
    AND m.user_id = NULLIF(current_setting('securisite.actor_user_id', true), '')::integer;
$rls$;
-- SECURITY DEFINER : s'exécute avec les privilèges du propriétaire de la
-- fonction (OWNER), qui est aussi propriétaire de memberships/tenants et donc
-- exempté de leur RLS par construction (pas de FORCE ROW LEVEL SECURITY sur
-- ces tables ci-dessous — sinon cette fonction se heurterait à sa propre
-- politique et ne verrait plus jamais rien). L'appelant (APP) a besoin
-- d'EXECUTE, accordé dynamiquement par provision-roles.js comme les autres
-- privilèges runtime — jamais codé en dur ici, le nom du rôle n'est pas connu
-- du SQL de migration.
REVOKE ALL ON FUNCTION securisite_meta.current_actor_tenant_ids() FROM PUBLIC;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_actor_tenant ON public.tenants
  FOR ALL USING (id IN (SELECT securisite_meta.current_actor_tenant_ids()))
  WITH CHECK (id IN (SELECT securisite_meta.current_actor_tenant_ids()));

CREATE POLICY sites_actor_tenant ON public.sites
  FOR ALL USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()));

CREATE POLICY zones_actor_tenant ON public.zones
  FOR ALL USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()));

CREATE POLICY memberships_actor_tenant ON public.memberships
  FOR ALL USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()));

CREATE POLICY membership_audit_actor_tenant ON public.membership_audit
  FOR ALL USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()));
