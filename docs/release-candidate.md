# SECURISITE RELEASE CANDIDATE — HUMAN REVIEW REQUIRED (PG-30)

Ce document liste, condition par condition, la **preuve démontrée** pour
chacune des exigences du MASTER AUTONOMOUS ROADMAP à ce point (PG-16→PG-30).
Aucune case n'est cochée sans une commande exécutée et son résultat observé
dans cette session — pas d'affirmation sans preuve.

## Conditions démontrées

| Condition | Preuve |
|---|---|
| `npm test` = 0 échec, 0 skip | 926/926 tests verts, `skipped:0`, exécuté à répétition (dernière exécution : voir ci-dessous), aucun `.only`/`.skip`/`.todo` dans `tests/*.js` |
| Suites PostgreSQL vertes | Toutes incluses dans `tests/*.test.js` (glob `npm test`) — RLS réelle exercée par `tests/postgres-rls.test.js`, `tests/postgres-scope-rls.test.js` (PG-28), `tests/postgres-acceptance.test.js` (PG-29) |
| e2e vert | `tests/postgres-e2e.test.js` inclus et vert |
| Sécurité : aucun blocage critique connu | `docs/security-hardening.md` (8 correctifs, dont la porte dérobée `system_admin` trouvée en PG-28/adressée en hardening) + revue adversariale finale PG-30 (voir plus bas) |
| Readiness verte | `backend/db/postgresql/readiness.js#assertReady` testé dans `tests/postgres-*-readiness.test.js` et `tests/postgres-alert-core-readiness.test.js`, tous verts |
| Backup/restore vert | `tests/postgres-backup-restore.test.js` : 2/2, cycle complet sauvegarde → destruction → restauration → vérification |
| `git diff --check` propre | `git diff --check origin/feature/securisite-postgresql...HEAD` → exit 0 |
| `node --check` propre | Chaque fichier `.js` sous `backend/`, `frontend/js/`, `scripts/`, `server.js` : aucune erreur de syntaxe |
| Arbre de travail propre | `git status -sb` → aucun fichier modifié/non suivi |

### Dernière exécution complète (état final avant ce rapport)

```
1..926
# tests 926
# suites 0
# pass 926
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Base et rôles PostgreSQL jetables résiduels après cette exécution : **0**
(vérifié par requête directe sur `pg_database`/`pg_roles`).

## Revue adversariale finale (PG-30)

En plus des revues déjà documentées lot par lot (`docs/security-hardening.md`,
`docs/postgresql-scope.md`, `docs/postgresql-security-audit.md`,
`docs/postgresql-deployment.md`) :

- **Injection de commande** (`child_process.spawn`, `backend/camera.js`,
  proxy caméra IP — hors périmètre de la migration PostgreSQL, non touché
  par ce roadmap) : `spawn(binaire, args[])` sans `shell: true`, protocole
  RTSP/HTTP(S) explicitement filtré via `new URL()` — aucune injection de
  shell possible par construction. Vérifié, pas modifié.
- **SQL dynamique** (`backend/db/postgresql/import-sqlite.js`) : les seuls
  identifiants interpolés dans un template SQL (`spec.name`, noms de
  colonnes) proviennent d'une liste fixe interne au module, jamais d'une
  entrée HTTP — aucune requête applicative ne concatène une valeur
  utilisateur dans le texte SQL (paramètres liés `$1,$2,…` partout ailleurs,
  déjà vérifié en PG-25).
- **Fuite de rôles PostgreSQL de test** (hygiène, pas une vulnérabilité
  applicative) : ~700 rôles orphelins accumulés pendant la session,
  cause identifiée et corrigée (PG-29, voir `docs/acceptance.md`), nettoyés.

Aucune nouvelle vulnérabilité critique trouvée lors de cette passe finale.

## Ce qui N'EST PAS couvert ici — limites connues, pas des trous silencieux

- **Aucune IA réelle, aucun fournisseur payant** : `LocalAIProvider`
  déterministe uniquement (PG-19). Le choix d'un fournisseur IA réel reste
  un **HUMAN CHECKPOINT REQUIRED** explicite (`docs/ai.md`), jamais décidé
  automatiquement.
- **Aucun secret réel, aucune production** : tous les tests tournent contre
  des bases PostgreSQL locales jetables (`securisite_test*`), avec des
  identifiants générés par test. `docs/postgresql-deployment.md` §4
  (« Checklist secrets ») documente ce qu'un déploiement réel doit fournir
  (JWT_SECRET ≥32, mots de passe MIGRATOR/APP, `SECURISITE_ADMIN_PASSWORD`)
  — rien de tout cela n'a été généré ni utilisé pour un environnement réel
  dans cette session.
- **Aucun push, aucune réécriture d'historique** : tous les commits de cette
  session sont locaux à `feature/securisite-postgresql`.
- **Performance/charge** (PG-26) : mesures réelles (p50/p95/p99) produites
  par `scripts/benchmark.js` sur un poste de développement local — pas une
  validation à l'échelle de production réelle, qui dépend du matériel/de la
  charge cible.
- **Rétention `security_audit`** : aucune purge automatique n'existe
  (`docs/postgresql-security-audit.md`, « Limites connues ») — décision
  opérationnelle future, hors périmètre.
- **`ip_address` d'audit** : `req.ip` brut, aucun `trust proxy` configuré
  (`docs/postgresql-security-audit.md`) — un déploiement derrière un reverse
  proxy réel doit le configurer avant de faire confiance à ce champ.

## Conclusion

Toutes les conditions vérifiables dans cet environnement (tests, lint
syntaxique, hygiène git, revue adversariale du code existant) sont
démontrées et vertes. Ceci **ne constitue pas** une déclaration de
disponibilité en production : les points listés dans « Ce qui n'est pas
couvert ici » — en particulier les secrets réels et le choix d'un
fournisseur IA — restent des décisions humaines explicites, jamais prises
ici.

**SECURISITE RELEASE CANDIDATE — HUMAN REVIEW REQUIRED.**
