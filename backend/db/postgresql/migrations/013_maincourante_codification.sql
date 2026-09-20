-- MAIN COURANTE — GRILLE DE CODIFICATION ÉVÉNEMENTS.
--
-- Le formulaire de saisie passe d'un simple champ "Type" libre à une grille
-- d'événements codifiés (code + libellé + catégorie, référentiel métier
-- fourni par l'opérateur — voir backend/maincourante-events.js, source
-- unique partagée avec la validation serveur de POST /maincourante).
--
-- `type` (déjà existant) continue de porter le LIBELLÉ affiché — comportement
-- inchangé pour les lignes historiques (texte libre) comme pour les
-- nouvelles (libellé du référentiel). `code`/`categorie` sont les nouvelles
-- colonnes explicites demandées ("conserver au minimum : code événement ;
-- libellé ; catégorie"). NULLables : toute ligne existante reste valide,
-- aucune migration de données rétroactive n'est nécessaire ni tentée (on ne
-- peut pas déduire un code officiel a posteriori d'un texte libre historique
-- sans l'inventer).
ALTER TABLE public.main_courante ADD COLUMN code TEXT;
ALTER TABLE public.main_courante ADD COLUMN categorie TEXT;

-- `datetime` (TEXT, existant) reste l'heure d'événement éditable par l'agent
-- (ex. saisie a posteriori d'une ronde) — comportement UI inchangé. Mais la
-- traçabilité officielle ne doit jamais reposer uniquement sur une valeur
-- modifiable côté client (mission explicite) : `created_at` est l'horodatage
-- serveur, non falsifiable depuis le body (jamais dans la liste de colonnes
-- d'un INSERT applicatif, valeur posée uniquement par DEFAULT now(), même
-- convention que security_audit/tenants/memberships/push_subscriptions).
ALTER TABLE public.main_courante ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX idx_mc_code ON public.main_courante(code);
