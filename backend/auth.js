const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('node:crypto');
const db      = require('./database');
const securityAudit = require('./security-audit');

// PG-25 : un secret par défaut codé en dur ('dev-secret-change-me') permettait
// de forger un token valide pour N'IMPORTE QUEL compte (y compris admin) sur
// tout déploiement où JWT_SECRET aurait été oublié — le secret étant public
// (présent dans l'historique Git), ce n'était pas un filet de sécurité, c'était
// une porte dérobée silencieuse. Fail closed hors test/développement (même
// convention que backend/database.js#configuration, 'localMode') : un secret
// généré aléatoirement à chaque démarrage de processus n'affaiblit jamais la
// sécurité locale (aucun token émis n'a besoin de survivre à un redémarrage
// en test) et ferme définitivement cette porte partout ailleurs.
const LOCAL_MODE = ['test', 'development'].includes(process.env.NODE_ENV);
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (!LOCAL_MODE) throw new Error('JWT_SECRET requis : secret fort et non vide, aucune valeur par défaut hors test/développement (voir .env.example / docs/postgresql-deployment.md)');
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
} else if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET trop court (32 caractères minimum) : un secret faible permettrait de forger des tokens valides.');
}
const router = express.Router();

// PG-25 (hardening) : aucune protection contre le brute-force n'existait —
// un mot de passe pouvait être deviné par essais illimités. Compte
// uniquement les ÉCHECS (jamais les succès : la suite de tests existante
// enchaîne des dizaines de connexions réussies par fichier sans jamais en
// être ralentie) — deux compteurs indépendants, l'un ou l'autre suffit à
// bloquer : par compte ciblé (IP+identifiant, seuil bas — protège un compte
// précis d'un essai exhaustif) et par IP seule (seuil plus large — protège
// contre une pulvérisation sur de nombreux identifiants différents). Un
// succès réinitialise le compteur du compte ciblé (un mot de passe oublié
// puis retrouvé ne doit pas rester pénalisé). En mémoire, par processus :
// suffisant ici (aucun état partagé entre processus ailleurs dans ce code
// base — realtime.js/push.js sont déjà eux aussi en mémoire, PG-12/PG-13),
// jamais une nouvelle dépendance externe pour ce lot.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_ACCOUNT = 10;
const MAX_FAILURES_PER_IP = 50;
const accountFailures = new Map(); // 'ip|username' -> { count, windowStart }
const ipFailures = new Map();      // 'ip' -> { count, windowStart }
function bump(map, key) {
  const entry = map.get(key);
  if (!entry || Date.now() - entry.windowStart > FAILURE_WINDOW_MS) { map.set(key, { count: 1, windowStart: Date.now() }); return 1; }
  entry.count++; return entry.count;
}
function limited(map, key, max) {
  const entry = map.get(key);
  return Boolean(entry && Date.now() - entry.windowStart <= FAILURE_WINDOW_MS && entry.count >= max);
}
function sweepExpired() {
  const now = Date.now();
  for (const map of [accountFailures, ipFailures]) for (const [key, entry] of map) if (now - entry.windowStart > FAILURE_WINDOW_MS) map.delete(key);
}
const sweepTimer = setInterval(sweepExpired, FAILURE_WINDOW_MS);
sweepTimer.unref(); // ne retient jamais le processus vivant pour ce seul minuteur

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    // PG-10 : ni succès ni échec de login n'écrit de donnée métier à protéger
    // par un rollback — audité en best-effort (jamais de blocage/500 si le
    // journal est momentanément indisponible ; voir backend/security-audit.js).
    const auditBase = {
      requestId: req.requestId || null, origin: 'http',
      resourceType: 'session', action: 'login',
      ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
    };
    const auditFailure = actorUsername => securityAudit.recordBestEffort({
      ...auditBase, eventType: 'auth.login.failure', outcome: 'failure', actorUsername,
    });
    if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
    const ip = req.ip || '?';
    const accountKey = ip + '|' + String(username).toLowerCase();
    if (limited(ipFailures, ip, MAX_FAILURES_PER_IP) || limited(accountFailures, accountKey, MAX_FAILURES_PER_ACCOUNT)) {
      await securityAudit.recordBestEffort({ ...auditBase, eventType: 'auth.login.rate_limited', outcome: 'denied', actorUsername: String(username) });
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez plus tard.' });
    }
    const user = await db.get('SELECT * FROM users WHERE username = $1', [username]);
    if (!user) { bump(accountFailures, accountKey); bump(ipFailures, ip); await auditFailure(String(username)); return res.status(401).json({ error: 'Identifiants invalides' }); }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) { bump(accountFailures, accountKey); bump(ipFailures, ip); await auditFailure(user.username); return res.status(401).json({ error: 'Identifiants invalides' }); }
    accountFailures.delete(accountKey);
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    await securityAudit.recordBestEffort({
      ...auditBase, eventType: 'auth.login.success', outcome: 'success',
      actorUserId: user.id, actorUsername: user.username, actorRole: user.role,
    });
    res.json({
      token,
      user: { id: user.id, username: user.username, nom_complet: user.nom_complet, role: user.role }
    });
  } catch (e) { next(e); }
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.get(
      'SELECT id, username, nom_complet, role FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    res.json({ user });
  } catch (e) { next(e); }
});

// PG-12 : extrait pour être réutilisé par backend/realtime.js, qui accepte
// aussi ce même Bearer token (un client capable d'en envoyer un le fait ;
// EventSource ne le peut pas, d'où le ticket à usage unique en repli).
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = verifyToken(h.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

module.exports = { router, authMiddleware, verifyToken };
