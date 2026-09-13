// No fallback to DATABASE_URL: integration tests require an explicitly named local test DB.
function testEnvironment(env = process.env) {
  const raw = env.SECURISITE_TEST_DATABASE_URL;
  if (!raw) throw new Error('SECURISITE_TEST_DATABASE_URL requis pour les tests PostgreSQL réels');
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL de test PostgreSQL invalide'); }
  const host = url.hostname.replace(/^\[|\]$/g,'');
  let name;
  try { name = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error('Nom de base de test invalide'); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','::1'].includes(host) ||
      !/^securisite_test(?:_[a-z0-9]+)*$/.test(name) || /prod|production/i.test(name) || url.search || url.hash || !url.username) {
    throw new Error('Tests refusés : base securisite_test[_suffixe] locale explicitement requise');
  }
  return { NODE_ENV:'test', DATABASE_URL:raw, PGSSL:env.SECURISITE_TEST_PGSSL || 'disable',
    ...(env.SECURISITE_TEST_PGSSLROOTCERT ? { PGSSLROOTCERT:env.SECURISITE_TEST_PGSSLROOTCERT } : {}),
    PGPOOL_MAX:'2', PGCONNECT_TIMEOUT_MS:'3000', PGSTATEMENT_TIMEOUT_MS:'5000' };
}
// PG-8 activates scope enforcement: any account exercising business or Alert
// Core routes needs an active membership, exactly as migration 004's backfill
// would have provisioned it (mirrored here, not re-implemented differently,
// since these test users are inserted after the migration already ran).
// `client` needs only `.query()` — a raw `pg.Client` or a db-module client both work.
async function seedMembership(client, userId, role) {
  const membershipRole = role === 'admin' ? 'soc' : 'agent';
  const alertAccess = role === 'admin' ? 'scope' : 'own';
  await client.query(`
    INSERT INTO public.memberships (user_id, tenant_id, role, alert_access)
    SELECT $1, t.id, $2, $3 FROM public.tenants t WHERE t.code = 'local'
    ON CONFLICT (user_id, tenant_id, role) WHERE site_id IS NULL AND zone_id IS NULL DO NOTHING`,
    [userId, membershipRole, alertAccess]);
}

module.exports = { testEnvironment, seedMembership };
