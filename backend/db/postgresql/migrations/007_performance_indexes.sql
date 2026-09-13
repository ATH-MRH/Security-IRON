-- PG-11 : index ajoutés uniquement sur preuve — mesurés avec EXPLAIN (ANALYZE,
-- BUFFERS) sur un volume synthétique réaliste (60 000 lignes/table, 200
-- utilisateurs) contre les requêtes réellement exécutées par le runtime
-- (backend/routes.js, backend/alert-core/repository.js,
-- backend/db/postgresql/readiness.js n'est pas concerné). Comparatif
-- avant/après consigné dans docs/postgresql-performance.md — aucune
-- modification sans preuve mesurée, aucun index spéculatif.
--
-- Non retenu (déjà servi par un index existant, confirmé par EXPLAIN) :
-- pendingEscalations (alert_status_idx, migration 002) — Bitmap Index Scan
-- avant ET après, aucun changement de plan.

-- GET /visiteurs : ORDER BY arrivee DESC sans index -> Sort (external merge,
-- disque) sur 60 000 lignes, 44 ms. Avec l'index : Index Scan, 15 ms.
CREATE INDEX visiteurs_arrivee_idx ON public.visiteurs (arrivee DESC);

-- GET /badges : même défaut, même mesure (55 ms -> 11 ms).
CREATE INDEX badges_emis_idx ON public.badges (emis DESC);

-- Alert Core list() pour un utilisateur non-admin/scope (repository.alertsByCreator) :
-- Seq Scan filtrant created_by sur toute la table puis tri -> Bitmap Index
-- Scan (3.8 ms -> 0.3 ms). Colonnes exactement celles du WHERE + ORDER BY.
CREATE INDEX security_alerts_created_by_idx ON public.security_alerts (created_by, level DESC, created_at DESC);

-- Alert Core list() pour un SOC/admin (repository.allAlerts, pas de WHERE) :
-- Seq Scan + tri externe parallèle, 157 ms sur 60 000 lignes -> Index Scan
-- déjà trié, 12 ms (13x).
CREATE INDEX security_alerts_level_created_idx ON public.security_alerts (level DESC, created_at DESC);

-- repository.recentBadgeAlert : appelée à CHAQUE refus de badge évalué contre
-- le seuil (backend/alert-core/service.js#fromBadge) -- chemin chaud. Seq
-- Scan éliminant la quasi-totalité des lignes, 11 ms -> Index Scan, <1 ms.
-- Partiel sur origin='REGLE_BADGE' : c'est la seule valeur que cette requête
-- filtre jamais, l'index reste petit.
CREATE INDEX security_alerts_badge_rule_idx ON public.security_alerts (equipment, created_at) WHERE origin = 'REGLE_BADGE';

-- repository.badgeRefusalCount : même chemin chaud, même mesure (11 ms -> <1 ms).
-- Partiel sur resultat='refus' : seule valeur filtrée par cette requête.
CREATE INDEX pietons_badge_refus_idx ON public.pietons (badge, datetime) WHERE resultat = 'refus';

-- GET /api/admin/security-audit?actor=... (PG-10) : les 4 index de la
-- migration 006 couvrent tenant_id/actor_user_id/event_type/resource_type,
-- aucun ne couvre actor_username (le filtre ?actor= réel). Seq Scan
-- (2.4 ms) -> Index Scan (0.05 ms).
CREATE INDEX security_audit_actor_username_created_idx ON public.security_audit (actor_username, created_at DESC);
