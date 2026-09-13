'use strict';
// PG-27 — sauvegarde/restauration PostgreSQL réelle (pg_dump/pg_restore,
// backend/db/postgresql/backup.js + restore.js). Scénario complet du
// MASTER ROADMAP §31 : backup -> destruction d'une base de TEST -> restore
// -> readiness -> migrations -> comptes/relations/audits vérifiés.
// Aucune opération de production : uniquement des bases jetables
// « securisite_test_* », créées et détruites par ce fichier.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const db = require('../backend/database');
const { migrate } = require('../backend/db/postgresql/migrate');
const { assertReady } = require('../backend/db/postgresql/readiness');
const { backup } = require('../backend/db/postgresql/backup');
const { restore } = require('../backend/db/postgresql/restore');
const { testEnvironment, seedMembership } = require('./helpers/postgres-test-config');

const baseEnv = testEnvironment();
const directory = path.resolve(__dirname, '../backend/db/postgresql/migrations');
const dbName = 'securisite_test_backup_' + randomBytes(6).toString('hex');
const dbUrl = new URL(baseEnv.DATABASE_URL); dbUrl.pathname = '/' + dbName;
const env = { ...baseEnv, DATABASE_URL: dbUrl.href };

let root, pool, dumpFile;

before(async () => {
  root = new Client(db.configuration(baseEnv));
  await root.connect();
  await root.query('CREATE DATABASE "' + dbName + '"');
  await migrate({ directory, migrationEnv: env });
  pool = db.createDatabase(env);
  dumpFile = path.join(os.tmpdir(), 'securisite-backup-test-' + randomBytes(6).toString('hex') + '.dump');
});
after(async () => {
  try { if (pool) await pool.close(); }
  finally {
    if (dumpFile) fs.rmSync(dumpFile, { force: true });
    if (root) { await root.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await root.end(); }
  }
});

test('backup refuses without databaseUrl/outFile, restore refuses a non-test target without confirmation', async () => {
  await assert.rejects(backup({ outFile: dumpFile }), e => e.code === 'DATABASE_URL_REQUIRED');
  await assert.rejects(backup({ databaseUrl: env.DATABASE_URL }), e => e.code === 'OUTPUT_REQUIRED');
  await assert.rejects(
    restore({ databaseUrl: env.DATABASE_URL, targetName: 'securisite_production', inFile: dumpFile }),
    e => e.code === 'TARGET_FORBIDDEN');
  await assert.rejects(
    restore({ databaseUrl: env.DATABASE_URL, targetName: 'securisite_staging', inFile: dumpFile }),
    e => e.code === 'TARGET_UNCONFIRMED');
});

