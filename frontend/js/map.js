/**
 * PG-17 — page Carte : sites/zones (GET /api/map/sites, /zones —
 * backend/map.js, périmètre déjà résolu côté serveur) + alertes/SOS
 * géolocalisées (GET /api/alerts, déjà autorisé — PG-8, aucune route
 * dédiée : latitude/longitude y figurent déjà). Rendu via
 * frontend/js/map-provider.js : aucun fond de carte réel, aucune tuile,
 * aucun réseau externe — un vrai fournisseur reste un HUMAN CHECKPOINT
 * REQUIRED (MASTER ROADMAP §21).
 *
 * Aucune position d'agent affichée : aucune source de suivi continu des
 * agents n'existe dans ce code base aujourd'hui (le SOS PG-15 capture un
 * point GPS ponctuel à l'émission, pas un suivi) — ne pas simuler, même
 * principe que PG-16 pour les KPI ("ne simule pas des KPI dont les données
 * n'existent pas").
 */
// Pure : sélectionne et projette les marqueurs (site/alerte/SOS) sans
// toucher au DOM — testable comme frontend/js/soc-kpis.js#compute. Séparé
// de SiteMap (rendu) pour la même raison que SocKpis est séparé de
// AlertCenter (PG-16).
const MapMarkers = (() => {
  // Même définition "en cours" que frontend/js/soc-kpis.js (PG-16) : une
  // alerte RESOLUE/CLOTUREE/FAUSSE_ALERTE/ANNULEE n'a plus besoin
  // d'attention en temps réel sur la carte.
  const NOT_ACTIVE = new Set(['CLOTUREE', 'FAUSSE_ALERTE', 'ANNULEE', 'RESOLUE']);

  function compute(sites, alerts, options = {}) {
    const geoSites = (Array.isArray(sites) ? sites : [])
      .filter(s => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
    const geoAlerts = (Array.isArray(alerts) ? alerts : [])
      .filter(a => Number.isFinite(a.latitude) && Number.isFinite(a.longitude) && !NOT_ACTIVE.has(a.status));
    const box = MapGeometry.bounds([...geoSites, ...geoAlerts]);
    if (!box) return { box: null, markers: [] };
    const project = MapGeometry.projector(box, options);
    const markers = [
      ...geoSites.map(s => ({ kind: 'site', id: s.id, label: s.name, ...project(s.latitude, s.longitude) })),
      ...geoAlerts.map(a => ({
        kind: a.level === 4 ? 'sos' : 'alert', id: a.id, label: a.type, level: a.level,
        site: a.site, createdAt: a.created_at, ...project(a.latitude, a.longitude),
      })),
    ];
    return { box, markers };
  }

  return { compute };
})();

const SiteMap = (() => {
  let sites = [], zones = [], alerts = [];

  function levelColor(level) {
    return level === 4 ? 'var(--danger)' : level === 3 ? '#e0793c' : level === 2 ? 'var(--warning)' : 'var(--text-muted)';
  }

  function renderMarkers() {
    const svg = document.getElementById('carte-canvas');
    const empty = document.getElementById('carte-empty');
    const legend = document.getElementById('carte-legend');
    const { box, markers } = MapMarkers.compute(sites, alerts, { width: 1000, height: 640, padding: 60 });
    empty.hidden = !!box;
    legend.hidden = !box;
    if (!box) { svg.innerHTML = ''; return; }
    svg.innerHTML = markers.map(m => {
      // role="img" + <title> (jamais role="button"/tabindex : aucun clic
      // n'est câblé sur ces marqueurs — un affichage interactif faussement
      // annoncé serait une régression d'accessibilité, pas une amélioration).
      // Équivalent textuel complet déjà disponible : #carte-sites-list
      // ci-contre, et le Centre d'alertes pour le détail de chaque alerte.
      if (m.kind === 'site') {
        const zoneCount = zones.filter(z => z.site_id === m.id).length;
        return `<g class="carte-marker carte-site" transform="translate(${m.x},${m.y})" role="img"
          aria-label="Site ${escapeHtml(m.label)}, ${zoneCount} zone(s)"><rect x="-7" y="-7" width="14" height="14" rx="3"></rect>
          <title>${escapeHtml(m.label)} — ${zoneCount} zone(s)</title></g>`;
      }
      const sos = m.kind === 'sos';
      return `<g class="carte-marker carte-alert${sos ? ' carte-sos' : ''}" transform="translate(${m.x},${m.y})" role="img"
        aria-label="${sos ? 'SOS' : 'Alerte'} ${escapeHtml(m.label)}, niveau ${m.level}, ${escapeHtml(m.site || '')}">
        <circle r="${sos ? 9 : 6}" style="fill:${levelColor(m.level)}"></circle>
        <title>${sos ? 'SOS — ' : ''}${escapeHtml(m.label)} — niveau ${m.level} — ${escapeHtml(m.site || '')}</title></g>`;
    }).join('');
  }

  function renderSiteList() {
    const el = document.getElementById('carte-sites-list');
    if (!sites.length) { el.innerHTML = '<div class="empty-state">Aucun site dans ce périmètre</div>'; return; }
    el.innerHTML = sites.map(s => {
      const zoneCount = zones.filter(z => z.site_id === s.id).length;
      const gps = Number.isFinite(s.latitude) ? '' : ' <span class="badge">sans GPS</span>';
      return `<div class="carte-site-row"><strong>${escapeHtml(s.name)}</strong>${gps}<br>${zoneCount} zone(s)${s.address ? ' — ' + escapeHtml(s.address) : ''}</div>`;
    }).join('');
  }

  async function load() {
    const message = document.getElementById('carte-message');
    try {
      const [siteRows, zoneRows, alertRows] = await Promise.all([API.get('/map/sites'), API.get('/map/zones'), API.get('/alerts')]);
      sites = siteRows; zones = zoneRows; alerts = alertRows;
      message.textContent = '';
      renderSiteList();
      renderMarkers();
    } catch (err) {
      message.textContent = 'Carte indisponible : ' + err.message;
    }
  }

  return { load };
})();
