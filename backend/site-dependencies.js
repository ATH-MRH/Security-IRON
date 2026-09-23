'use strict';
// Dépendances réelles d'un site — comptage partagé, réutilisé par DELETE
// /admin/sites/:id (backend/admin-sites.js, LOT 19 allégé), par l'ancienne
// réaffectation "sans dépendance" de backend/admin-groups.js (LOT GROUPES,
// checkbox "Sites disponibles" — toujours limitée aux sites mouvables), et
// par l'ANALYSE D'IMPACT du transfert inter-groupes (backend/admin-sites.js
// #GET/POST /sites/:id/transfer-impact|transfer, mission « TRANSFERT
// INTER-GROUPES DES SITES ») : ces usages exigent tous le même comptage
// réel, jamais des vérifications qui pourraient diverger.
//
// incidents/security_alerts n'ont pas de colonne site_id dans le schéma
// actuel (tables historiques) — jamais comptés à zéro ici, simplement
// absents de la réponse plutôt que fictifs (voir not_scoped_by_site).
//
// memberships_total (par opposition à memberships_active, affiché à
// l'utilisateur) reste le compteur qui doit gater toute SUPPRESSION —
// jamais active_memberships seul, qui masquerait la réalité (voir
// blockingTotal ci-dessous).
//
// IMPORTANT (mise à jour, migration 019) : jusqu'à la mission « TRANSFERT
// INTER-GROUPES DES SITES », ce compteur bloquait AUSSI toute réaffectation
// de groupe dès qu'une seule ligne memberships référençait le site — parce
// que la contrainte memberships_site_tenant_fk d'alors (migration 004),
// ON UPDATE RESTRICT, empêchait PostgreSQL lui-même de changer
// sites.tenant_id dans ce cas. Cette limitation a été délibérément levée
// (migration 019 : FK relâchées sur zones/memberships — voir son en-tête
// pour l'audit complet) : un TRANSFERT (contrairement à une SUPPRESSION)
// n'est plus bloqué par blockingTotal() — voir backend/admin-sites.js
// #POST /sites/:id/transfer, qui archive explicitement les appartenances
// devenues incompatibles au lieu de refuser l'opération.
async function countSiteDependencies(client, siteId) {
  const [zones, postes, membershipsActive, membershipsTotal, mainCourante, rounds, equipment, circuits, aps, presence, pcs01] = await Promise.all([
    client.get(`SELECT count(*)::int AS c FROM public.zones WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.mc_posts WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.memberships WHERE site_id=$1 AND status='active'`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.memberships WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.main_courante WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.rounds WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.equipment WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.round_circuits WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.mc_aps WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.mc_presence WHERE site_id=$1`, [siteId]),
    client.get(`SELECT count(*)::int AS c FROM public.mc_pcs01_config WHERE site_id=$1`, [siteId]),
  ]);
  return {
    zones: zones.c, postes: postes.c,
    active_memberships: membershipsActive.c, memberships_total: membershipsTotal.c,
    main_courante_events: mainCourante.c, rounds: rounds.c, equipment: equipment.c, round_circuits: circuits.c,
    aps: aps.c, presence: presence.c, pcs01_config: pcs01.c,
    not_scoped_by_site: ['incidents', 'security_alerts'],
  };
}

// Le compte qui doit réellement bloquer une SUPPRESSION (jamais un
// TRANSFERT, désormais autorisé même avec des dépendances réelles — voir
// backend/admin-sites.js#POST /sites/:id/transfer) — memberships_total,
// jamais active_memberships seul (voir commentaire ci-dessus).
function blockingTotal(deps) {
  return deps.zones + deps.postes + deps.memberships_total + deps.main_courante_events
    + deps.rounds + deps.equipment + deps.round_circuits + deps.aps + deps.presence + deps.pcs01_config;
}

module.exports = { countSiteDependencies, blockingTotal };
