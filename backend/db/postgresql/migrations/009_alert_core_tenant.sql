-- PG-16 : ferme une fuite intertenant réelle, démontrée par
-- tests/postgres-soc.test.js — security_alerts n'avait aucune colonne
-- tenant_id (limite documentée depuis PG-6/PG-8/PG-9), et
-- repository.allAlerts()/alertsByCreator() n'avaient donc aucun moyen de
-- filtrer par tenant : un SOC 'scope' voyait TOUTES les alertes de TOUS les
-- tenants, pas seulement le sien. Tant qu'un seul tenant ('local') existait
-- en pratique, cette lacune n'avait aucune conséquence observable ; PG-16
-- crée le premier scénario réel à deux tenants actifs et la rend visible.
--
-- Portée volontairement limitée à security_alerts : les tables historiques
-- (incidents, pietons, visiteurs, ...) restent hors périmètre (aucune preuve
-- démontrée d'une fuite similaire là — elles n'ont ni page SOC dédiée ni
-- filtre tenant exposé aujourd'hui). Voir docs/soc.md.

ALTER TABLE public.security_alerts
  ADD COLUMN tenant_id UUID REFERENCES public.tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

UPDATE public.security_alerts SET tenant_id = (SELECT id FROM public.tenants WHERE code = 'local')
  WHERE tenant_id IS NULL;

ALTER TABLE public.security_alerts ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX security_alerts_tenant_idx ON public.security_alerts (tenant_id);
