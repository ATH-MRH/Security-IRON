# SécuriSite 2.0 — Alert Core, livraison initiale

Cette livraison implémente un premier périmètre du Lot A dans l’application existante.
Les lots B à E et le routage multi-clients ne sont pas implémentés.

## Utilisation

1. Démarrer avec `npm run server`.
2. Se connecter : le Centre d’alertes est affiché automatiquement.
3. Créer une alerte avec un site, un type et un niveau ; préciser la zone si connue.
4. Sélectionner l’alerte. Le SOC clique sur **Prendre en charge**, puis suit les états.
5. Ajouter les décisions et actions au journal. Pour une fausse alerte ou une annulation
   SOC, un motif est obligatoire. La demande du déclarant ne clôture pas l’événement.
6. Consulter la cloche : alertes non acquittées, incidents ouverts et visiteurs attendus
   coexistent dans des catégories distinctes. L’historique des notifications internes
   reste consultable ; ouvrir une notification marque sa lecture et affiche son alerte.

Les filtres portent sur le niveau, les alertes en cours, le site, le type et le déclarant.
Les compteurs sont calculés à partir des événements enregistrés. « Aujourd’hui » utilise
le fuseau du navigateur ; les dates stockées sont en UTC et générées par le serveur.
La prise en charge moyenne porte sur les alertes créées aujourd’hui et déjà acquittées.

## Autorisations et états

Dans cette version, le rôle existant `admin` représente le SOC. Les administrateurs
voient toutes les alertes ; les autres comptes voient celles qu’ils ont créées. Seul
le SOC effectue les transitions opérationnelles et les escalades manuelles.
L’identité et le rôle des requêtes Alert Core sont relus en base.

Création et notification interne sont atomiques : l’alerte est exposée en `NOTIFIEE`,
avec un événement `CREATION` distinct dans l’audit.

`NOTIFIEE → ACQUITTEE → EN_INTERVENTION → SOUS_CONTROLE → RESOLUE → CLOTUREE`

Les issues `FAUSSE_ALERTE` et `ANNULEE` sont terminales. L’escalade est tracée en parallèle
de l’état opérationnel, afin de ne pas empêcher l’acquittement. La demande d’annulation
reste visible. Un double acquittement est refusé (409).

## Règles et escalades

Le panneau **Règles & escalades** permet au SOC de configurer :

- la création d’alertes niveau 3 pour les nouveaux incidents majeurs/critiques ;
- un seuil de refus du même badge dans une fenêtre temporelle (3 en 120 s par défaut) ;
- trois paliers croissants d’escalade (30, 60 et 120 s par défaut).

Chaque alerte enregistre sa politique lors de la création : une modification de règles
ne change pas les échéances des alertes existantes. Le serveur vérifie les échéances
chaque seconde et rattrape les paliers échus au redémarrage, sans doublon. L’acquittement
ou une issue terminale arrête les escalades automatiques. Le serveur doit être en marche
pour traiter les échéances ; cette version n’est pas un service de haute disponibilité.

Les destinataires sont les administrateurs et le déclarant. Les paliers relancent ce
même groupe interne : il n’existe pas encore d’affectation à des responsables régionaux,
à la direction, à des astreintes ou à des destinataires par site. Les notifications sont
persistées dans SQLite ; « notifiée » signifie disponible dans la boîte interne, sans
preuve de réception sur un téléphone. Aucun push, SMS, appel ou e-mail n’est envoyé.

Les règles d’accès utilisent les dates des passages existants. Elles s’exécutent à
l’insertion d’un passage, sans relecture historique lors d’une modification de règle.
La déduplication du badge se fait dans la même fenêtre temporelle. La distinction
site/zone/client nécessite un futur référentiel d’identifiants, au-delà du site texte.

## Audit et stockage

Les créations d’incidents/passages et les alertes associées sont transactionnelles.
Les actions, notifications, lectures, acquittements, commentaires et escalades ont un
horodatage et un acteur. Les changements de configuration conservent avant/après dans
`alert_config_audit` (consultation admin via `GET /api/alerts/rules/audit`).

