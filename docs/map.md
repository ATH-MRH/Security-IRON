# SécuriSite — cartographie (PG-17)

## Aucun fournisseur cartographique réel

Choisir un fournisseur de tuiles/cartes (potentiellement payant, ou soumis à
des conditions d'usage tierces) est explicitement réservé à un HUMAN
CHECKPOINT REQUIRED (MASTER ROADMAP §21 — PG-17, condition D "un fournisseur
externe payant doit être choisi"). Ce lot livre donc :

- la **séparation** demandée par la roadmap entre coordonnées stockées et
  fournisseur de rendu (`backend/map.js` ne renvoie que des coordonnées ;
  `frontend/js/map-provider.js` est le seul point qui en fait quelque
  chose) ;
- un fournisseur **local**, sans fond de carte réel, sans tuile, sans appel
  réseau externe : une projection relative des coordonnées GPS déjà connues
  dans une boîte englobante (`MapGeometry.bounds`/`projector`), rendue en
  SVG. Ce n'est pas une carte géographique réelle (pas de trait de côte, pas
  de rues) — la page l'indique explicitement ("vue relative, sans fond de
  carte réel").

Remplacer ce fournisseur par un vrai (tuiles OpenStreetMap, Mapbox, etc.) se
limite à réécrire `frontend/js/map-provider.js` : aucun autre fichier ne
connaît la façon dont une coordonnée devient un pixel.

## Ce qui est affiché

- **Sites** (`GET /api/map/sites`, `backend/map.js`) : `sites.latitude`/
  `longitude` (migration 003, PG-6) quand elles existent — un site sans GPS
  reste listé dans le panneau latéral, jamais positionné avec des
  coordonnées inventées.
- **Zones** (`GET /api/map/zones`) : listées pour compter les zones par
  site (panneau latéral) — **aucune position** : `zones` ne porte aucune
  colonne géographique dans le schéma (PG-6). Ne pas en inventer une.
- **Alertes/SOS géolocalisées** : réutilise `GET /api/alerts` (PG-8),
  déjà autorisé — `security_alerts.latitude/longitude` y figurent déjà
  depuis avant ce lot. Aucune route dédiée : même principe que les KPI
  SOC (PG-16), pas de nouvel endpoint sans nécessité démontrée. Seules les
  alertes actives sont tracées (même définition que
  `frontend/js/soc-kpis.js` — RESOLUE/CLOTUREE/FAUSSE_ALERTE/ANNULEE
  exclues : une situation terminée n'a plus besoin d'attention en temps
  réel sur la carte).
- **Agents** : **rien n'est affiché**. Aucune source de suivi continu de
  position des agents n'existe dans ce code base — le SOS (PG-15) capture
  un point GPS ponctuel à l'émission, pas un suivi permanent. Simuler des
  positions d'agents inventerait une donnée qui n'existe pas — même
  principe que PG-16 ("ne simule pas des KPI dont les données n'existent
  pas"), appliqué ici à la carte.

## Périmètre — première route à exploiter RLS (PG-9)

`backend/map.js` est la première route qui lit réellement une table
protégée par Row Level Security (`sites`, `zones` — migration 005, PG-9)
plutôt que la seule défense applicative de `backend/scope.js` (PG-8) :
`scope.withActorContext(userId, fn)` pose l'acteur PostgreSQL (`SET LOCAL`)
pour que `current_actor_tenant_ids()` filtre réellement les lignes en base.
Voir `docs/postgresql-scope.md`, qui documentait ce mécanisme comme « prêt
pour la première route qui le fera ».

RLS reste volontairement grossière (tout le tenant, voir « Granularité »
dans `docs/postgresql-scope.md`) : le filtre applicatif
`req.scope.allows(tenantId, siteId, zoneId)` referme ensuite sur le
site/zone réellement couvert par l'appartenance de l'utilisateur — même
modèle que `?site_id=`/`?zone_id=` sur `GET /api/alerts`. Un utilisateur
avec une appartenance limitée à un site ne voit que ce site (et ses zones)
sur la carte, jamais les sites voisins de son tenant.

## Tests

`tests/postgres-map.test.js` : isolation tenant A/B, filtre tenant forgé
refusé, narrowing site-level et zone-level, absence de membership refusée,
site/zone archivé jamais listé. `tests/frontend-map-provider.test.js` et
`tests/frontend-map.test.js` : géométrie pure (projection, boîte
englobante, cas dégénérés) et sélection des marqueurs (site sans GPS
ignoré, alerte terminée jamais tracée, SOS distingué d'une alerte
ordinaire) — aucune donnée simulée, uniquement des formes de lignes réelles.
