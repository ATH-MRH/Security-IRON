'use strict';
/**
 * Provisionne les trois rôles PostgreSQL de SécuriSite. À exécuter par un
 * administrateur du cluster (superuser ou rôle CREATEROLE).
 *
 *   OWNER    (NOLOGIN)  — propriétaire des objets ; ne se connecte jamais.
 *   MIGRATOR (LOGIN)    — membre d'OWNER ; exécute les migrations DDL.
 *   APP      (LOGIN)    — runtime uniquement : CONNECT + USAGE + le DML strict
 *                          déclaré par backend/db/postgresql/readiness.js.
 *                          Jamais propriétaire, superuser, CREATEROLE, CREATEDB,
 *                          BYPASSRLS, ni membre d'OWNER.
 *
 * Les mots de passe ne sont JAMAIS écrits dans le SQL émis, ni journalisés.
 *
 * L'outil est réexécutable. Les privilèges portant sur `securisite_meta` et sur
 * les tables métier ne sont accordés que si l'objet existe déjà : lancer une
 * première fois avant les migrations (rôles + CONNECT, via `apply`, superuser),
 * puis de nouveau après pour compléter les GRANT — mais cette seconde passe est
 * désormais faite automatiquement par backend/db/postgresql/migrate-cli.js
 * (voir `finalizeGrants` plus bas, exécuté avec la connexion MIGRATOR déjà en
 * main, sans superuser) : ne relancer `apply()` à la main que pour réparer un
 * déploiement déjà cassé (rôles/CONNECT absents).
 *
 * Usage :
 *   node backend/db/postgresql/provision-roles.js --emit    # imprime le SQL (psql \set)
 *   node backend/db/postgresql/provision-roles.js           # applique via DATABASE_URL/PG*
 *
 * Variables (mode application) :
 *   DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD  — connexion admin
 *   SECURISITE_MIGRATOR_PASSWORD, SECURISITE_APP_PASSWORD       — requis
 *   SECURISITE_OWNER_ROLE / SECURISITE_MIGRATOR_ROLE / SECURISITE_APP_ROLE
 *                          — noms de rôles (défaut securisite_owner/_migrator/_app)
 */
