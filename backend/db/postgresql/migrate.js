'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Client } = require('pg');
const { configuration } = require('../../database');

// Two signed int32 keys: ASCII SECU, migration namespace 1. Never change between releases.
const LOCK_KEY = Object.freeze([0x53454355, 1]);
const TABLE = 'securisite_meta.schema_migrations';
const LEDGER_SQL = `CREATE SCHEMA securisite_meta;
CREATE TABLE securisite_meta.schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-fA-F]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL,
  execution_ms BIGINT NOT NULL CHECK (execution_ms >= 0)
)`;
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Lexical inspection only; PostgreSQL remains the SQL parser. Dollar bodies are opaque.
// Do not split on semicolons inside literals, identifiers, or nested comments.
function validateSQL(sql, name) {
  let i = 0, words = [], previousString = false, escapedString = false, newline = false;
  const invalid = () => { throw fail('INVALID_SQL', `Lexique SQL invalide : ${name}`); };
  const finish = () => {
    const first = words[0], pair = words.slice(0, 2).join(' ');
    if (['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'ABORT', 'SAVEPOINT', 'RELEASE'].includes(first) ||
        ['START TRANSACTION', 'PREPARE TRANSACTION'].includes(pair)) {
      throw fail('TRANSACTION_CONTROL', `Contrôle transactionnel interdit : ${name}`);
    }
    // Session settings belong to the runner; prevents changing lexical/search-path assumptions.
    if (['SET', 'RESET', 'DISCARD'].includes(first)) {
      throw fail('SESSION_CONTROL', `Commande de session interdite : ${name}`);
    }
    words = [];
  };
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { newline ||= c === '\n' || c === '\r'; i++; continue; }
    if (sql.startsWith('--', i)) { while (i < sql.length && !'\r\n'.includes(sql[i])) i++; continue; }
    if (sql.startsWith('/*', i)) {
      i += 2; let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else { newline ||= sql[i] === '\n' || sql[i] === '\r'; i++; }
      }
      if (depth) invalid();
      continue;
    }
    if (c === "'" || c === '"') {
      const escape = c === "'" && ((/[eE]/.test(sql[i - 1] || '') &&
        !/[\w$\u0080-\uffff]/.test(sql[i - 2] || '')) || (previousString && newline && escapedString));
      i++; let closed = false;
      while (i < sql.length) {
        if (escape && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) invalid();
      if (!words.length) words.push('<literal>');
      previousString = c === "'"; escapedString = escape; newline = false; continue;
    }
    previousString = false; newline = false;
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) invalid();
        i = end + tag.length;
        if (!words.length) words.push('<literal>');
        continue;
      }
    }
    if (c === ';') { finish(); i++; continue; }
    const word = /^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*/.exec(sql.slice(i))?.[0];
    if (word) { if (words.length < 2) words.push(word.toUpperCase()); i += word.length; }
    else { if (!words.length) words.push(c); i++; }
  }
  finish();
}

function discover(directory) {
  if (typeof directory !== 'string' || !directory) throw fail('CATALOG_REQUIRED', 'Répertoire de migrations explicite requis');
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow === 0) {
    throw fail('UNSUPPORTED_PLATFORM', 'O_NOFOLLOW requis pour ouvrir les migrations sans suivre de lien symbolique');
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true }).map(file => {
    const match = /^(\d{3})_([a-z][a-z0-9_]*)\.sql$/.exec(file.name);
    if (!match || !file.isFile()) throw fail('INVALID_CATALOG', `Fichier de migration invalide : ${file.name}`);
    let fd;
    try {
      // O_NONBLOCK also avoids hanging if an inventoried file is replaced by a FIFO.
      fd = fs.openSync(path.join(directory, file.name), fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK || 0));
    } catch (error) {
      throw fail('UNSAFE_MIGRATION_FILE', `Ouverture sûre de migration impossible : ${file.name}`, error);
    }
    let source;
    try {
      if (!fs.fstatSync(fd).isFile()) throw fail('INVALID_CATALOG', `Migration non régulière : ${file.name}`);
      source = fs.readFileSync(fd); // The opened descriptor, never the pathname, is authoritative.
    } finally { fs.closeSync(fd); }
    let sql;
    try { sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source); }
    catch { throw fail('INVALID_ENCODING', `Migration UTF-8 requise : ${file.name}`); }
    if (sql.includes('\0') || !Buffer.from(sql, 'utf8').equals(source)) throw fail('INVALID_ENCODING', `Octets SQL invalides : ${file.name}`);
    validateSQL(sql, file.name);
    return Object.freeze({ version: Number(match[1]), name: file.name, sql,
      checksum: createHash('sha256').update(source).digest('hex') });
  }).sort((a, b) => a.version - b.version);
  entries.forEach((entry, i) => {
    if (entry.version !== i + 1) throw fail('INVALID_VERSIONS', 'Versions attendues consécutives à partir de 001');
  });
  return entries;
}

