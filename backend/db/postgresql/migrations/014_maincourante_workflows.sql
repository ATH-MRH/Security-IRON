-- MAIN COURANTE — moteur de workflows (portage PostgreSQL propre de la V2
-- explorée sur feature/securisite-alert-core, base SQLite — jamais copiée
-- telle quelle : reconstruite sur l'architecture tenant/site/zone réelle
-- déjà en place, migrations 003/004, jamais recréée ici).
--
-- Ne touche à AUCUNE table historique existante (employes/visiteurs/
-- vehicules/incidents/main_courante restent inchangées dans leur identité —
-- seules des colonnes additives sur main_courante, voir plus bas) : les
-- nouveaux domaines sont des tables d'extension avec FK vers l'existant,
-- exactement le principe déjà suivi par les migrations 002-013.
--
-- Scope tenant/site/zone : pas de table mc_scopes ad-hoc (nécessaire côté
-- SQLite faute de FK réelles) — chaque table porte directement tenant_id/
-- site_id/zone_id avec les mêmes contraintes composites que memberships
-- (migration 004), revérifiées par backend/scope.js (req.scope), déjà
-- audité et testé — jamais reconstruit ici.

-- ============================================================
-- main_courante — colonnes additives pour le moteur de workflows
-- ============================================================
-- `data` : payload structuré par workflow (APS sélectionné, circuit,
-- checkpoint, véhicule/visiteur lié...) — schéma variable selon le code,
-- validé applicativement contre la définition du workflow (backend/
-- maincourante-workflows.js), jamais en base : JSONB justifié ici, pas
-- de nouvelle colonne par famille de workflow.
-- `idempotency_key` : une resoumission identique (double clic, retry
-- réseau) renvoie l'événement déjà créé au lieu d'en dupliquer un second —
-- mission explicite ("éviter les demi-succès" / "double submit").
-- `tenant_id`/`site_id`/`zone_id` : périmètre réel de l'événement — la table
-- main_courante historique n'en portait aucun (comme toutes les tables
-- legacy, voir backend/routes.js#withScope) ; nullable pour ne rien casser
-- sur les lignes existantes, NOT NULL appliqué au niveau applicatif pour
-- toute nouvelle écriture passant par le moteur de workflows.
ALTER TABLE public.main_courante ADD COLUMN data JSONB;
ALTER TABLE public.main_courante ADD COLUMN idempotency_key TEXT;
ALTER TABLE public.main_courante ADD COLUMN tenant_id UUID REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.main_courante ADD COLUMN site_id UUID;
ALTER TABLE public.main_courante ADD COLUMN zone_id UUID;
ALTER TABLE public.main_courante
  ADD CONSTRAINT main_courante_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.main_courante
  ADD CONSTRAINT main_courante_zone_site_tenant_fk FOREIGN KEY (zone_id, site_id, tenant_id)
    REFERENCES public.zones (id, site_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX main_courante_idempotency_key_key ON public.main_courante (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX main_courante_tenant_site_idx ON public.main_courante (tenant_id, site_id, zone_id);

-- ============================================================
-- mc_posts — postes réels (remplace l'ancien <select> statique du
-- formulaire libre pour le moteur de workflows ; l'ancien select reste
-- utilisable tel quel par le flux libre historique, non touché)
-- ============================================================
CREATE TABLE public.mc_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    zone_id UUID,
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mc_posts_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT mc_posts_zone_site_tenant_fk FOREIGN KEY (zone_id, site_id, tenant_id)
        REFERENCES public.zones (id, site_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX mc_posts_scope_idx ON public.mc_posts (tenant_id, site_id, zone_id);

-- ============================================================
-- mc_aps — rattachement d'un employé réel (public.employes, jamais recréé)
-- à un périmètre + poste + portrait, pour servir de "profil APS" au moteur
-- de workflows. Une seule ligne par employé (un employé = un profil APS,
-- jamais deux identités concurrentes).
-- ============================================================
CREATE TABLE public.mc_aps (
    employe_id TEXT PRIMARY KEY REFERENCES public.employes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    zone_id UUID,
    poste_id UUID REFERENCES public.mc_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- Portrait : stockage privé en base (aucun chemin filesystem exposé,
    -- aucune route non authentifiée) — mission explicite. Absent par défaut :
    -- jamais de silhouette générée présentée comme une photo réelle.
    photo BYTEA,
    photo_mime TEXT CHECK (photo_mime IS NULL OR photo_mime IN ('image/png', 'image/jpeg')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mc_aps_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT mc_aps_zone_site_tenant_fk FOREIGN KEY (zone_id, site_id, tenant_id)
        REFERENCES public.zones (id, site_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT mc_aps_photo_pair_chk CHECK ((photo IS NULL) = (photo_mime IS NULL))
);
CREATE INDEX mc_aps_scope_idx ON public.mc_aps (tenant_id, site_id, zone_id);

-- ============================================================
-- mc_presence — cycle arrivée/départ APS (10.01/10.02). Un seul cycle
-- ouvert par APS à la fois, contrainte physique (pas seulement applicative).
-- ============================================================
CREATE TABLE public.mc_presence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    zone_id UUID,
    employe_id TEXT NOT NULL REFERENCES public.employes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    poste_id UUID REFERENCES public.mc_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    open_event_id TEXT NOT NULL REFERENCES public.main_courante(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    close_event_id TEXT REFERENCES public.main_courante(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT mc_presence_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT mc_presence_close_after_open_chk CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
-- Un seul cycle ouvert par APS : la 2e arrivée sans départ est refusée au
-- niveau base, pas seulement applicatif (double soumission concurrente).
CREATE UNIQUE INDEX mc_presence_open_per_aps_key ON public.mc_presence (employe_id) WHERE closed_at IS NULL;

-- ============================================================
-- round_circuits / round_checkpoints / rounds / round_scans (10.06/10.07)
-- ============================================================
CREATE TABLE public.round_circuits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    zone_id UUID,
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    start_point TEXT NOT NULL CHECK (btrim(start_point) <> ''),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT round_circuits_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT round_circuits_zone_site_tenant_fk FOREIGN KEY (zone_id, site_id, tenant_id)
        REFERENCES public.zones (id, site_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE public.round_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    circuit_id UUID NOT NULL REFERENCES public.round_circuits(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    position INTEGER NOT NULL CHECK (position >= 0),
    CONSTRAINT round_checkpoints_circuit_position_key UNIQUE (circuit_id, position)
);
CREATE TABLE public.rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    zone_id UUID,
    circuit_id UUID NOT NULL REFERENCES public.round_circuits(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    employe_id TEXT NOT NULL REFERENCES public.employes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    open_event_id TEXT NOT NULL REFERENCES public.main_courante(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    close_event_id TEXT REFERENCES public.main_courante(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    anomaly BOOLEAN,
    anomaly_description TEXT,
    CONSTRAINT rounds_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT rounds_close_after_open_chk CHECK (ended_at IS NULL OR ended_at >= started_at),
    CONSTRAINT rounds_anomaly_desc_chk CHECK (anomaly IS DISTINCT FROM true OR btrim(coalesce(anomaly_description, '')) <> '')
);
-- Une seule ronde ouverte par APS à la fois.
CREATE UNIQUE INDEX rounds_open_per_aps_key ON public.rounds (employe_id) WHERE ended_at IS NULL;
CREATE TABLE public.round_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id UUID NOT NULL REFERENCES public.rounds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    checkpoint_id UUID NOT NULL REFERENCES public.round_checkpoints(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    anomaly BOOLEAN NOT NULL DEFAULT false,
    -- Un passage par checkpoint et par ronde (jamais deux scans du même point).
    CONSTRAINT round_scans_round_checkpoint_key UNIQUE (round_id, checkpoint_id)
);

-- ============================================================
-- equipment (10.14 — matériel détérioré)
-- ============================================================
CREATE TABLE public.equipment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    zone_id UUID,
    reference TEXT NOT NULL,
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    location TEXT NOT NULL CHECK (btrim(location) <> ''),
    state TEXT NOT NULL DEFAULT 'bon' CHECK (state IN ('bon', 'deteriore', 'hors_service')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT equipment_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT equipment_zone_site_tenant_fk FOREIGN KEY (zone_id, site_id, tenant_id)
        REFERENCES public.zones (id, site_id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT equipment_tenant_reference_key UNIQUE (tenant_id, reference)
);
CREATE INDEX equipment_scope_idx ON public.equipment (tenant_id, site_id, zone_id);

-- ============================================================
-- mc_pcs01_config — codes autorisés à déclencher PCS01, par site. Fail-safe
-- explicite : aucune ligne = PCS01 indisponible pour ce site (pas d'opt-out
-- global implicite, un site sans configuration n'expose jamais la case).
-- ============================================================
CREATE TABLE public.mc_pcs01_config (
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    site_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    codes TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT,
    PRIMARY KEY (tenant_id, site_id),
    CONSTRAINT mc_pcs01_config_site_tenant_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES public.sites (id, tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
