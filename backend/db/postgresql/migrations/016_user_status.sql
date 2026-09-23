-- ============================================================
-- 016 — Administration Système : statut de compte (LOT 8).
--
-- users n'avait aucun moyen de désactiver un compte autrement que par
-- suppression (DELETE /admin/users/:id, déjà bloqué si le compte a des
-- appartenances — voir routes.js:168-174). Le mandat demande explicitement
-- activation/désactivation/blocage/déblocage : un compte bloqué doit
-- pouvoir être réactivé sans perdre son historique (appartenances,
-- security_audit), ce qu'une suppression ne permettrait pas.
--
-- last_login_at délibérément NON ajouté ici : le mandat dit "si réellement
-- disponible" — l'ajouter correctement suppose aussi d'instrumenter
-- backend/auth.js#login, hors périmètre de cette seule migration ; le
-- cockpit (LOT 2) omet ce champ plutôt que d'en fabriquer un.
-- ============================================================
ALTER TABLE public.users
    ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN blocked_at TIMESTAMPTZ,
    ADD CONSTRAINT users_blocked_at_chk CHECK ((status = 'blocked') = (blocked_at IS NOT NULL));

CREATE TRIGGER users_touch_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION securisite_meta.touch_updated_at();
