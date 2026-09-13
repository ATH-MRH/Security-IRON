# SécuriSite — benchmark de performance (PG-26)

**Mesuré le 2026-09-13T18:02:48.267Z, une seule machine locale de développement** — pas une infrastructure de charge dédiée, pas un environnement de production. Ces chiffres décrivent CET environnement précis, pas une promesse de capacité ni un SLA.

## Paramètres

- Concurrence : 20 requêtes simultanées (sauf SOS/corrélation, volontairement bornées — voir notes)
- Itérations par scénario : 200 (sauf mention contraire)
- Volume seedé : 2000 alertes, 5 sites, 20 incidents, un seul tenant

## Résultats mesurés

| Scénario | N | Concurrence | p50 | p95 | p99 | min–max | Débit | Erreurs |
|---|---|---|---|---|---|---|---|---|
| GET /alerts (liste) | 200 | 20 | 160.6 ms | 176.7 ms | 192.5 ms | 44.7 ms–196.4 ms | 121.2 req/s | 0.0% |
| GET /stats/dashboard (SOC) | 200 | 20 | 13.4 ms | 16.6 ms | 19.0 ms | 9.9 ms–19.7 ms | 1408.9 req/s | 0.0% |
| GET /alerts/:id (détail + timeline) | 200 | 20 | 10.9 ms | 16.5 ms | 17.2 ms | 6.3 ms–17.8 ms | 1736.8 req/s | 0.0% |
| GET /alerts/notifications | 200 | 20 | 12.5 ms | 16.1 ms | 17.0 ms | 5.6 ms–17.1 ms | 1559.8 req/s | 0.0% |
| POST /alerts/sos (rafale) | 20 | 5 | 5.8 ms | 7.6 ms | 9.0 ms | 4.4 ms–9.0 ms | 773.6 req/s | 0.0% |
| GET /realtime/ticket (émission, SSE) | 200 | 20 | 5.3 ms | 10.7 ms | 28.1 ms | 1.4 ms–33.7 ms | 3397.2 req/s | 0.0% |
| GET /map/sites (RLS, PG-9) | 200 | 20 | 9.3 ms | 11.6 ms | 12.0 ms | 4.7 ms–12.0 ms | 2074.8 req/s | 0.0% |
| GET /alerts/search?q=Type (recherche) | 200 | 20 | 139.7 ms | 152.1 ms | 153.3 ms | 115.7 ms–156.7 ms | 139.3 req/s | 0.0% |
| GET /alerts/correlations | 100 | 10 | 212.5 ms | 226.7 ms | 237.4 ms | 127.5 ms–240.7 ms | 46.8 req/s | 0.0% |
| POST /alerts/:id/actions (écriture, audit inclus) | 200 | 20 | 30.8 ms | 48.1 ms | 54.5 ms | 15.4 ms–55.9 ms | 604.6 req/s | 16.5% |

### Notes

- **SOS** : borné à 20 requêtes / 5 concurrentes — c'est le seuil de tolérance exact posé par PG-25 (`SOS_MAX_PER_WINDOW`) ; le dépasser ici mesurerait le 429, pas la création réelle d'alerte.
- **Corrélation** : bornée à 100 requêtes / 10 concurrentes — calcul en mémoire sur l'ensemble des alertes du tenant à chaque appel (PG-22), plus coûteux qu'une simple lecture.
- **Actions d'écriture** : chaque appel passe par une transaction complète (alerte + alert_audit + security_audit, PG-10) — inclut donc déjà le coût de l'audit, non mesuré séparément (aucune route ne l'isole). Un taux d'erreur non nul y est attendu, pas un bug : le volume seedé fait naturellement tourner le statut sur 6 valeurs (dont CLOTUREE/FAUSSE_ALERTE/ANNULEE, terminaux) — COMMENTAIRE y échoue en 409 exactement comme un clic manuel sur une alerte déjà close le ferait (aucune anomalie applicative, seulement une conséquence attendue de données réalistes).
- **GET /alerts** : le plan EXPLAIN ANALYZE ci-dessous s'exécute en ~6 ms côté PostgreSQL pour 2000 lignes — le p50 mesuré de bout en bout est nettement plus élevé ; le coût dominant n'est donc pas la base de données mais la sérialisation JSON et le transfert du jeu de résultats complet (aucune pagination serveur aujourd'hui). Utile à savoir si ce chiffre devait un jour se dégrader : la piste ne serait pas un index.

## EXPLAIN ANALYZE — requêtes clés

### allAlerts (tenant, sans filtre)

```
Sort  (cost=198.61..203.84 rows=2093 width=270) (actual time=6.701..6.743 rows=2020 loops=1)
  Sort Key: level DESC, created_at DESC
  Sort Method: quicksort  Memory: 444kB
  ->  Seq Scan on security_alerts  (cost=0.00..83.16 rows=2093 width=270) (actual time=0.006..0.238 rows=2020 loops=1)
        Filter: (tenant_id = '507486ba-d55e-5142-9ac2-196da97866df'::uuid)
Planning Time: 0.627 ms
Execution Time: 6.834 ms
```

### alertsByCreator

```
Sort  (cost=203.84..209.07 rows=2093 width=270) (actual time=5.599..5.634 rows=2020 loops=1)
  Sort Key: level DESC, created_at DESC
  Sort Method: quicksort  Memory: 444kB
  ->  Seq Scan on security_alerts  (cost=0.00..88.39 rows=2093 width=270) (actual time=0.003..0.210 rows=2020 loops=1)
        Filter: ((created_by = 1) AND (tenant_id = '507486ba-d55e-5142-9ac2-196da97866df'::uuid))
Planning Time: 0.035 ms
Execution Time: 5.672 ms
```

### recentBadgeAlert (partiel)

```
Index Scan using security_alerts_badge_rule_idx on security_alerts  (cost=0.27..10.77 rows=2 width=14) (actual time=0.012..0.016 rows=20 loops=1)
  Index Cond: ((equipment = 'badge:1'::text) AND (created_at >= '2000-01-01'::text))
Planning Time: 0.044 ms
Execution Time: 0.019 ms
```

## Interprétation

« Mesurer avant toute optimisation » (MASTER ROADMAP §30) : à ce volume (2000 alertes) et sur cette machine, tous les scénarios restent sous la seconde en p99 (voir tableau ci-dessus, chiffres réels) — aucune optimisation supplémentaire n'est justifiée par ces mesures. Les index PG-11 (`docs/postgresql-performance.md`) et l'agrégation client-side PG-16 restent suffisants à cette échelle. Une dégradation ne serait à réévaluer que si un volume réel démontré la dépassait.
