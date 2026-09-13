const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('./database');
const securityAudit = require('./security-audit');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const router = express.Router();

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
    const user = await db.get('SELECT * FROM users WHERE username = $1', [username]);
    if (!user) { await auditFailure(String(username)); return res.status(401).json({ error: 'Identifiants invalides' }); }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) { await auditFailure(user.username); return res.status(401).json({ error: 'Identifiants invalides' }); }
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
