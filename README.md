# SécuriSite — SOC / Centre de Sûreté du Site

Application full-stack pour la gestion des événements de sûreté sur site :
contrôle d'accès (véhicules, piétons, visiteurs, employés), parking, badges/QR,
journal d'incidents, main courante temps réel, LAPI (lecture automatique de plaques).

## Stack

- **Backend** : Node.js + Express + SQLite intégré à Node.js (node:sqlite)
- **Frontend** : HTML / CSS / JavaScript (vanilla, sans framework)
- **Auth** : JWT
- **OCR LAPI** : Tesseract.js (côté navigateur)
- **Charts** : Chart.js
- **QR** : qrcodejs

## Prérequis

- Node.js 22.13+ (SQLite intégré requis)
- npm

## Installation

```bash
git clone <votre-repo>
cd securisite
npm install
cp .env.example .env
# (optionnel) éditez .env pour changer le port ou le secret JWT
npm run init-db          # initialise la base SQLite + données de démo
npm run server           # interface web locale
```

Ouvrez ensuite [http://localhost:3000](http://localhost:3000)

Pour lancer l'application Electron native :

```bash
npm start
```

**Identifiants démo** : `admin` / `securisite`

## Mode développement (auto-reload)

```bash
npm run dev
```

## Structure

```
securisite/
├── server.js                # Point d'entrée Express
├── package.json
├── .env.example
├── data/                    # Base SQLite (créée auto)
├── backend/
│   ├── database.js          # Connexion + schéma SQLite
│   ├── seed.js              # Données de démo
│   ├── auth.js              # Routes d'authentification + middleware JWT
│   └── routes.js            # Toutes les routes /api/*
└── frontend/
    ├── index.html
    ├── css/
    │   └── style.css
    └── js/
        ├── api.js           # Client HTTP (fetch wrapper)
        ├── ui.js            # Modal, notifications, helpers
        ├── app.js           # Navigation, login, init
        ├── dashboard.js
        ├── maincourante.js
        ├── incidents.js
        ├── vehicules.js
        ├── lapi.js
        ├── pietons.js
        ├── visiteurs.js
        ├── employes.js
        ├── parking.js
        ├── badges.js
        ├── rapports.js
        └── parametres.js
```

## Endpoints API

Toutes les routes sont sous `/api/`. JWT requis sauf `/api/auth/login`.

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/auth/login` | Connexion (retourne un JWT) |
| GET | `/api/auth/me` | Infos utilisateur courant |
| GET/POST | `/api/employes` | Liste / créer un employé |
| PUT/DELETE | `/api/employes/:id` | Modifier / supprimer |
| GET/POST | `/api/visiteurs` | Liste / préenregistrement |
| PUT | `/api/visiteurs/:id/checkin` | Check-in d'un visiteur |
| PUT | `/api/visiteurs/:id/checkout` | Check-out d'un visiteur |
| GET/POST | `/api/vehicules` | Liste / entrée véhicule |
| PUT | `/api/vehicules/:id/sortie` | Sortie véhicule |
| GET/POST | `/api/pietons` | Liste / saisir passage |
| GET/POST/PUT | `/api/incidents` | Liste / déclarer / mettre à jour |
| GET/POST | `/api/badges` | Liste / générer un badge |
| GET | `/api/parking` | État complet du parking |
| PUT | `/api/parking/places/:num` | Occuper / libérer une place |
| GET/POST/DELETE | `/api/maincourante` | Main courante |
| GET/POST/DELETE | `/api/lapi` | Lectures LAPI |
| GET | `/api/rapports` | Statistiques agrégées |
| GET/PUT | `/api/parametres` | Paramètres du site |

## Sécurité

- Mots de passe hachés avec bcrypt
- Authentification par JWT (header `Authorization: Bearer <token>`)
- À durcir avant production : HTTPS, rate-limiting, CSP, validation stricte

## Licence

MIT


## SécuriSite 2.0 — première livraison Alert Core

Le centre d’alertes devient l’écran d’accueil après connexion. Il ajoute les niveaux 1–4,
le suivi opérationnel, l’acquittement SOC, les escalades persistantes, les notifications
internes, les demandes de fausse alerte et un journal non modifiable depuis l’API.
Les incidents majeurs/critiques et les refus répétés d’un badge alimentent ce centre.

```bash
npm run server
npm test
```

La migration ajoute des tables sans supprimer les données existantes. Les tests utilisent
une base temporaire et un serveur local sur un port libre.

Voir [la portée, les règles et les limites de cette livraison](docs/alert-core.md).