Des triggers SQLite interdisent UPDATE/DELETE sur les deux journaux ; aucune route
standard n’expose leur modification. Cela ne constitue pas une protection contre
un administrateur disposant d’un accès direct au fichier SQLite ou au code serveur.

## API

Toutes les routes exigent le JWT existant.

| Méthode | Route | Usage |
|---|---|---|
| GET / POST | `/api/alerts` | Liste autorisée / création |
| GET | `/api/alerts/:id` | Alerte et chronologie |
| POST | `/api/alerts/:id/actions` | `{action, comment}` |
| GET / PUT | `/api/alerts/rules` | Configuration SOC |
| GET | `/api/alerts/rules/audit` | Historique de configuration SOC |
| GET | `/api/alerts/notifications` | 200 dernières notifications personnelles |
| POST | `/api/alerts/notifications/:id/read` | Marquage de lecture |

Actions supplémentaires : `COMMENTAIRE`, `DEMANDE_ANNULATION`, `ESCALADE`,
`FAUSSE_ALERTE`, `ANNULEE`. Pas de route de suppression d’alerte.

## Validation

`npm test` : tests HTTP avec base temporaire, validation des entrées, accès par rôle,
transitions, acquittements concurrents, fausse alerte, immutabilité du journal,
escalades sans doublon, lecture personnelle, configuration et intégrations métier.

## Suite du cahier des charges

- Fin du Lot A : moteur de règles générique, référentiels clients/sites/zones,
  routage par rôle/site/horaire/astreinte, pièces jointes, SLA, notifications filtrables,
  pagination et diffusion événementielle (actualisation actuelle toutes les 5 s).
- Lot B : Guard et Client, SOS avec appui 3 s, SOS silencieux, récupération GPS,
  identité enrichie, états de transmission, reprise hors ligne et push mobiles.
- Lot C : carte, dispatch, missions agents, proximité caméras et suivi intervention.
- Lot D : travailleur isolé, capteurs, règles complexes et intégrations de sécurité.
- Lot E : Executive, analyses et rapports assistés par IA soumis à validation humaine.

Le formulaire d’alerte niveau 4 du SOC n’est pas le bouton SOS mobile décrit au Lot B.


## Corrections de périmètre et non-régression

La cloche conserve les critères historiques : `statut !== 'resolu'` pour les incidents,
`statut === 'attendu'` pour les visiteurs. Elle affiche les 8 premiers incidents et les
5 premiers visiteurs dans l’ordre renvoyé par leurs API, sans ajouter de filtre de date
ou de site. Les totaux indiquent tous les éléments répondant à ces critères. Les pages
métier et leurs filtres restent inchangés ; les anciennes lignes de cloche n’avaient pas
de navigation propre. La navigation vers les alertes et le marquage des notifications
lues sont conservés. La lecture n’acquitte pas une alerte.

Le compteur des alertes porte sur les états NOUVELLE/NOTIFIEE non acquittés, indépendamment
du nombre de relances. Les notifications restent disponibles dans un historique replié.
Un incident et son signal d’alerte demeurent deux objets, affichés dans deux catégories
explicites. Aucun objet n’est supprimé. Chaque famille utilise son API authentifiée
existante ; aucun droit n’est élargi. En cas d’échec, la famille est signalée indisponible
sans afficher de données en cache potentiellement obsolètes ou hors scope.

Les 404 JSON spécifiques sont limitées à `/api/alerts` et ses sous-routes. Les autres
routes gardent la réponse historique du framework.

La contrainte globale `engines.node >=22.13.0` ajoutée au Lot A est retirée : le backend
utilisait déjà `DatabaseSync` de `node:sqlite` avant ce lot, et Docker utilisait déjà
`node:22-alpine`. Ce n’était ni une dépendance nouvelle des seuls tests, ni une nouvelle
exigence propre au Lot A. La clarification globale des versions runtime est à traiter
séparément ; les prérequis historiques du README sont restaurés sans certifier leur
exactitude. Pour reproduire les tests SQLite de ce lot, utiliser Node 22.13+ ; la validation
locale est exécutée sous Node 22.22.2. Aucune dépendance ni configuration Docker ne change.
