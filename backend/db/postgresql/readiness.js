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
// Référentiel multitenant (migrations 003 / 004) : présent, mais non activé côté runtime.
const SCOPE = ['tenants', 'sites', 'zones'];
const MEMBERSHIP = ['memberships', 'membership_audit'];
// PG-10 : journal de sécurité global transversal — distinct des journaux
// spécialisés ci-dessus, qui restent l'autorité de leur domaine.
const SECURITY_AUDIT = ['security_audit'];
// PG-13 : état de périphérique (abonnement Web Push), pas un journal —
// aucun trigger append-only, aucune RLS (isolation par user_id en requête,
// même modèle que alert_notifications).
const PUSH = ['push_subscriptions'];
const AUDIT_FUNCTIONS = ['reject_alert_audit_mutation', 'reject_membership_mutation'];
const AUDIT_FUNCTION = 'securisite_meta.' + AUDIT_FUNCTIONS[0]; // rétro-compat
const AUDIT_TRIGGERS = {
  alert_audit: ['alert_audit_no_mutation', 'alert_audit_no_truncate'],
  alert_config_audit: ['alert_config_audit_no_mutation', 'alert_config_audit_no_truncate'],
  membership_audit: ['membership_audit_no_mutation', 'membership_audit_no_truncate'],
  memberships: ['memberships_no_delete', 'memberships_identity_lock'],
  security_audit: ['security_audit_no_mutation', 'security_audit_no_truncate'],
};
// PG-9 : deuxième défense indépendante de backend/scope.js — granularité
// tenant uniquement (voir migration 005). N'existe que sur les tables qui
// portent réellement un tenant_id ; les tables historiques restent hors
// périmètre RLS tant qu'elles n'ont pas cette colonne (voir docs/postgresql-scope.md).
// PG-10 ajoute une deuxième fonction RLS, plus stricte (rôle 'soc' requis) :
// security_audit n'est lisible par aucun membership 'agent' ordinaire.
const RLS_FUNCTIONS = ['current_actor_tenant_ids', 'current_actor_soc_tenant_ids'];
const RLS_FUNCTION = RLS_FUNCTIONS[0]; // rétro-compat
const RLS_POLICIES = {
  tenants: ['tenants_actor_tenant'],
  sites: ['sites_actor_tenant'],
  zones: ['zones_actor_tenant'],
  memberships: ['memberships_actor_tenant'],
  membership_audit: ['membership_audit_actor_tenant'],
  security_audit: ['security_audit_soc_read', 'security_audit_app_insert'],
};
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
  // Référentiel multitenant : lecture seule tant que l'activation (PG-8) n'a pas eu lieu.
  // membership_audit reçoit INSERT (écrit par le trigger AFTER, jamais directement)
  // en prévision des écritures de memberships du lot PG-8.
  tenants: 'SELECT', sites: 'SELECT', zones: 'SELECT',
  memberships: 'SELECT', membership_audit: 'SELECT,INSERT',
  // PG-10 : INSERT pour record() (backend/security-audit.js) ; SELECT pour
  // GET /api/admin/security-audit — RLS (migration 006) restreint la lecture
  // effective aux memberships actifs de rôle 'soc' sous leur propre tenant.
  security_audit: 'SELECT,INSERT',
  // PG-13 : ON CONFLICT DO UPDATE (subscribe) exige à la fois INSERT et
  // UPDATE ; DELETE pour unsubscribe ; SELECT pour deliverFor().
  push_subscriptions: 'SELECT,INSERT,UPDATE,DELETE',
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
  const wanted = [...HISTORICAL, ...ALERT_CORE, ...SCOPE, ...MEMBERSHIP, ...SECURITY_AUDIT, ...PUSH];
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
  const guardFns = await client.all(`
    SELECT p.proname FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'securisite_meta' AND p.proname = ANY($1)`, [AUDIT_FUNCTIONS]);
  const missingFns = AUDIT_FUNCTIONS.filter(name => !guardFns.some(r => r.proname === name));
  if (missingFns.length) {
    throw fail('READINESS_AUDIT_GUARD_MISSING', 'Fonction(s) de garde absente(s) : ' + missingFns.join(', '));
  }
  const relations = Object.keys(AUDIT_TRIGGERS);
  const triggers = await client.all(`
    SELECT c.relname, tg.tgname FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT tg.tgisinternal AND tg.tgenabled <> 'D'
      AND n.nspname = 'public' AND c.relname = ANY($1)`, [relations]);
  const present = new Set(triggers.map(t => t.relname + '.' + t.tgname));
  const disabled = relations.flatMap(rel => AUDIT_TRIGGERS[rel].filter(name => !present.has(rel + '.' + name)));
  if (disabled.length) {
    throw fail('READINESS_AUDIT_GUARD_MISSING',
      'Triggers append-only absents ou désactivés : ' + disabled.join(', '));
  }

  // 7. RLS (PG-9) : activé sur chaque table concernée, politique attendue
  //    présente, fonction de résolution d'acteur elle-même présente.
  const rlsFns = await client.all(`
    SELECT p.proname FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'securisite_meta' AND p.proname = ANY($1)`, [RLS_FUNCTIONS]);
  const missingRlsFns = RLS_FUNCTIONS.filter(name => !rlsFns.some(r => r.proname === name));
  if (missingRlsFns.length) throw fail('READINESS_RLS_MISSING', 'Fonction(s) RLS absente(s) : ' + missingRlsFns.join(', '));
  const rlsTables = Object.keys(RLS_POLICIES);
  const rlsState = await client.all(`
    SELECT c.relname AS name, c.relrowsecurity AS enabled
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [rlsTables]);
  const disabledRls = rlsTables.filter(name => !rlsState.some(r => r.name === name && r.enabled));
  if (disabledRls.length) {
    throw fail('READINESS_RLS_MISSING', 'RLS désactivée ou table absente : ' + disabledRls.join(', '));
  }
  const rlsPolicies = await client.all(`
    SELECT tablename AS name, policyname FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = ANY($1)`, [rlsTables]);
  const presentPolicies = new Set(rlsPolicies.map(p => p.name + '.' + p.policyname));
  const missingPolicies = rlsTables.flatMap(name => RLS_POLICIES[name].filter(p => !presentPolicies.has(name + '.' + p)));
  if (missingPolicies.length) {
    throw fail('READINESS_RLS_MISSING', 'Politique(s) RLS absente(s) : ' + missingPolicies.join(', '));
  }

  // 8. Privilèges runtime nécessaires du rôle courant, table par table et verbe par verbe.
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

module.exports = {
  assertReady, HISTORICAL, ALERT_CORE, SCOPE, MEMBERSHIP, SECURITY_AUDIT, PUSH, AUDIT_FUNCTION, AUDIT_FUNCTIONS, AUDIT_TRIGGERS,
  RLS_FUNCTION, RLS_FUNCTIONS, RLS_POLICIES, PRIVILEGES,
};
