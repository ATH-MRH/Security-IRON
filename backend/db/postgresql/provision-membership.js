'use strict';
/**
 * Provisionne l'appartenance locale d'un utilisateur (rôle admin/agent) sous le
 * tenant « local » : admin -> soc (accès scope), agent -> agent (accès own).
 *
 * Idempotent : ne réactive ni n'élargit jamais une appartenance existante
 * (ON CONFLICT DO NOTHING sur l'index unique de niveau tenant).
 *
 * À exécuter DANS une transaction : le contexte d'audit (securisite.actor_user_id
 * / securisite.audit_origin) est posé via SET LOCAL, lu par le trigger
 * membership_audit_write. NON branché au runtime — réservé aux lots PG-8+.
 *
 * PG-10 : un provisioning réel écrit aussi une ligne security_audit
 * ('membership.create', origin='automation' — cet outil n'est pas un
 * handler HTTP) dans la MÊME transaction que l'INSERT memberships.
 *
 * @param exec   client de transaction PG-1 (query/get/all) ou le module database
 * @param userId identifiant users.id
 */
const database = require('../../database');
const securityAudit = require('../../security-audit');

async function provisionLocalMembership(exec, userId, { actorUserId = null, origin = 'provisioning' } = {}) {
  const client = exec && typeof exec.query === 'function' ? exec : database;
  await client.query("SELECT set_config('securisite.audit_origin', $1, true)", [String(origin)]);
  await client.query("SELECT set_config('securisite.actor_user_id', $1, true)",
    [actorUserId == null ? '' : String(actorUserId)]);

  const user = await client.get('SELECT id, role FROM public.users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('Utilisateur introuvable : ' + userId), { code: 'MEMBERSHIP_USER_UNKNOWN' });
  if (!['admin', 'agent'].includes(user.role)) return { provisioned: false, reason: 'role_hors_perimetre_local' };

  const role = user.role === 'admin' ? 'soc' : 'agent';
  const alertAccess = user.role === 'admin' ? 'scope' : 'own';
  const res = await client.query(`
    INSERT INTO public.memberships (user_id, tenant_id, role, alert_access)
    SELECT $1, t.id, $2, $3 FROM public.tenants t WHERE t.code = 'local'
    ON CONFLICT (user_id, tenant_id, role) WHERE site_id IS NULL AND zone_id IS NULL
    DO NOTHING
    RETURNING id, tenant_id`, [userId, role, alertAccess]);
  const provisioned = res.rowCount === 1;
  if (provisioned) {
    await securityAudit.record({
      origin: 'automation', actorUserId,
      tenantId: res.rows[0].tenant_id,
      eventType: 'membership.create', resourceType: 'membership', resourceId: String(res.rows[0].id),
      action: 'create', outcome: 'success',
      detail: { user_id: userId, role, alert_access: alertAccess },
    }, client);
  }
  return { provisioned, role, alert_access: alertAccess };
}

module.exports = { provisionLocalMembership };