const { Client } = require('pg');
const { configuration } = require('../../database');
const { PRIVILEGES, RLS_FUNCTIONS } = require('./readiness');

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const q = s => '"' + String(s).replace(/"/g, '""') + '"';

function role(envName, fallback, env) {
  const name = env[envName] || fallback;
  if (!IDENT.test(name)) throw new Error(`Nom de rôle invalide (${envName}) : ${name}`);
  return name;
}

/** Création et attributs des rôles — toujours sûr, indépendant du schéma. */
function roleCreationStatements({ owner, migrator, app }) {
  const S = (sql, create = false) => ({ sql, create });
  return [
    S(`CREATE ROLE ${q(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`, true),
    S(`CREATE ROLE ${q(migrator)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;`, true),
    S(`CREATE ROLE ${q(app)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;`, true),
    S(`ALTER ROLE ${q(migrator)} PASSWORD :'migrator_password';`),
    S(`ALTER ROLE ${q(app)} PASSWORD :'app_password';`),
    S(`GRANT ${q(owner)} TO ${q(migrator)};`),      // MIGRATOR agit comme OWNER pour la DDL
    S(`REVOKE ${q(owner)} FROM ${q(app)};`),        // APP n'est jamais membre d'OWNER
  ];
}

/** Privilèges : CONNECT/USAGE/DML. Dépendent de l'existence de la base, du
 *  schéma `securisite_meta` et des tables métier. `present` filtre selon ce qui
 *  existe déjà (mode application) ; en --emit tout est émis. */
function grantStatements({ owner, app, migrator, db }, present = null) {
  const has = name => !present || present.has(name);
  const S = sql => ({ sql });
  const out = [
    S(`REVOKE ALL ON DATABASE ${q(db)} FROM PUBLIC;`),
    S(`GRANT CONNECT ON DATABASE ${q(db)} TO ${q(app)}, ${q(migrator)};`),
    S(`GRANT USAGE ON SCHEMA public TO ${q(app)};`),
  ];
  if (has('schema:securisite_meta')) out.push(S(`GRANT USAGE ON SCHEMA securisite_meta TO ${q(app)};`));
  for (const [table, verbs] of Object.entries(PRIVILEGES)) {
    if (has('table:' + table)) out.push(S(`GRANT ${verbs} ON public.${q(table)} TO ${q(app)};`));
  }
  if (has('table:securisite_meta.schema_migrations')) {
    out.push(S(`GRANT SELECT ON securisite_meta.schema_migrations TO ${q(app)};`));
  }
  // PG-9/PG-10 : RLS policies call these SECURITY DEFINER helpers — APP needs
  // EXECUTE to evaluate them at all.
  for (const fn of RLS_FUNCTIONS) {
    if (has('function:securisite_meta.' + fn)) out.push(S(`GRANT EXECUTE ON FUNCTION securisite_meta.${fn}() TO ${q(app)};`));
  }
  out.push(S(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(owner)} IN SCHEMA public GRANT SELECT ON TABLES TO ${q(app)};`));
  // Migrations actually run connected as MIGRATOR (never `SET ROLE owner` : forbidden
  // session control, see migrate.js#validateSQL), so objects are created with MIGRATOR
  // as relowner — the default privilege that fires for real tables is this one, not the
  // OWNER-scoped one above (kept for documentation/parity, harmless since it never
  // triggers). Discovered while wiring automatic post-migration grants (see migrate-cli.js).
  out.push(S(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator)} IN SCHEMA public GRANT SELECT ON TABLES TO ${q(app)};`));
  if (has('schema:securisite_meta')) {
    out.push(S(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(owner)} IN SCHEMA securisite_meta GRANT SELECT ON TABLES TO ${q(app)};`));
    out.push(S(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator)} IN SCHEMA securisite_meta GRANT SELECT ON TABLES TO ${q(app)};`));
  }
  return out;
}

function roleStatements(names) {
  return [...roleCreationStatements(names), ...grantStatements(names)];
}

function emitSQL(names) {
  return [
    '-- SécuriSite — rôles PostgreSQL. Réexécutable ; relancer après les migrations',
    '-- pour compléter les GRANT sur securisite_meta et les tables.',
    "-- Mots de passe :  psql -v migrator_password=... -v app_password=... -f roles.sql",
    '\\set ON_ERROR_STOP on',
    ...roleStatements(names).map(s => s.sql),
    '',
  ].join('\n');
}

