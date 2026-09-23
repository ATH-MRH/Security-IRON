-- ============================================================
-- 017 — Administrateur global : exception RLS explicite sur le
-- référentiel tenant/site/zone/memberships (LOT 3/9, mandat : « Aucune
-- liste vide/null ne doit signifier accès global par accident »).
--
-- Découvert en construisant backend/admin-sites.js (LOT 3) : un compte
-- users.role='admin' fraîchement créé via POST /admin/users n'a AUCUNE
-- ligne memberships (cette route ne provisionne jamais d'appartenance —
-- comportement inchangé). current_actor_tenant_ids() (migration 005) est
-- purement dérivée des memberships actives : sous le rôle applicatif
-- restreint (RLS, NOBYPASSRLS), un tel admin ne verrait ALORS aucune
-- ligne de tenants/sites/zones/memberships, même avec securisite.
-- actor_user_id correctement posé (scope.withActorContext) — un angle
-- mort, pas une restriction voulue : /admin/* est déjà, par ailleurs,
-- explicitement une capacité de compte globale (routes.js:61-68,
-- requireAdmin, aucun filtrage par périmètre).
--
-- Étendu SEULEMENT sur les 5 politiques du référentiel de scope lui-même
-- (celles que backend/admin-sites.js — et plus tard zones/memberships —
-- ont besoin de traverser). Délibérément PAS sur security_audit ni
-- security_alerts : leur restriction lecture au rôle memberships 'soc'
-- reste intentionnelle et documentée ailleurs (routes.js:180-185 —
-- "Un admin JWT sans membership soc reçoit donc une liste vide, pas une
-- erreur : la RLS est fail-closed par construction") — jamais affaiblie
-- ici sans réflexion dédiée à part.
-- ============================================================

-- SECURITY DEFINER, dérivé de users.role via l'actor_user_id déjà posé
-- par withActorContext — jamais d'un paramètre de session que l'appelant
-- pourrait forger directement (un current_setting('securisite.
-- actor_is_admin') arbitraire aurait été injectable par n'importe quel
-- appelant ayant accès à SET LOCAL ; relire users.role ferme cette porte,
-- même mécanisme de confiance que current_actor_tenant_ids()).
CREATE FUNCTION securisite_meta.current_actor_is_global_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $admin$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = NULLIF(current_setting('securisite.actor_user_id', true), '')::integer
      AND role = 'admin'
  );
$admin$;
REVOKE ALL ON FUNCTION securisite_meta.current_actor_is_global_admin() FROM PUBLIC;

ALTER POLICY tenants_actor_tenant ON public.tenants
  USING (id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin())
  WITH CHECK (id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin());

ALTER POLICY sites_actor_tenant ON public.sites
  USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin())
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin());

ALTER POLICY zones_actor_tenant ON public.zones
  USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin())
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin());

ALTER POLICY memberships_actor_tenant ON public.memberships
  USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin())
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin());

ALTER POLICY membership_audit_actor_tenant ON public.membership_audit
  USING (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin())
  WITH CHECK (tenant_id IN (SELECT securisite_meta.current_actor_tenant_ids()) OR securisite_meta.current_actor_is_global_admin());