test('full backup -> destroy -> restore round-trip: readiness, migrations, accounts, relations and audit all verified afterwards', async () => {
  // 1. Seed a realistic, varied dataset: users/memberships (PG-7/PG-8),
  //    alerts with a real audit trail (PG-10), security_audit rows.
  const agent = await pool.get(
    "INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES('backup_agent',$1,'Agent Backup','agent') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  const admin = await pool.get(
    "INSERT INTO public.users(username,password_hash,nom_complet,role) VALUES('backup_admin',$1,'Admin Backup','admin') RETURNING id",
    [await bcrypt.hash('x', 10)]);
  await seedMembership(pool, agent.id, 'agent');
  await seedMembership(pool, admin.id, 'admin');
  const tenantId = (await pool.get("SELECT id FROM public.tenants WHERE code='local'")).id;
  const alert = await pool.get(
    `INSERT INTO public.security_alerts(id,created_at,updated_at,site,zone,type,level,origin,created_by,username,status,comment,equipment,policy,tenant_id)
     VALUES('ALT-BACKUP-1',now()::text,now()::text,'Site Backup','Z','Test',3,'COMMAND',$1,'backup_agent','NOTIFIEE','','','[30,60,120]',$2) RETURNING id`,
    [agent.id, tenantId]);
  await pool.query("INSERT INTO public.alert_audit(alert_id,created_at,actor,action,detail) VALUES($1,now()::text,'backup_agent','CREATION','Test backup')", [alert.id]);
  await pool.query(
    "INSERT INTO public.security_audit(event_type,resource_type,action,outcome,origin,actor_user_id,actor_username,tenant_id) VALUES('alert.create','alert','create','success','http',$1,'backup_agent',$2)",
    [agent.id, tenantId]);

  const before = {
    users: (await pool.all('SELECT id,username,role FROM public.users ORDER BY id')),
    memberships: (await pool.all('SELECT user_id,tenant_id,role,alert_access FROM public.memberships ORDER BY id')),
    alerts: (await pool.all('SELECT id,site,type,level,status,tenant_id FROM public.security_alerts ORDER BY id')),
    alertAudit: (await pool.all("SELECT alert_id,actor,action,detail FROM public.alert_audit WHERE alert_id=$1", [alert.id])),
    securityAudit: (await pool.all("SELECT event_type,actor_username,outcome FROM public.security_audit WHERE resource_type='alert'")),
    migrations: (await pool.all('SELECT version,name,checksum FROM securisite_meta.schema_migrations ORDER BY version')),
  };
  assert.ok(before.users.length >= 2 && before.alerts.length === 1 && before.alertAudit.length === 1);

  // 2. Backup — a real pg_dump against the live database.
  await backup({ databaseUrl: env.DATABASE_URL, outFile: dumpFile });
  assert.ok(fs.statSync(dumpFile).size > 0, 'the dump file is non-empty');

  // 3. Destroy — literally drop the TEST database and recreate it empty.
  await pool.close();
  await root.query('DROP DATABASE "' + dbName + '" WITH (FORCE)');
  await root.query('CREATE DATABASE "' + dbName + '"');

  // 4. Restore — into the now-empty, still explicitly-test-named database.
  await restore({ databaseUrl: env.DATABASE_URL, targetName: dbName, inFile: dumpFile });

  // 5. Verify: readiness, migrations, accounts, relations, audit — all restored intact.
  pool = db.createDatabase(env);
  assert.equal(await assertReady(pool, { directory }), undefined, 'the restored database passes the exact same readiness attestation as a freshly migrated one');

  const after = {
    users: (await pool.all('SELECT id,username,role FROM public.users ORDER BY id')),
    memberships: (await pool.all('SELECT user_id,tenant_id,role,alert_access FROM public.memberships ORDER BY id')),
    alerts: (await pool.all('SELECT id,site,type,level,status,tenant_id FROM public.security_alerts ORDER BY id')),
    alertAudit: (await pool.all("SELECT alert_id,actor,action,detail FROM public.alert_audit WHERE alert_id=$1", [alert.id])),
    securityAudit: (await pool.all("SELECT event_type,actor_username,outcome FROM public.security_audit WHERE resource_type='alert'")),
    migrations: (await pool.all('SELECT version,name,checksum FROM securisite_meta.schema_migrations ORDER BY version')),
  };
  assert.deepEqual(after.users, before.users, 'accounts restored exactly');
  assert.deepEqual(after.memberships, before.memberships, 'memberships (relations) restored exactly');
  assert.deepEqual(after.alerts, before.alerts, 'business data restored exactly');
  assert.deepEqual(after.alertAudit, before.alertAudit, 'alert audit trail restored exactly');
  assert.deepEqual(after.securityAudit, before.securityAudit, 'security audit trail restored exactly');
  assert.deepEqual(after.migrations, before.migrations, 'migration ledger restored exactly, including checksums');

  // Append-only guarantees survive a restore too: still rejected afterwards.
  await assert.rejects(pool.query("UPDATE public.security_audit SET outcome='failure' WHERE resource_type='alert'"), /23514|immuable/i);
});
