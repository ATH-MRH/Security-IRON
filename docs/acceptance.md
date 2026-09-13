# SécuriSite — acceptation complète (PG-29)

`tests/postgres-acceptance.test.js` : un seul parcours de bout en bout, sous
le rôle applicatif RÉEL (`securisite_app`, RLS pleinement appliquée — même
technique que `tests/postgres-scope-rls.test.js`, PG-28), qui a trouvé deux
régressions critiques invisibles sous le superutilisateur de test habituel.
Pas un test unitaire de plus : la preuve que le système entier fonctionne
ensemble, dans l'ordre où une exploitation réelle l'utiliserait.

## Scénario traversé

Provisionnement (deux tenants A et B, via l'outillage réel — **aucune route
de création de tenant n'existe au runtime**, décision PG-8 délibérée) →
login → passage badge (métier historique) → incident critique → déclenchement
automatique d'une alerte Alert Core (règle `incidentCritical`) → résumé IA de
l'incident → visibilité SOC (accès `scope`) et agent (accès `own`) → notification
réelle (pas simulée) → cycle de vie complet de l'alerte (`ACQUITTEE` →
`EN_INTERVENTION` → `SOUS_CONTROLE` → `RESOLUE` → `CLOTUREE`, réservé au SOC) →
audit (`security_audit` + `alert_audit`, filtré RLS au tenant de l'acteur) →
SOS (signal direct, propre alerte) → recherche IA → corrélation IA (réservée
SOC) → assistant IA (jamais l'autorité d'une transition — vérifié
explicitement : l'alerte reste `CLOTUREE` après l'appel).

## Scénarios négatifs

- Cross-tenant : l'agent du tenant B ne voit jamais l'alerte du tenant A
  (ni dans la liste, ni par accès direct à l'id — 404, jamais 403 révélateur).
- Un utilisateur sans membership est refusé (RLS n'élargit jamais un accès
  déjà refusé par la couche applicative, PG-8).
- Une transition hors machine à états (`NOTIFIEE` → `RESOLUE` directement)
  est un 409 métier, jamais un 500.
- Un agent (non-SOC) tentant une transition reçoit 403.

## Aucune IA réelle

`backend/ai/provider.js#LocalAIProvider` (déterministe, aucune clé, aucun
fournisseur externe — PG-19) est le provider par défaut : aucune
configuration supplémentaire n'est nécessaire pour ce test. Conforme à la
contrainte du MASTER ROADMAP : un fournisseur payant reste un HUMAN
CHECKPOINT REQUIRED, jamais choisi automatiquement.

## Hygiène des tests — correctif PG-29

En construisant ce test, une fuite de rôles PostgreSQL a été découverte dans
trois fichiers plus anciens (`tests/postgres-rls.test.js`,
`tests/postgres-security-audit.test.js`, `tests/postgres-ai-audit.test.js`) :
le rôle restreint de chaque test reçoit ses GRANT dans la base **jetable**,
mais son nettoyage (`t.after()`, à la fin de CE test précis) s'exécutait sur
une connexion `root` restée sur la base de **base**, bien avant que le
`after()` global du fichier (à la toute fin, une fois TOUS les tests
terminés) ne détruise la base jetable — `DROP OWNED BY` ne voyait donc rien,
et `DROP ROLE` échouait silencieusement (`.catch(() => {})`), laissant le
rôle orphelin pour toujours une fois la base détruite. Constaté
empiriquement : près de 700 rôles `sec_test_rls_*`/`sec_test_secaudit_*`/
`sec_test_aiaudit_*` accumulés au fil des exécutions répétées de la suite
pendant cette session. Corrigé : chaque rôle créé est désormais consigné
dans un tableau de module, et le `after()` global les `DROP ROLE` **après**
avoir détruit la base jetable (le rôle ne porte alors plus aucun GRANT nulle
part). Sans effet sur la production : ces rôles n'existent jamais que dans
des bases PostgreSQL locales jetables créées par la suite de tests
elle-même.
