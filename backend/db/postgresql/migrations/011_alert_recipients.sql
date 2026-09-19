-- PCS01 (Lot C) — ciblage explicite de destinataires pour une alerte
-- (agent/site/zone/tout le tenant) et accusés de réception PAR
-- DESTINATAIRE, distincts du statut global de l'alerte (security_alerts.
-- status, inchangé, toujours piloté par le SOC via POST /alerts/:id/actions).
--
-- État de délivrance par destinataire, pas un journal d'audit : contrairement
-- à alert_audit (immuable), ces colonnes sont mises à jour en place à mesure
-- que chaque destinataire reçoit/accuse réception — même modèle que
-- push_subscriptions (PG-13, état de périphérique). L'action de diffuser
-- elle-même reste tracée dans alert_audit (backend/alert-core/service.js),
-- comme toute autre action Alert Core — pas de second journal ici.
--
-- recipient_type/recipient_ref décrivent la CIBLE demandée par l'opérateur
-- PCS01 (ex. 'site', l'id du site) ; user_id est l'utilisateur RÉSOLU côté
-- serveur à partir de cette cible et des memberships actives au moment de
-- la diffusion (jamais fourni par le client) — voir
-- backend/alert-core/recipients.js.

CREATE TABLE public.alert_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id TEXT NOT NULL REFERENCES public.security_alerts(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('user', 'site', 'zone', 'tenant_wide')),
    recipient_ref TEXT,
    broadcast_by INTEGER NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    -- Un même destinataire ne peut être ciblé deux fois pour la même alerte
    -- (une diffusion relancée, ex. après ajout d'un destinataire, ne doit
    -- jamais dupliquer une ligne déjà là — voir recipients.js#broadcast,
    -- ON CONFLICT DO NOTHING).
    CONSTRAINT alert_recipients_unique UNIQUE (alert_id, user_id)
);
CREATE INDEX alert_recipients_alert_idx ON public.alert_recipients (alert_id);
CREATE INDEX alert_recipients_user_idx ON public.alert_recipients (user_id, sent_at DESC);
