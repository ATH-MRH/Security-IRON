-- PG-6 : référentiel tenants / sites / zones, natif PostgreSQL.
-- Schéma + contraintes + backfill local uniquement. AUCUNE activation de
-- visibilité multitenant (aucune lecture/écriture applicative, aucune RLS).
-- Conçu pour PostgreSQL : identifiants UUID (gen_random_uuid), horodatage
-- TIMESTAMPTZ, cohérence tenant/site/zone garantie par des clés étrangères
-- composites — pas de trigger de cohérence.

CREATE TABLE public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    code TEXT NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    address TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (btrim(timezone) <> ''),
    latitude DOUBLE PRECISION CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    external_ref TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sites_tenant_code_key UNIQUE (tenant_id, code),
    -- Cible des clés étrangères composites de zones.
    CONSTRAINT sites_id_tenant_key UNIQUE (id, tenant_id),
    -- Le GPS est un couple : les deux ou aucun.
    CONSTRAINT sites_gps_pair_chk CHECK ((latitude IS NULL) = (longitude IS NULL))
);
-- Un site au plus par référence externe (rapprochement ATLAS ultérieur).
CREATE UNIQUE INDEX sites_external_ref_key ON public.sites (external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE public.zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id UUID NOT NULL,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    code TEXT NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    kind TEXT CHECK (kind IS NULL OR kind IN ('perimeter', 'parking', 'building', 'access_point', 'other')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT zones_site_code_key UNIQUE (site_id, code),
    -- (site_id, tenant_id) doit exister dans sites : garantit zones.tenant_id =
    -- sites.tenant_id, et bloque un changement de tenant du site parent.
    CONSTRAINT zones_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX zones_tenant_idx ON public.zones (tenant_id);

-- Aucun privilège élevé, aucune RLS, aucun trigger. Les droits du rôle
-- applicatif (SELECT seul avant l'activation multitenant du lot PG-8) sont
-- accordés par backend/db/postgresql/provision-roles.js.

-- ── Backfill local ────────────────────────────────────────────────────────────
-- Un tenant « local » et son site « main » ; identifiants figés (UUID v5,
-- namespace DNS, noms « securisite.local.tenant » / « securisite.local.site.main »)
-- pour un résultat déterministe entre environnements. Nom et adresse repris de
-- public.parametres si présents. Aucune zone : les chaînes historiques
-- lieu/point ne constituent pas un référentiel fiable (validation humaine, PG-6.11).
INSERT INTO public.tenants (id, code, name)
VALUES ('507486ba-d55e-5142-9ac2-196da97866df', 'local', 'Client local')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.sites (id, tenant_id, code, name, address, timezone)
SELECT
    'fa831124-0323-581e-993c-1f4332a36282',
    (SELECT id FROM public.tenants WHERE code = 'local'),
    'main',
    COALESCE(NULLIF(btrim((SELECT valeur FROM public.parametres WHERE cle = 'site')), ''), 'Site principal'),
    NULLIF(btrim((SELECT valeur FROM public.parametres WHERE cle = 'adresse')), ''),
    'UTC'
ON CONFLICT (tenant_id, code) DO NOTHING;
