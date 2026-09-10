'use strict';
/**
 * Attestation de readiness PostgreSQL, strictement en lecture seule.
 * Aucun CREATE/ALTER/INSERT, aucune migration, aucune réparation, aucun seed :
 * uniquement des SELECT sur les catalogues et les tables métier.
 * Toute dérive lève une erreur typée ; le démarrage doit alors échouer avant l'écoute.
 */
const path = require('node:path');
const { discover } = require('./migrate');

const HISTORICAL = [
  'users', 'employes', 'visiteurs', 'vehicules', 'pietons', 'incidents', 'badges',
  'parking_zones', 'parking_places', 'parking_mouvements', 'main_courante', 'lapi_lectures', 'parametres',
];
const ALERT_CORE = ['security_alerts', 'alert_audit', 'alert_notifications', 'alert_config_audit', 'alert_rules'];
const AUDIT_FUNCTION = 'securisite_meta.reject_alert_audit_mutation';
const AUDIT_TRIGGERS = [
  'alert_audit_no_mutation', 'alert_audit_no_truncate',
  'alert_config_audit_no_mutation', 'alert_config_audit_no_truncate',
];
// Verbes réellement exécutés par le runtime (backend/routes.js, auth.js, sync.js, alert-core).
// Les journaux append-only n'exigent qu'INSERT + SELECT : jamais UPDATE ni DELETE.
const PRIVILEGES = {
  users: 'SELECT,INSERT,UPDATE,DELETE', employes: 'SELECT,INSERT,UPDATE,DELETE',
  visiteurs: 'SELECT,INSERT,UPDATE,DELETE', vehicules: 'SELECT,INSERT,UPDATE,DELETE',
  pietons: 'SELECT,INSERT,UPDATE,DELETE', incidents: 'SELECT,INSERT,UPDATE,DELETE',
  badges: 'SELECT,INSERT,UPDATE,DELETE', parking_zones: 'SELECT',
  parking_places: 'SELECT,UPDATE', parking_mouvements: 'SELECT,INSERT',
  main_courante: 'SELECT,INSERT,DELETE', lapi_lectures: 'SELECT,INSERT,UPDATE,DELETE',
  parametres: 'SELECT,INSERT,UPDATE',
  security_alerts: 'SELECT,INSERT,UPDATE', alert_audit: 'SELECT,INSERT',
  alert_notifications: 'SELECT,INSERT,UPDATE', alert_config_audit: 'SELECT,INSERT',
  alert_rules: 'SELECT,UPDATE',
};

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param client  exécuteur exposant query/get/all (le module database ou un client PG-1)
 * @param options.directory  répertoire des migrations SQL PostgreSQL (défaut : ./migrations)
 */
async function assertReady(client, { directory } = {}) {
  const migrationsDir = directory || path.resolve(__dirname, 'migrations');

  // 1. Connexion vivante (contrôle explicite ; server.js appelle aussi db.init()).
  await client.query('SELECT 1');

  // 2. Registre des migrations présent, en tant que table ordinaire.
  const registry = await client.get(`
    SELECT c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'securisite_meta' AND c.relname = 'schema_migrations'`);
  if (!registry || registry.relkind !== 'r') {
    throw fail('READINESS_REGISTRY_MISSING', 'Registre securisite_meta.schema_migrations absent');
  }

  // 3. Versions 001/002 exactement : mêmes numéros, noms et empreintes que les fichiers.
  const entries = discover(migrationsDir); // même découverte + sha256 que le runner
  const rows = await client.all(
    'SELECT version, name, checksum FROM securisite_meta.schema_migrations ORDER BY version');
  if (rows.length !== entries.length) {
    throw fail('READINESS_MIGRATIONS_MISMATCH',
      `Historique de migrations incomplet : ${rows.length}/${entries.length}`);
  }
  entries.forEach((entry, i) => {
    const row = rows[i];
    if (!row || row.version !== entry.version || row.name !== entry.name ||
        String(row.checksum).toLowerCase() !== entry.checksum) {
      throw fail('READINESS_MIGRATIONS_MISMATCH',
        `Migration ${entry.version} (${entry.name}) absente ou altérée`);
    }
  });

  // 4. 13 tables historiques + 5 tables Alert Core, en tant que tables de base.
  const wanted = [...HISTORICAL, ...ALERT_CORE];
  const missing = await client.all(`
    SELECT t.name FROM unnest($1::text[]) AS t(name)
    LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE c.oid IS NULL OR c.relkind NOT IN ('r', 'p')`, [wanted]);
  if (missing.length) {
    throw fail('READINESS_TABLE_MISSING', 'Tables absentes : ' + missing.map(r => r.name).join(', '));
  }

  // 5. Ligne de configuration alert_rules id=1 présente et non nulle.
  const rule = await client.get('SELECT 1 AS ok FROM public.alert_rules WHERE id = 1 AND config IS NOT NULL');
  if (!rule) {
    throw fail('ALERT_CONFIG_MISSING', 'Configuration Alert Core indisponible : règle id=1 absente');
  }

  // 6. Fonction et déclencheurs d'immuabilité du journal, présents et actifs.
  const guardFn = await client.get(`
    SELECT 1 AS ok FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'securisite_meta' AND p.proname = 'reject_alert_audit_mutation'`);
  if (!guardFn) throw fail('READINESS_AUDIT_GUARD_MISSING', 'Fonction ' + AUDIT_FUNCTION + ' absente');
  const triggers = await client.all(`
    SELECT tg.tgname FROM pg_catalog.pg_trigger tg
    WHERE NOT tg.tgisinternal AND tg.tgenabled <> 'D'
      AND tg.tgrelid IN ('public.alert_audit'::regclass, 'public.alert_config_audit'::regclass)`);
  const present = new Set(triggers.map(t => t.tgname));
  const disabled = AUDIT_TRIGGERS.filter(name => !present.has(name));
  if (disabled.length) {
    throw fail('READINESS_AUDIT_GUARD_MISSING',
      'Triggers audit append-only absents ou désactivés : ' + disabled.join(', '));
  }

  // 7. Privilèges runtime nécessaires du rôle courant, table par table et verbe par verbe.
  const shortfall = await client.all(`
    SELECT t.name, v.verb
    FROM unnest($1::text[], $2::text[]) AS t(name, verbs),
         LATERAL unnest(string_to_array(t.verbs, ',')) AS v(verb)
    WHERE NOT has_table_privilege('public.' || t.name, v.verb)`,
    [Object.keys(PRIVILEGES), Object.values(PRIVILEGES)]);
  if (shortfall.length) {
    throw fail('READINESS_PRIVILEGE_MISSING',
      'Privilèges applicatifs manquants : ' + shortfall.map(r => r.name + ':' + r.verb).join(', '));
  }
}

module.exports = { assertReady, HISTORICAL, ALERT_CORE, AUDIT_FUNCTION, AUDIT_TRIGGERS, PRIVILEGES };
