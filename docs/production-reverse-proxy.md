# SécuriSite — reverse proxy production (security.irongs.com)

Ce document liste les **exigences** que le reverse proxy déjà en place (ou
à installer) sur le serveur dédié doit satisfaire — il **n'installe ni ne
choisit** Nginx, Caddy, Traefik ou Coolify à la place de ce qui existe déjà
sur ce serveur. Information manquante à ce stade : lequel de ces systèmes
(ou un autre) tourne réellement sur le serveur cible.

## Exigences, quel que soit le proxy retenu

1. **Domaine et TLS**
   - `security.irongs.com` -> le conteneur `app` (port interne `3000`).
   - Certificat TLS valide pour ce domaine (Let's Encrypt automatique via
     le proxy si disponible, ou certificat fourni séparément).
   - Redirection HTTP -> HTTPS systématique.

2. **SSE (temps réel, `/api/realtime/stream`) sans buffering**
   Un proxy qui bufferise la réponse casse le flux (les événements
   n'arrivent jamais, ou tous d'un coup à la fermeture de la connexion).
   La connexion reste ouverte indéfiniment côté serveur (heartbeat toutes
   les 15 s, `backend/realtime-routes.js`) — le délai de lecture du proxy
   sur ce chemin précis doit être largement supérieur (ou désactivé).
   **À vérifier explicitement après mise en place**, quel que soit le
   proxy (voir §"Vérification").

3. **Un seul backend, jamais de répartition de charge entre plusieurs
   instances `app`** — le bus temps réel (`backend/realtime.js`) est en
   mémoire, mono-processus (`docs/realtime.md`). Un load-balancer round-robin
   entre deux conteneurs `app` ferait manquer des événements à certains
   clients. Un seul conteneur `app`, redémarré par Docker en cas de crash
   (`restart: unless-stopped`), est le modèle supporté aujourd'hui.

4. **En-têtes standards à préserver** (`X-Forwarded-For`,
   `X-Forwarded-Proto`) — nécessaires si `app.set('trust proxy', …)` est
   ajouté côté application pour que `req.ip` reflète le client réel dans
   les journaux d'audit (`security_audit`) plutôt que l'IP du proxy — voir
   `docs/production-readiness-plan.md` §11, changement de code **non fait**
   dans cette préparation (hors périmètre "aucune action").

5. **Aucune mise en cache de `/api/*`** côté proxy — ces réponses sont
   dynamiques et authentifiées (déjà appliqué côté application,
   `frontend/sw.js`, `docs/pwa.md` ; à ne pas contredire côté proxy).

6. **HTTPS obligatoire pour la PWA** (`frontend/sw.js` ne s'enregistre que
   dans un contexte sécurisé) — conséquence directe du point 1, pas une
   exigence supplémentaire.

## Selon ce qui est déjà présent sur le serveur

### Le serveur a déjà Nginx ou Caddy (installés hors Docker, sur l'hôte)

- `app` doit lier son port sur le loopback uniquement :
  `docker-compose.prod.yml` — décommenter `ports: ["127.0.0.1:3000:3000"]`
  sur le service `app` (jamais `0.0.0.0:3000:3000`).
- Nginx (exemple, chemin SSE isolé) :
  ```nginx
  location /api/realtime/stream {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_read_timeout 3600s;
      proxy_set_header Connection '';
  }
  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```
- Caddy gère le SSE sans configuration particulière par défaut (pas de
  buffering de réponse) — vérifier tout de même après mise en place
  (§"Vérification").

### Le serveur a déjà Traefik ou Coolify (proxy conteneurisé)

- `app` ne doit **pas** publier de port : le rejoindre au réseau Docker
  partagé du proxy à la place de/en plus de `internal`
  (`docker-compose.prod.yml`, section commentée dans le service `app`) —
  **nom exact du réseau partagé à vérifier sur le serveur**
  (`docker network ls`).
- Labels Traefik (exemple, à adapter au nom réel du réseau) :
  ```yaml
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.securisite.rule=Host(`security.irongs.com`)"
    - "traefik.http.routers.securisite.tls=true"
    - "traefik.http.routers.securisite.tls.certresolver=<resolver existant>"
    - "traefik.http.services.securisite.loadbalancer.server.port=3000"
  ```
  Traefik ne bufferise pas les réponses par défaut (SSE fonctionne sans
  configuration supplémentaire) — vérifier tout de même (§"Vérification").
- Coolify pilote généralement Traefik en arrière-plan : mêmes exigences,
  interface différente pour les déclarer (domaine + port cible) — la
  procédure exacte dépend de la version de Coolify installée.

## Vérification (après mise en place, quel que soit le proxy)

1. `curl -I https://security.irongs.com/api/health` -> `200`, certificat
   valide.
2. `curl -N https://security.irongs.com/api/realtime/stream` (avec un
   ticket ou un Bearer valide) -> la connexion reste ouverte, un
   `:heartbeat` apparaît toutes les 15 s sans que la commande ne se
   termine ni ne bloque en silence jusqu'à un timeout du proxy.
3. Installer la PWA depuis un navigateur mobile/desktop réel (icône
   « Ajouter à l'écran d'accueil ») -> réussit uniquement si HTTPS est
   correctement servi de bout en bout.
