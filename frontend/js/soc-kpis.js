/**
 * PG-16 — calcul des indicateurs du Centre d'alertes, séparé du rendu DOM
 * (frontend/js/alerts.js) pour rester une fonction pure et testable. Ne
 * calcule que ce que les données réellement reçues permettent : aucun KPI
 * simulé. `rows` est la réponse telle quelle de GET /api/alerts (déjà
 * filtrée own/scope côté serveur, PG-8) — ce module ne fait AUCUNE
 * hypothèse de périmètre supplémentaire, il agrège ce qu'on lui donne.
 */
const SocKpis = (() => {
  // Same "en cours" definition already used by frontend/js/alerts.js's own
  // `open` filter (KPI cards) and `renderList()`'s "open" status filter,
  // preserved exactly: RESOLUE is not a terminal status (a "Clôturer" action
  // is still offered on it) but is no longer operationally active — the
  // situation is over, only the formal close is pending.
  const NOT_ACTIVE = new Set(['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE', 'RESOLUE']);
  const isActive = a => !NOT_ACTIVE.has(a.status);
  const sameDay = (iso, ref) => new Date(iso).toDateString() === ref.toDateString();

  /**
   * @param rows   tableau d'alertes (GET /alerts)
   * @param now    Date de référence (par défaut, l'instant présent — un
   *               paramètre explicite rend la fonction déterministe en test)
   */
  function compute(rows, now = new Date()) {
    const list = Array.isArray(rows) ? rows : [];
    const active = list.filter(isActive);
    const critical = active.filter(a => a.level >= 3);
    const sos = active.filter(a => a.level === 4);
    const unacknowledged = active.filter(a => a.status === 'NOTIFIEE');
    const escalated = active.filter(a => a.escalation_step > 0);
    const today = list.filter(a => sameDay(a.created_at, now));
    const ackToday = today.filter(a => a.acknowledged_at);
    const avgAckSeconds = ackToday.length
      ? Math.round(ackToday.reduce((sum, a) => sum + (Date.parse(a.acknowledged_at) - Date.parse(a.created_at)) / 1000, 0) / ackToday.length)
      : null;

    // Activité par site : uniquement le texte réellement soumis avec chaque
    // alerte (security_alerts.site) — pas un site du référentiel PG-6, qui
    // n'est lié à aucune alerte aujourd'hui (limite documentée, voir
    // docs/soc.md). Un site vide/non renseigné est regroupé explicitement,
    // jamais mélangé à un site homonyme réel.
    const bySiteMap = new Map();
    for (const a of active) {
      const key = (a.site || '').trim() || '(site non renseigné)';
      bySiteMap.set(key, (bySiteMap.get(key) || 0) + 1);
    }
    const bySite = [...bySiteMap.entries()]
      .map(([site, count]) => ({ site, count }))
      .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));

    // MISSION KPI (Centre d'alertes) : évolution/mini-graphique réels —
    // uniquement possibles pour "Alertes aujourd'hui" (un compte d'événements
    // horodatés, comparable jour à jour). active/critical/sos/unacknowledged/
    // escalated sont des états instantanés (combien le sont MAINTENANT) —
    // aucun relevé historique de ces états n'existe (rien n'enregistre "combien
    // étaient actives hier à cette heure") : leur donner une tendance/un
    // graphique reviendrait à inventer une donnée, explicitement interdit.
    // yesterday : même définition que `today`, décalée d'un jour — jamais une
    // approximation (24h glissantes), un vrai jour calendaire comme `today`.
    const yesterdayRef = new Date(now); yesterdayRef.setDate(yesterdayRef.getDate() - 1);
    const yesterday = list.filter(a => sameDay(a.created_at, yesterdayRef)).length;
    // dailySeries : 7 derniers jours (aujourd'hui inclus), un vrai point par
    // jour calendaire — la seule série temporelle que ces données permettent
    // de construire sans supposition.
    const dailySeries = [];
    for (let i = 6; i >= 0; i--) {
      const ref = new Date(now); ref.setDate(ref.getDate() - i);
      dailySeries.push({ date: ref.toDateString(), count: list.filter(a => sameDay(a.created_at, ref)).length });
    }

    return {
      active: active.length,
      critical: critical.length,
      sos: sos.length,
      unacknowledged: unacknowledged.length,
      escalated: escalated.length,
      today: today.length,
      yesterday,
      dailySeries,
      avgAckSeconds,
      bySite,
    };
  }

  return { compute };
})();
