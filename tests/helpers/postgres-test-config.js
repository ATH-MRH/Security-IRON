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
module.exports = { testEnvironment };
