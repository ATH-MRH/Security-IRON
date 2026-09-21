-- ============================================================
-- 015 — Administration Système V1 : socle multi-sites + rôles étendus.
--
-- Réutilise et étend l'existant (jamais recréé) :
--   - tenants/sites/zones (003), memberships (004), RLS (005/012),
--     security_audit (006), mc_posts (014).
-- N'ajoute AUCUNE table parallèle pour ce que ces tables couvrent déjà :
-- seules des colonnes manquantes pour l'administration (statut détaillé,
-- coordonnées, horodatages de cycle de vie) sont ajoutées par ALTER TABLE.
-- ============================================================

-- ----------------------------------------------------------------
-- Fonction générique de "touch" updated_at, réutilisable par toute table
-- de ce lot (une seule fonction, pas une par table — contrairement à
-- securisite_meta.membership_touch() qui reste spécifique à memberships
-- pour ses propres raisons d'audit couplé).
-- ----------------------------------------------------------------
CREATE FUNCTION securisite_meta.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $touch$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$touch$;
REVOKE ALL ON FUNCTION securisite_meta.touch_updated_at() FROM PUBLIC;

-- ----------------------------------------------------------------
-- sites : coordonnées administratives + cycle de vie complet.
-- status existant ('active','suspended','archived') couvre déjà
-- ACTIVE/INACTIVE/ARCHIVED du mandat — pas renommé (RLS/tests en
-- dépendent), seulement documenté ici.
-- ----------------------------------------------------------------
ALTER TABLE public.sites
    ADD COLUMN client TEXT,
    ADD COLUMN phone TEXT,
    ADD COLUMN email TEXT CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN archived_at TIMESTAMPTZ,
    -- Cohérence : archived_at posé si et seulement si status='archived'.
    ADD CONSTRAINT sites_archived_at_chk CHECK ((status = 'archived') = (archived_at IS NOT NULL));

CREATE TRIGGER sites_touch_updated_at
BEFORE UPDATE ON public.sites
FOR EACH ROW EXECUTE FUNCTION securisite_meta.touch_updated_at();

-- ----------------------------------------------------------------
-- zones : mêmes ajouts + access_level (référence future vers les
-- niveaux N1-N4 administrés au lot Contrôle d'accès — texte libre pour
-- l'instant, contrainte de valeur ajoutée quand ce référentiel existera).
-- ----------------------------------------------------------------
ALTER TABLE public.zones
    ADD COLUMN description TEXT,
    ADD COLUMN access_level TEXT,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN archived_at TIMESTAMPTZ,
    -- Le statut existant ('active','archived') n'a pas de 'suspended' —
    -- une zone n'a pas d'état "inactif temporaire" métier distinct.
    ADD CONSTRAINT zones_archived_at_chk CHECK ((status = 'archived') = (archived_at IS NOT NULL));

CREATE TRIGGER zones_touch_updated_at
BEFORE UPDATE ON public.zones
FOR EACH ROW EXECUTE FUNCTION securisite_meta.touch_updated_at();

-- ----------------------------------------------------------------
-- mc_posts : code/type/effectif requis/horaires + cycle de vie complet.
-- code nullable + unicité partielle (comme sites.external_ref) : les
-- postes existants n'ont pas de code, une V1 ne doit pas les casser ni
-- inventer une valeur ; un code est exigé pour toute création future
-- côté application (backend/admin-sites.js), pas au niveau SQL.
-- ----------------------------------------------------------------
ALTER TABLE public.mc_posts
    ADD COLUMN code TEXT CHECK (code IS NULL OR code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    ADD COLUMN type TEXT,
    ADD COLUMN required_staff SMALLINT CHECK (required_staff IS NULL OR required_staff > 0),
    ADD COLUMN schedule JSONB,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD CONSTRAINT mc_posts_archived_at_chk CHECK ((status = 'archived') = (archived_at IS NOT NULL));

CREATE UNIQUE INDEX mc_posts_tenant_site_code_key ON public.mc_posts (tenant_id, site_id, code) WHERE code IS NOT NULL;

CREATE TRIGGER mc_posts_touch_updated_at
BEFORE UPDATE ON public.mc_posts
FOR EACH ROW EXECUTE FUNCTION securisite_meta.touch_updated_at();

-- ----------------------------------------------------------------
-- memberships.role : 4 rôles manquants du référentiel Administration
-- Système (mandat, §9 Rôles & permissions), ajoutés aux 6 déjà réels et
-- testés (soc, client_manager, supervisor, site_manager, agent,
-- client_viewer — jamais renommés ni supprimés). Mapping documenté dans
-- backend/permissions.js, pas ici :
--   Administrateur global  -> users.role='admin' (compte, hors memberships)
--   Opérateur SOC          -> 'soc' (existant)
--   Chef de site           -> 'site_manager' (existant)
--   Superviseur            -> 'supervisor' (existant)
--   Responsable sécurité   -> 'supervisor' (existant, réutilisé — portée
--                              équivalente, pas de doublon créé)
--   Client / consultation  -> 'client_viewer' (existant)
--   APS                    -> 'agent' (existant)
--   Administrateur sécurité -> 'security_admin' (nouveau)
--   Rondier                -> 'patrol_agent' (nouveau)
--   Opérateur contrôle d'accès -> 'access_operator' (nouveau)
--   Auditeur                -> 'auditor' (nouveau)
-- Postgres n'a pas d'ALTER CHECK : DROP puis ADD la même contrainte
-- élargie, sous le même nom pour rester repérable dans le catalogue.
-- ----------------------------------------------------------------
ALTER TABLE public.memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('soc', 'client_manager', 'supervisor', 'site_manager', 'agent', 'client_viewer',
                     'security_admin', 'patrol_agent', 'access_operator', 'auditor'));
