/**
 * PG-17 — géométrie cartographique pure : projette des coordonnées GPS
 * (WGS84) dans un repère 2D relatif borné à l'emprise des points reçus.
 * Aucun fond de carte réel, aucune tuile, aucun réseau externe : choisir un
 * fournisseur cartographique (potentiellement payant) reste un HUMAN
 * CHECKPOINT REQUIRED (MASTER ROADMAP §21 — PG-17). C'est précisément
 * l'abstraction demandée ("séparer coordonnées stockées / fournisseur de
 * carte") : `frontend/js/map.js` ne connaît que ce module, jamais les
 * coordonnées brutes des sites/alertes directement — un vrai fournisseur
 * (tuiles, projection Web Mercator réelle) remplacerait ce fichier seul.
 *
 * Séparé du rendu DOM pour rester une fonction pure et testable, comme
 * frontend/js/soc-kpis.js (PG-16).
 */
const MapGeometry = (() => {
  // Boîte englobante des points valides (latitude/longitude finies). `null`
  // si aucun point n'a de position — jamais une boîte par défaut inventée.
  function bounds(points) {
    const withGps = (Array.isArray(points) ? points : [])
      .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
    if (!withGps.length) return null;
    let minLat = withGps[0].latitude, maxLat = minLat, minLng = withGps[0].longitude, maxLng = minLng;
    for (const p of withGps) {
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLng) minLng = p.longitude;
      if (p.longitude > maxLng) maxLng = p.longitude;
    }
    return { minLat, maxLat, minLng, maxLng };
  }

  // Projette (lat,lng) dans une boîte [0,width] x [0,height], marge incluse.
  // Un point unique (ou un axe dégénéré, min===max) est centré plutôt que
  // divisé par zéro. Latitude croît vers le nord ; l'axe Y d'un SVG croît
  // vers le bas — inversé ici, une seule fois, pour que le rendu n'ait
  // jamais à y repenser.
  function projector(box, { width = 1000, height = 1000, padding = 60 } = {}) {
    if (!box) return () => null;
    const latSpan = box.maxLat - box.minLat, lngSpan = box.maxLng - box.minLng;
    const innerW = Math.max(0, width - 2 * padding), innerH = Math.max(0, height - 2 * padding);
    return (lat, lng) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const x = padding + (lngSpan === 0 ? innerW / 2 : ((lng - box.minLng) / lngSpan) * innerW);
      const y = padding + (latSpan === 0 ? innerH / 2 : (1 - (lat - box.minLat) / latSpan) * innerH);
      return { x, y };
    };
  }

  return { bounds, projector };
})();
