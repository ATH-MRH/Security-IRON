'use strict';
/**
 * PG-10 — identifiant de requête pour corréler les événements de
 * security_audit d'une même requête HTTP (request_id) et, potentiellement,
 * d'une même opération métier plus large (correlation_id — non posé
 * automatiquement ici : laissé à l'appelant qui sait relier plusieurs
 * requêtes, ex. un futur flux SOS).
 *
 * IP : `req.ip`, jamais `X-Forwarded-For` directement — server.js ne configure
 * aucun `trust proxy`, donc Express ignore cet en-tête et `req.ip` reflète le
 * pair TCP direct. Un déploiement derrière un reverse proxy réel devra
 * documenter et configurer `trust proxy` explicitement avant que cet en-tête
 * ne devienne fiable ; ce n'est pas fait ici sans ce choix de déploiement.
 */
const { randomUUID } = require('node:crypto');

function requestContext() {
  return (req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}

module.exports = { requestContext };
