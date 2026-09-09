/** PostgreSQL infrastructure only. PG-1 does not create or migrate business tables. */
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const transactionContext = new AsyncLocalStorage();

function configuration(env = process.env) {
  const localMode = ['test','development'].includes(env.NODE_ENV);
  const number = (name, fallback, max = 2147483647) => {
    const raw = env[name] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error('Configuration PostgreSQL invalide : ' + name);
    return Number(raw);
  };
  let host, port, database, user, password;
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!['postgres:','postgresql:'].includes(url.protocol) || url.search || url.hash) throw new Error();
      host = url.hostname.replace(/^\[|\]$/g, '');
      port = Number(url.port || 5432);
      database = decodeURIComponent(url.pathname.slice(1));
      user = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
      if (!host || !user || !database || database.includes('/') || port < 1 || port > 65535) throw new Error();
    } catch { throw new Error('DATABASE_URL invalide : URI PostgreSQL complète sans paramètres attendue'); }
  } else {
    host = env.PGHOST; database = env.PGDATABASE; user = env.PGUSER; password = env.PGPASSWORD;
    port = number('PGPORT',5432,65535);
    if (!host || !database || !user) throw new Error('Configuration PostgreSQL requise : DATABASE_URL ou PGHOST/PGDATABASE/PGUSER/PGPASSWORD');
  }
  if (!password && !localMode) throw new Error('Authentification PostgreSQL explicite requise hors développement/test');
  const sslMode = env.PGSSL ?? 'verify-full';
  if (!['disable','verify-full'].includes(sslMode)) throw new Error('PGSSL doit être disable ou verify-full');
  const ssl = sslMode === 'disable' ? false : { rejectUnauthorized: true };
  if (env.PGSSLROOTCERT) {
    if (!ssl) throw new Error('PGSSLROOTCERT nécessite PGSSL=verify-full');
    try { ssl.ca = fs.readFileSync(env.PGSSLROOTCERT, 'utf8'); }
    catch { throw new Error('Certificat PostgreSQL PGSSLROOTCERT illisible'); }
  }
  return {
    host, port, database, user, password: password || (() => ''), ssl,
    max: number('PGPOOL_MAX',10,1000),
    connectionTimeoutMillis: number('PGCONNECT_TIMEOUT_MS',5000),
    idleTimeoutMillis: number('PGIDLE_TIMEOUT_MS',30000),
    statement_timeout: number('PGSTATEMENT_TIMEOUT_MS',15000),
    idle_in_transaction_session_timeout: number('PGTRANSACTION_IDLE_TIMEOUT_MS',60000),
    application_name: 'securisite',
  };
}

// Preserve the primary error; immutable errors are retained as cause of a wrapper.
function withSecondary(primary, name, secondary) {
  if (!secondary || secondary === primary) return primary;
  try {
    Object.defineProperty(primary, name, { value: secondary, enumerable: false, configurable: true });
    return primary;
  } catch {
    const wrapped = new Error('Erreur transactionnelle PostgreSQL avec erreur secondaire', { cause: primary });
    if (primary?.code) wrapped.code = primary.code;
    Object.defineProperty(wrapped, name, { value: secondary });
    return wrapped;
  }
}

function createDatabase(env = process.env, { PoolClass = Pool } = {}) {
  const pool = new PoolClass(configuration(env));
  let closing = null;
  // Never log connection config, SQL, URL, password or raw driver error details.
  pool.on('error', () => { console.error('[DB] Connexion PostgreSQL inactive interrompue'); });
  function outsideTransaction() {
    if (transactionContext.getStore()) throw new Error('Utiliser le client transactionnel ; pool et transactions imbriquées interdits');
    if (closing) throw new Error('Pool PostgreSQL fermé');
  }
  async function query(sql, params = []) {
    outsideTransaction();
    return pool.query(sql, params);
  }
  const get = async (sql, params = []) => (await query(sql, params)).rows[0] ?? null;
  const all = async (sql, params = []) => (await query(sql, params)).rows;
  async function transaction(callback) {
    outsideTransaction();
    if (typeof callback !== 'function') throw new TypeError('Callback transactionnel requis');
    const connection = await pool.connect();
    let begun = false, destroy = false, active = false, clientError;
    const onClientError = error => { clientError ||= error; destroy = true; };
    connection.on('error', onClientError);
    const client = Object.freeze({
      query: async (sql, params = []) => {
        if (!active) throw new Error('Client transactionnel hors durée de vie');
        if (clientError) throw clientError;
        return connection.query(sql, params);
      },
      get: async (sql, params = []) => (await client.query(sql, params)).rows[0] ?? null,
      all: async (sql, params = []) => (await client.query(sql, params)).rows,
    });
    try {
      await connection.query('BEGIN'); begun = true;
      if (clientError) throw clientError;
      active = true;
      const result = await transactionContext.run(true, () => callback(client));
      active = false;
      if (clientError) throw clientError;
      const commit = await connection.query('COMMIT');
      if (clientError) throw clientError;
      // PostgreSQL can answer ROLLBACK to COMMIT if a caller swallowed a SQL error.
      if (commit.command === 'ROLLBACK') throw new Error('Transaction PostgreSQL annulée après erreur SQL');
      return result;
    } catch (error) {
      active = false;
      if (begun) {
        try { await connection.query('ROLLBACK'); }
        catch (rollbackError) {
          destroy = true;
          error = withSecondary(error, 'rollbackError', rollbackError);
        }
      } else destroy = true;
      throw withSecondary(error, 'clientError', clientError);
    } finally {
      active = false;
      connection.removeListener('error', onClientError);
      connection.release(destroy);
    }
  }
  async function init() {
    try { await query('SELECT 1 AS ok'); }
    catch (error) { throw new Error('Connexion PostgreSQL impossible', { cause: error }); }
  }
  function close() {
    if (transactionContext.getStore()) return Promise.reject(new Error('Fermeture du pool interdite dans une transaction'));
    if (!closing) closing = pool.end();
    return closing;
  }
  return { query, get, all, transaction, init, close,
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }) };
}

// Requiring this module does not open a connection or read/create a database file.
let instance, singletonClosing;
const current = () => {
  if (singletonClosing) throw new Error('Pool PostgreSQL fermé');
  return instance || (instance = createDatabase());
};
module.exports = {
  configuration, createDatabase,
  query: async (...args) => current().query(...args),
  get: async (...args) => current().get(...args),
  all: async (...args) => current().all(...args),
  transaction: async (...args) => current().transaction(...args),
  init: async () => current().init(),
  close: () => {
    if (transactionContext.getStore()) return Promise.reject(new Error('Fermeture du pool interdite dans une transaction'));
    if (!singletonClosing) singletonClosing = instance ? instance.close() : Promise.resolve();
    return singletonClosing;
  },
};