function validateHistory(rows, entries) {
  rows.forEach((row, i) => {
    const file = entries[i];
    if (!file || row.version !== i + 1 || row.version !== file.version || row.name !== file.name || row.checksum !== file.checksum) {
      throw fail('HISTORY_MISMATCH', `Historique de migrations incohérent à la version ${row.version}`);
    }
    if (!(row.applied_at instanceof Date) || !Number.isFinite(row.applied_at.getTime()) ||
        !/^\d+$/.test(String(row.execution_ms))) throw fail('HISTORY_MISMATCH', 'Métadonnées de migration invalides');
  });
  return rows.length;
}

function bounded(value, fallback, name) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) throw fail('INVALID_OPTION', `Option invalide : ${name}`);
  return n;
}

async function openSession(config, ClientClass) {
  const client = new ClientClass(config);
  let clientError;
  const onError = error => { clientError ||= error; };
  client.on('error', onError);
  const session = {
    error: () => clientError,
    async query(sql, values, timeoutMs) {
      if (clientError) throw clientError;
      const result = await (timeoutMs === undefined ? client.query(sql, values) :
        client.query({ text: sql, values, query_timeout: timeoutMs }));
      if (clientError) throw clientError;
      return result;
    },
    async close() {
      // A dedicated Client is always ended, never returned to a pool.
      try { await client.end(); } finally { client.removeListener('error', onError); }
    },
  };
  try {
    await client.connect();
    await session.query("SET search_path = pg_catalog, public, pg_temp; SET standard_conforming_strings = on; SET client_encoding = 'UTF8'");
    return session;
  } catch (error) {
    const failure = fail('CONNECTION_FAILED', 'Connexion migrateur impossible', error);
    try { await session.close(); } catch (closeError) { failure.closeError = closeError; }
    throw failure;
  }
}

async function acquire(session, timeout, retry) {
  const deadline = performance.now() + timeout; // Monotonic milliseconds; acceptance deadline.
  const timedOut = cause => fail('LOCK_TIMEOUT', 'Deadline dépassée : verrou de migration non acquis à temps', cause);
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timedOut();
    let locked;
    try {
      // Bound the read itself, without changing PG-1 or the timeout of migration SQL.
      locked = (await session.query('SELECT pg_try_advisory_lock($1, $2) AS locked', LOCK_KEY,
        Math.max(1, Math.ceil(remaining)))).rows[0].locked;
    } catch (error) {
      if (performance.now() >= deadline || error.message === 'Query read timeout') throw timedOut(error);
      throw error;
    }
    const now = performance.now();
    if (now >= deadline) {
      const failure = timedOut();
      if (locked) {
        // The lock is ours even though the reply is late. Release on this same session.
        // Cleanup has a separate bounded budget; it never authorizes migration work.
        try {
          if (!(await session.query('SELECT pg_advisory_unlock($1, $2) AS unlocked', LOCK_KEY, 1000)).rows[0].unlocked) {
            throw fail('LOCK_LOST', 'Verrou tardif non confirmé lors de sa libération');
          }
        } catch (unlockError) { failure.unlockError = unlockError; }
      }
      throw failure;
    }
    if (locked) return;
    await delay(Math.min(retry, deadline - now));
  }
}

