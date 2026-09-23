-- ============================================================
-- 018 — Groupes (Administration Système, LOT « GROUPES ») : réutilise
-- tenants tel quel comme référentiel canonique de groupe/client — AUCUNE
-- nouvelle table de groupe créée.
--
-- Audit préalable (obligatoire, mandat §3) : `tenants` (migration 003)
-- porte déjà EXACTEMENT la notion de « périmètre organisationnel/client »
-- demandée — id, code UNIQUE, name, status (active/suspended/archived),
-- déjà la racine de toute la hiérarchie tenant > site > zone, déjà
-- protégée par RLS (migration 005/017), déjà le pivot de memberships
-- (migration 004, user ↔ tenant/site/zone + rôle). Créer une table
-- `security_groups` séparée aurait dupliqué ce référentiel exactement
-- comme le mandat l'interdit explicitement (§3 : « NE PAS créer de
-- doublon si une structure saine existe »).
--
-- `sites.tenant_id NOT NULL` (migration 003) répond aussi à la question
-- du mandat « un site appartient-il à un ou plusieurs groupes ? » : la
-- contrainte existante impose déjà UN SEUL groupe par site (jamais
-- plusieurs) — cohérent avec les exemples métier du mandat (DHL Hamoul,
-- FIAT Oran : chaque site est déjà nommé pour un client unique). Aucune
-- table `security_group_sites` many-to-many n'est donc nécessaire :
-- « Sites du groupe » = `sites WHERE tenant_id = <groupe>` (déjà
-- canonique) ; « déplacer un site vers un autre groupe » = réaffecter
-- sites.tenant_id, une opération gardée par backend/admin-groups.js
-- (refusée si le site porte des données réelles — zones/postes/
-- appartenances/événements/rondes/équipement/APS/présence/PCS01 —
-- exactement le même filet FK RESTRICT déjà éprouvé pour DELETE
-- /admin/sites/:id, migration 015/017/backend/admin-sites.js).
--
-- Utilisateur → Groupe : `memberships` (migration 004) porte déjà cette
-- relation (user_id, tenant_id, role, scope généré tenant/site/zone).
-- Une appartenance de niveau TENANT (site_id/zone_id NULL) = tous les
-- sites du groupe (périmètre maximal). Une ou plusieurs appartenances de
-- niveau SITE (site_id posé, jamais un site hors tenant_id — imposé par
-- la contrainte composite memberships_site_tenant_fk existante) = accès
-- restreint à ce sous-ensemble UNIQUEMENT si aucune appartenance de
-- niveau tenant ne coexiste (backend/scope.js#coverageOf couvre déjà
-- tout site dès qu'une ligne tenant existe — une intersection stricte
-- SITES_DU_GROUPE ∩ SITES_AUTORISÉS exige donc l'ABSENCE de ligne
-- tenant, jamais sa coexistence avec des lignes site). Documenté et
-- verrouillé par tests (tests/postgres-scope.test.js,
-- tests/postgres-admin-groups.test.js).
--
-- Seul ajout réel nécessaire : les colonnes de cycle de vie sur tenants
-- (description/updated_at/archived_at), symétriques à celles déjà
-- ajoutées à sites par la migration 015, pour que l'écran Groupes
-- affiche/modifie un groupe avec la même richesse qu'un site.
-- ============================================================

ALTER TABLE public.tenants
    ADD COLUMN description TEXT,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD CONSTRAINT tenants_archived_at_chk CHECK ((status = 'archived') = (archived_at IS NOT NULL));

-- Réutilise la fonction générique déjà créée par la migration 015
-- (securisite_meta.touch_updated_at) — pas une nouvelle fonction par table.
CREATE TRIGGER tenants_touch_updated_at
BEFORE UPDATE ON public.tenants
FOR EACH ROW EXECUTE FUNCTION securisite_meta.touch_updated_at();
