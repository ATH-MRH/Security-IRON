-- ============================================================
-- 020 — Transfert inter-groupes : complète la migration 019 pour les
-- tables du moteur Main Courante (migration 014, MC-1..MC-5), oubliées
-- par 019.
--
-- Audit complémentaire (mission « TRANSFERT INTER-GROUPES DES SITES ») :
-- la migration 019 a relâché ON UPDATE RESTRICT → CASCADE sur
-- zones_site_tenant_fk (la seule dépendance composite alors identifiée
-- comme bloquante pour zones/postes). Une relecture complète de TOUTES
-- les contraintes composites référençant sites(id, tenant_id) révèle que
-- la migration 014 (Main Courante — postes, APS, présence, rondes,
-- équipements, PCS01) a introduit HUIT contraintes supplémentaires du
-- même type, elles aussi ON UPDATE RESTRICT, elles aussi jamais touchées
-- par 019 :
--   main_courante_site_tenant_fk, main_courante_zone_site_tenant_fk,
--   mc_posts_site_tenant_fk,      mc_posts_zone_site_tenant_fk,
--   mc_aps_site_tenant_fk,        mc_aps_zone_site_tenant_fk,
--   mc_presence_site_tenant_fk,
--   round_circuits_site_tenant_fk, round_circuits_zone_site_tenant_fk,
--   rounds_site_tenant_fk,
--   equipment_site_tenant_fk,     equipment_zone_site_tenant_fk,
--   mc_pcs01_config_site_tenant_fk.
--
-- Sans cette migration, POST /admin/sites/:id/transfer (backend/
-- admin-sites.js) échouerait avec une erreur PostgreSQL 23503 brute dès
-- qu'un site à transférer possède ne serait-ce qu'un seul poste, profil
-- APS, cycle de présence, circuit de ronde, ronde, équipement ou
-- configuration PCS01 — cassant précisément les cas d'usage que la
-- mission exige de garantir (CAS2 : zones/postes réels ; CAS3 :
-- événements Main courante réels).
--
-- Même raisonnement que pour zones (migration 019, point 1) : dans
-- CHACUNE de ces tables, tenant_id est une colonne PUREMENT DÉNORMALISÉE
-- — elle existe uniquement pour permettre une contrainte composite
-- directe vers sites(id, tenant_id) (et pour zone_id, vers zones(id,
-- site_id, tenant_id)) sans jointure supplémentaire à l'écriture, exactement
-- comme documenté par le commentaire d'en-tête de la migration 014
-- lui-même (« chaque table porte directement tenant_id/site_id/zone_id
-- avec les mêmes contraintes composites que memberships »). Aucune de
-- ces tables n'est un journal de droits d'accès (contrairement à
-- memberships, migration 004) : ce sont des données OPÉRATIONNELLES qui
-- appartiennent à LEUR site, pas au groupe en tant que tel — elles
-- doivent donc simplement suivre leur site parent, exactement comme les
-- zones. ON UPDATE CASCADE est sémantiquement correct et sûr : aucun id
-- ne change, aucune ligne orpheline possible, l'historique (dates,
-- contenu, liens vers main_courante/employes/etc.) reste identique — seul
-- le tenant_id dénormalisé suit désormais sites.tenant_id.
--
-- round_checkpoints et round_scans ne portent pas tenant_id/site_id (ils
-- référencent seulement round_circuits_id / round_id, dont l'id ne change
-- jamais) : rien à modifier pour ces deux tables. mc_presence et rounds
-- n'ont pas de contrainte zone_site_tenant_fk dédiée (leur colonne
-- zone_id n'est pas contrainte par FK depuis la migration 014) : rien à
-- ajouter ici, conforme à l'existant.

ALTER TABLE public.main_courante DROP CONSTRAINT main_courante_site_tenant_fk;
ALTER TABLE public.main_courante ADD CONSTRAINT main_courante_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE public.main_courante DROP CONSTRAINT main_courante_zone_site_tenant_fk;
ALTER TABLE public.main_courante ADD CONSTRAINT main_courante_zone_site_tenant_fk
    FOREIGN KEY (zone_id, site_id, tenant_id) REFERENCES public.zones (id, site_id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.mc_posts DROP CONSTRAINT mc_posts_site_tenant_fk;
ALTER TABLE public.mc_posts ADD CONSTRAINT mc_posts_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE public.mc_posts DROP CONSTRAINT mc_posts_zone_site_tenant_fk;
ALTER TABLE public.mc_posts ADD CONSTRAINT mc_posts_zone_site_tenant_fk
    FOREIGN KEY (zone_id, site_id, tenant_id) REFERENCES public.zones (id, site_id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.mc_aps DROP CONSTRAINT mc_aps_site_tenant_fk;
ALTER TABLE public.mc_aps ADD CONSTRAINT mc_aps_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE public.mc_aps DROP CONSTRAINT mc_aps_zone_site_tenant_fk;
ALTER TABLE public.mc_aps ADD CONSTRAINT mc_aps_zone_site_tenant_fk
    FOREIGN KEY (zone_id, site_id, tenant_id) REFERENCES public.zones (id, site_id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.mc_presence DROP CONSTRAINT mc_presence_site_tenant_fk;
ALTER TABLE public.mc_presence ADD CONSTRAINT mc_presence_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.round_circuits DROP CONSTRAINT round_circuits_site_tenant_fk;
ALTER TABLE public.round_circuits ADD CONSTRAINT round_circuits_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE public.round_circuits DROP CONSTRAINT round_circuits_zone_site_tenant_fk;
ALTER TABLE public.round_circuits ADD CONSTRAINT round_circuits_zone_site_tenant_fk
    FOREIGN KEY (zone_id, site_id, tenant_id) REFERENCES public.zones (id, site_id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.rounds DROP CONSTRAINT rounds_site_tenant_fk;
ALTER TABLE public.rounds ADD CONSTRAINT rounds_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.equipment DROP CONSTRAINT equipment_site_tenant_fk;
ALTER TABLE public.equipment ADD CONSTRAINT equipment_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE public.equipment DROP CONSTRAINT equipment_zone_site_tenant_fk;
ALTER TABLE public.equipment ADD CONSTRAINT equipment_zone_site_tenant_fk
    FOREIGN KEY (zone_id, site_id, tenant_id) REFERENCES public.zones (id, site_id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.mc_pcs01_config DROP CONSTRAINT mc_pcs01_config_site_tenant_fk;
ALTER TABLE public.mc_pcs01_config ADD CONSTRAINT mc_pcs01_config_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