async function readHistory(session) {
  return (await session.query(`SELECT version, name, checksum, applied_at, execution_ms FROM ${TABLE} ORDER BY version`)).rows;
}

async function occupiedDatabase(session) {
  return (await session.query(`SELECT EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')
      UNION ALL
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
    ) AS occupied`)).rows[0].occupied;
}

async function registry(session, allowCreate = true) {
  const exists = (await session.query("SELECT to_regclass('securisite_meta.schema_migrations') AS name")).rows[0].name;
  if (!exists) {
    if (!allowCreate) throw fail('REGISTRY_MISMATCH', 'Registre absent pendant la réconciliation');
    const occupied = await occupiedDatabase(session);
    if (occupied) throw fail('UNVERSIONED_DATABASE', 'Base non vide sans registre : adoption automatique interdite');
    await session.query('BEGIN');
    let committing = false;
    try { await session.query(LEDGER_SQL); committing = true; await session.query('COMMIT'); }
    catch (error) {
      const failure = fail('REGISTRY_FAILED', 'Initialisation du registre échouée', error);
      failure.bootstrapCommitUncertain = committing;
      if (session.error()) failure.clientError = session.error();
      try { await session.query('ROLLBACK'); } catch (rollbackError) { failure.rollbackError = rollbackError; }
      throw failure;
    }
  }
  const columns = (await session.query(`SELECT a.attname, t.typname, a.attnotnull
    FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
    WHERE a.attrelid='securisite_meta.schema_migrations'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  const expected = [['version','int4'],['name','text'],['checksum','text'],['applied_at','timestamptz'],['execution_ms','int8']];
  if (columns.length !== expected.length || columns.some((c,i)=>c.attname!==expected[i][0] || c.typname!==expected[i][1] || !c.attnotnull)) {
    throw fail('REGISTRY_MISMATCH', 'Structure du registre incompatible');
  }
  const relation = (await session.query(`SELECT relkind, relpersistence, relrowsecurity FROM pg_class WHERE oid='securisite_meta.schema_migrations'::regclass`)).rows[0];
  const constraints = (await session.query(`SELECT contype, convalidated, condeferrable, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='securisite_meta.schema_migrations'::regclass`)).rows;
  const normalize = value => value.replace(/[\s()]/g, '');
  const actual = constraints.map(c => c.contype + ':' + normalize(c.definition)).sort();
  const expectedConstraints = [
    'p:PRIMARY KEY (version)', 'u:UNIQUE (name)',
    "c:CHECK ((checksum ~ '^[0-9a-fA-F]{64}$'::text))", 'c:CHECK ((execution_ms >= 0))',
  ].map(normalize).sort();
  if (relation.relkind !== 'r' || relation.relpersistence !== 'p' || relation.relrowsecurity ||
      constraints.some(c => !c.convalidated || c.condeferrable) || JSON.stringify(actual) !== JSON.stringify(expectedConstraints)) {
    throw fail('REGISTRY_MISMATCH', 'Contraintes du registre incompatibles');
  }
}

async function release(session, locked, failure) {
  if (locked && !session.error()) {
    try {
      if (!(await session.query('SELECT pg_advisory_unlock($1, $2) AS unlocked', LOCK_KEY)).rows[0].unlocked) {
        throw fail('LOCK_LOST', 'Verrou de migration perdu prématurément');
      }
    } catch (error) { if (failure) failure.unlockError = error; else failure = error; }
  }
  try { await session.close(); } catch (error) { if (failure) failure.closeError = error; else failure = error; }
  return failure;
}

/** No environment fallback. Callers must supply a distinct, explicit migration identity. */
async function migrate({ directory, migrationEnv, lockTimeoutMs, retryDelayMs, ClientClass = Client } = {}) {
  if (!migrationEnv || typeof migrationEnv !== 'object') throw fail('MIGRATOR_REQUIRED', 'Configuration migrateur explicite requise');
  const entries = discover(directory); // Immutable source snapshot before lock or any DB write.
  const timeout = bounded(lockTimeoutMs, 30000, 'lockTimeoutMs');
  const retry = bounded(retryDelayMs, 50, 'retryDelayMs');
  const config = { ...configuration(migrationEnv), application_name: 'securisite-migrator' };
  let session = await openSession(config, ClientClass), locked = false, failure, uncertain;
  const applied = [];
  let initialCount = 0;
  try {
    await acquire(session, timeout, retry); locked = true;
    await registry(session);
    initialCount = validateHistory(await readHistory(session), entries);
    for (const entry of entries.slice(initialCount)) {
      let phase = 'begin';
      const started = performance.now();
      try {
        await session.query('BEGIN'); phase = 'sql';
        await session.query(entry.sql);
        if (validateHistory(await readHistory(session), entries) !== initialCount + applied.length) {
          throw fail('HISTORY_MISMATCH', 'Le SQL a modifié le registre');
        }
        await session.query(`INSERT INTO ${TABLE}(version,name,checksum,applied_at,execution_ms) VALUES($1,$2,$3,clock_timestamp(),$4)`,
          [entry.version, entry.name, entry.checksum, Math.max(0, Math.round(performance.now() - started))]);
        phase = 'commit';
        const result = await session.query('COMMIT');
        if (result.command !== 'COMMIT') throw fail('COMMIT_FAILED', 'COMMIT non confirmé');
        applied.push(entry.version);
      } catch (error) {
        failure = fail('MIGRATION_FAILED', `Migration ${entry.name} échouée`, error);
        try { await session.query('ROLLBACK'); } catch (rollbackError) { failure.rollbackError = rollbackError; }
        if (session.error()) failure.clientError = session.error();
        if (phase === 'commit') uncertain = entry;
        throw failure;
      }
    }
  } catch (error) {
    failure = error;
    if (error.bootstrapCommitUncertain) uncertain = { version: 0, bootstrap: true };
  }
  failure = await release(session, locked, failure);
  if (uncertain) {
    // One read-only reconciliation under the same lock, never automatic DDL/DML replay.
    let recovery, recoveryLocked = false, recoveryFailure, count;
    try {
      recovery = await openSession(config, ClientClass);
      await acquire(recovery, timeout, retry); recoveryLocked = true;
      const exists = (await recovery.query("SELECT to_regclass('securisite_meta.schema_migrations') AS name")).rows[0].name;
      if (!exists && uncertain.bootstrap) {
        if (await occupiedDatabase(recovery)) throw fail('REGISTRY_MISMATCH', 'État non vide après bootstrap incertain');
        count = -1; // Entire bootstrap absent on a verified empty database.
      } else {
        await registry(recovery, false);
        const rows = await readHistory(recovery);
        count = validateHistory(rows, entries);
        if (count < initialCount + applied.length) throw fail('HISTORY_MISMATCH', 'Historique antérieur perdu');
      }
    } catch (error) { recoveryFailure = error; }
    if (recovery) recoveryFailure = await release(recovery, recoveryLocked, recoveryFailure);
    if (recoveryFailure) {
      failure.code = 'COMMIT_INDETERMINATE'; failure.reconciliationError = recoveryFailure;
      failure.message = 'COMMIT indéterminé : vérification manuelle requise'; throw failure;
    }
    if (count >= uncertain.version) {
      return { applied: uncertain.bootstrap ? [] : [...applied, uncertain.version], reconciled: true,
        pending: entries.slice(count).map(e=>e.version), warning: 'Série arrêtée après réconciliation ; aucun SQL rejoué' };
    }
    failure.code = 'COMMIT_NOT_APPLIED';
    failure.message = 'COMMIT non appliqué après vérification sous verrou ; reprise explicite requise';
    throw failure;
  }
  if (failure) throw failure;
  return { applied, reconciled: false, pending: [] };
}

module.exports = { migrate, discover, LOCK_KEY };