const literalPassword = p => "'" + String(p).replace(/'/g, "''") + "'";

async function presentObjects(client) {
  const set = new Set();
  const schemas = await client.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('public','securisite_meta')");
  for (const r of schemas.rows) set.add('schema:' + r.nspname);
  const tables = await client.query(`
    SELECT n.nspname AS s, c.relname AS t FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','securisite_meta')`);
  for (const r of tables.rows) set.add('table:' + (r.s === 'public' ? r.t : r.s + '.' + r.t));
  const functions = await client.query(`
    SELECT n.nspname AS s, p.proname AS f FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'securisite_meta'`);
  for (const r of functions.rows) set.add('function:' + r.s + '.' + r.f);
  return set;
}

function resolveNames(env, db) {
  return {
    owner: role('SECURISITE_OWNER_ROLE', 'securisite_owner', env),
    migrator: role('SECURISITE_MIGRATOR_ROLE', 'securisite_migrator', env),
    app: role('SECURISITE_APP_ROLE', 'securisite_app', env),
    db,
  };
}

/** Applies exactly the GRANT/ALTER DEFAULT PRIVILEGES statements that exist for
 *  objects already present, against a connection that already has enough rights
 *  on them (an object's owner, or a role that inherits the owner's role — never
 *  requires CREATEROLE nor superuser). Shared by `apply` (admin connection, right
 *  after creating the roles) and `finalizeGrants` (MIGRATOR connection, right
 *  after applying migrations — see backend/db/postgresql/migrate-cli.js). */
async function grantPresent(client, names) {
  const present = await presentObjects(client);
  const deferred = !present.has('schema:securisite_meta')
    || Object.keys(PRIVILEGES).some(t => !present.has('table:' + t))
    || RLS_FUNCTIONS.some(fn => !present.has('function:securisite_meta.' + fn));
  for (const { sql } of grantStatements(names, present)) await client.query(sql);
  return deferred;
}

async function apply(env) {
  const migratorPassword = env.SECURISITE_MIGRATOR_PASSWORD;
  const appPassword = env.SECURISITE_APP_PASSWORD;
  if (!migratorPassword || !appPassword) {
    throw new Error('SECURISITE_MIGRATOR_PASSWORD et SECURISITE_APP_PASSWORD sont requis (jamais journalisés).');
  }
  const cfg = configuration(env);
  const names = resolveNames(env, cfg.database);
  const client = new Client({ ...cfg, application_name: 'securisite-provision' });
  await client.connect();
  let deferred = false;
  try {
    for (const { sql, create } of roleCreationStatements(names)) {
      const resolved = sql
        .replace(":'migrator_password'", literalPassword(migratorPassword))
        .replace(":'app_password'", literalPassword(appPassword));
      try { await client.query(resolved); }
      catch (err) { if (create && err.code === '42710') continue; throw err; }
    }
    deferred = await grantPresent(client, names);
  } finally { await client.end(); }
  return { ...names, deferred };
}

/**
 * Restores APP's runtime GRANTs on whatever securisite_meta/table/function
 * objects the migrations just (re)created — no admin/superuser connection, no
 * role passwords : run with the same MIGRATOR connection that applied the
 * migrations (MIGRATOR inherits OWNER, which owns the database and therefore
 * everything MIGRATOR creates in it, so it can GRANT on those objects itself).
 *
 * Closes the gap that caused production 42501s (missing USAGE on
 * securisite_meta, SELECT on securisite_meta.schema_migrations, EXECUTE on the
 * RLS helper functions) : those GRANTs used to depend on a second, manual,
 * superuser-driven run of `apply()` after migrations — easy to forget, and
 * `readiness.js` did not catch the gap. Idempotent ; safe to call after every
 * migration run, applied or not.
 */
async function finalizeGrants(migrationEnv) {
  const cfg = configuration(migrationEnv);
  const names = resolveNames(migrationEnv, cfg.database);
  const client = new Client({ ...cfg, application_name: 'securisite-provision-finalize' });
  await client.connect();
  try { return { ...names, deferred: await grantPresent(client, names) }; }
  finally { await client.end(); }
}

async function main() {
  if (process.argv.includes('--emit')) {
    process.stdout.write(emitSQL({
      owner: role('SECURISITE_OWNER_ROLE', 'securisite_owner', process.env),
      migrator: role('SECURISITE_MIGRATOR_ROLE', 'securisite_migrator', process.env),
      app: role('SECURISITE_APP_ROLE', 'securisite_app', process.env),
      db: process.env.SECURISITE_TARGET_DB || 'securisite',
    }));
    return;
  }
  const r = await apply(process.env);
  console.log('[provision-roles] rôles prêts :', r.owner + ',', r.migrator + ',', r.app, '(base ' + r.db + ')');
  if (r.deferred) console.log('[provision-roles] schéma incomplet : relancer après les migrations pour finir les GRANT.');
}

if (require.main === module) {
  main().catch(err => { console.error('[provision-roles]', err.message); process.exit(1); });
}

module.exports = { roleCreationStatements, grantStatements, roleStatements, emitSQL, apply, finalizeGrants };
