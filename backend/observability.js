'use strict';
/**
 * PG-18 — une ligne de log JSON structurée par requête HTTP, sur stdout
 * (`console.log`), sans dépendance externe : cohérent avec le reste du
 * projet ("aucune nouvelle dépendance externe payante"), et suffisant pour
 * qu'un collecteur de logs (Docker, journald, un agrégateur managé)
 * l'ingère tel quel — c'est le format qui compte, pas le transport.
 *
 * Champs, MASTER ROADMAP §22 : request_id, correlation_id, tenant_id,
 * site_id, alert_id, error_code, duration (+ method/path/status/level,
 * nécessaires pour qu'une ligne de log soit exploitable seule).
 *
 * SÉCURITÉ — allowlist, jamais une liste noire : la ligne de log ne
 * contient QUE les champs explicitement listés ci-dessous. Ni `req.body`,
 * ni `req.headers`, ni `err.message` ne sont jamais lus ici — impossible
 * donc qu'un JWT, un mot de passe, `DATABASE_URL`, un jeton push complet ou
 * une clé IA (aucune n'existe encore dans ce code base) fuite par cette
 * voie, même si un de ces éléments existe ailleurs dans la requête. Une
 * liste noire (« ne jamais logger tel champ ») aurait le défaut d'oublier
 * un futur champ sensible ; une liste blanche ne peut pas.
 *
 * correlation_id : suit un en-tête entrant `X-Correlation-Id` s'il est
 * fourni par l'appelant (pour relier plusieurs requêtes HTTP d'une même
 * opération métier plus large côté client — un flux mobile multi-étapes,
 * par exemple), sinon retombe sur `request_id` (PG-10,
 * backend/request-context.js) — jamais vide. Sans rapport avec le
 * `correlation_id` mentionné mais volontairement non posé par PG-10 pour
 * security_audit (un journal de sécurité, contrat différent) : celui-ci
 * est une télémétrie opérationnelle, pas une preuve d'audit.
 *
 * error_code : posé par backend/http-errors.js#sendError sur
 * `res.locals.errorCode`, jamais recalculé ici (un seul point de vérité
 * pour "quel code résume cette erreur").
 *
 * Limite assumée : `res.on('finish', …)` ne se déclenche pas sur une
 * connexion abandonnée par le client avant la fin de la réponse (`close`
 * sans `finish`) — cette requête n'est alors jamais journalisée. Accepté :
 * un cas rare, sans conséquence pour une télémétrie opérationnelle (pas un
 * journal d'audit exhaustif comme security_audit).
 */
const SKIP_PATHS = new Set(['/api/health', '/api/ready']); // sondes fréquentes, jamais du signal opérationnel

function correlationIdOf(req) {
  const header = req.headers['x-correlation-id'];
  const trimmed = typeof header === 'string' ? header.trim() : '';
  return (trimmed && trimmed.length <= 200) ? trimmed : req.requestId;
}

function observability() {
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0];
    // Champs de cette ligne (tenant_id, alert_id, site_id) n'ont de sens que
    // pour un appel API : le shell frontend statique (HTML/CSS/JS/images,
    // servi hors /api par server.js) n'est jamais journalisé ici — un
    // access-log générique serait un signal différent, hors périmètre PG-18.
    if (!path.startsWith('/api/') || SKIP_PATHS.has(path)) return next();
    const startedAt = process.hrtime.bigint();
    req.correlationId = correlationIdOf(req);
    res.setHeader('X-Correlation-Id', req.correlationId);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const onAlertsRouter = req.baseUrl === '/api/alerts' && req.params && typeof req.params.id === 'string';
      const line = {
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info'),
        request_id: req.requestId || null,
        correlation_id: req.correlationId || null,
        method: req.method,
        path,
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        tenant_id: req.tenantId || null,
        site_id: (req.query && typeof req.query.site_id === 'string' && req.query.site_id) || null,
        alert_id: onAlertsRouter ? req.params.id : null,
        error_code: res.locals.errorCode || null,
      };
      console.log(JSON.stringify(line));
    });
    next();
  };
}

module.exports = { observability };
