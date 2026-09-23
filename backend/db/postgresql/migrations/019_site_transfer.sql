-- ============================================================
-- 019 — Transfert contrôlé d'un site entre groupes (MISSION —
-- TRANSFERT INTER-GROUPES DES SITES).
--
-- Décision métier validée : un Administrateur global DOIT pouvoir
-- transférer un site existant d'un groupe vers un autre MÊME lorsqu'il
-- possède déjà des zones/postes/événements Main courante/rondes/
-- équipements/appartenances/historique. Ce n'est ni une suppression, ni
-- une recréation, ni une copie : SAME site.id, SAME historique, SAME
-- données opérationnelles — seule sites.tenant_id (le groupe propriétaire)
-- change, de façon contrôlée, transactionnelle et auditée (voir
-- backend/admin-sites.js#POST /sites/:id/transfer).
--
-- Ceci nécessite de RELÂCHER deux contraintes ON UPDATE RESTRICT qui, par
-- conception initiale (migrations 003/004), rendaient tout changement de
-- sites.tenant_id DÉFINITIVEMENT impossible dès qu'une seule ligne
-- zones/memberships référençait le site — documenté comme limitation V1
-- connue dans backend/admin-groups.js et backend/site-dependencies.js
-- (LOT GROUPES, rapport de mission §26). Cette mission lève explicitement
-- cette limitation, en distinguant clairement :
--   DELETE SITE  (backend/admin-sites.js DELETE /sites/:id, TOUJOURS
--                 bloqué par toute dépendance réelle — INCHANGÉ)
--   ≠
--   TRANSFER SITE TO ANOTHER GROUP (nouveau, explicitement autorisé, avec
--                 gestion contrôlée des conséquences — voir ci-dessous)
--
-- Audit des deux relations concernées avant modification :
--
-- 1) zones.tenant_id (migration 003) est une colonne PUREMENT
--    DÉNORMALISÉE : elle n'a AUCUNE signification de sécurité propre,
--    elle existe seulement pour que memberships puisse référencer
--    (zone_id, site_id, tenant_id) sans jointure supplémentaire
--    (migration 004). Une zone appartient à SON site, point — elle DOIT
--    donc simplement suivre son site parent quel que soit son groupe.
--    ON UPDATE CASCADE est sémantiquement correct et sûr ici : aucune
--    ligne orpheline possible, aucune perte d'historique (zones.id ne
--    change jamais, seul zones.tenant_id suit désormais sites.tenant_id).
ALTER TABLE public.zones DROP CONSTRAINT zones_site_tenant_fk;
ALTER TABLE public.zones ADD CONSTRAINT zones_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id) REFERENCES public.sites (id, tenant_id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

-- 2) memberships est à l'inverse un JOURNAL DE DROITS D'ACCÈS, IMMUABLE
--    par conception (triggers memberships_no_delete / memberships_
--    identity_lock, migration 004 — tenant_id fait explicitement partie
--    des colonnes que memberships_identity_lock interdit de modifier).
--    CASCADE y réécrirait SILENCIEUSEMENT le sens historique d'une ligne
--    (« cet utilisateur avait accès sous TEL groupe, à TELLE date ») en
--    un autre groupe qu'il n'a jamais eu — contredisant directement
--    l'immuabilité déjà garantie ailleurs pour ce même champ, et rendant
--    incompréhensible tout examen d'audit ultérieur.
--
--    La contrainte composite (site_id, tenant_id) → sites(id, tenant_id)
--    supposait implicitement que sites.tenant_id ne changerait JAMAIS ;
--    ce n'est plus vrai à partir de cette migration. On la remplace par
--    une contrainte simple sur site_id seul → sites(id) : l'invariant
--    « site_id doit toujours pointer vers un site réel » reste garanti ;
--    la cohérence (site_id, tenant_id) AU MOMENT DE LA CRÉATION reste
--    vérifiée par l'application (déjà le cas — backend/admin-groups.js
--    #POST /groups/:id/users vérifie explicitement que le site appartient
--    au tenant avant tout INSERT) — jamais recalculée après coup, jamais
--    perdue pour les lignes historiques déjà écrites.
ALTER TABLE public.memberships DROP CONSTRAINT memberships_site_tenant_fk;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_site_fk
    FOREIGN KEY (site_id) REFERENCES public.sites (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- 3) Même raisonnement pour le triplet (zone_id, site_id, tenant_id) :
--    une fois zones.tenant_id capable de suivre son site (point 1), le
--    triplet figé initial n'a plus de sens pour une ligne memberships
--    historique (une appartenance zone créée sous l'ancien groupe reste
--    un fait historique valide même si la zone — via son site — change
--    ensuite de groupe). Remplacé par une contrainte simple sur zone_id
--    seul → zones(id) : zone_id doit toujours pointer vers une zone
--    réelle, invariant conservé ; site_id/tenant_id restent vérifiés par
--    l'application au moment de la création (aucune route ne crée
--    aujourd'hui de memberships de niveau zone — colonne préparée pour un
--    usage futur, migration 004 — ce changement ne retire donc aucun
--    contrôle réellement exercé).
ALTER TABLE public.memberships DROP CONSTRAINT memberships_zone_parent_fk;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_zone_fk
    FOREIGN KEY (zone_id) REFERENCES public.zones (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Note : sites_id_tenant_key UNIQUE(id, tenant_id) (migration 003) et
-- zones_id_site_tenant_key UNIQUE(id, site_id, tenant_id) (migration 004)
-- sont conservées sans modification — la première reste la cible du FK
-- CASCADE de zones ci-dessus (point 1) ; la seconde, bien que sa seule
-- raison d'être d'origine (memberships_zone_parent_fk) vienne d'être
-- retirée, ne gêne rien et n'est pas supprimée ici (empreinte minimale,
-- aucune nécessité directe de la retirer).
