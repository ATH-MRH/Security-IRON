// UUID v5 (DNS namespace), frozen names: securisite.local.tenant / securisite.local.site.main.
const LOCAL_TENANT_ID = '507486ba-d55e-5142-9ac2-196da97866df';
const MAIN_SITE_ID = 'fa831124-0323-581e-993c-1f4332a36282';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','archived')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      timezone TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      external_ref TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','archived')),
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id);
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id),
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT CHECK(kind IS NULL OR kind IN ('perimeter','parking','building','access_point','other')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_at TEXT NOT NULL,
      UNIQUE(site_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_zones_site ON zones(site_id);
    CREATE INDEX IF NOT EXISTS idx_zones_tenant ON zones(tenant_id);
    CREATE TRIGGER IF NOT EXISTS zones_parent_insert BEFORE INSERT ON zones BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id=NEW.site_id)
          THEN RAISE(ABORT, 'Zone: site parent inexistant')
        WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id=NEW.site_id AND tenant_id=NEW.tenant_id)
          THEN RAISE(ABORT, 'Zone: tenant incompatible avec le site parent')
      END;
    END;
    CREATE TRIGGER IF NOT EXISTS zones_parent_update BEFORE UPDATE OF site_id, tenant_id ON zones BEGIN
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id=NEW.site_id)
          THEN RAISE(ABORT, 'Zone: site parent inexistant')
        WHEN NOT EXISTS (SELECT 1 FROM sites WHERE id=NEW.site_id AND tenant_id=NEW.tenant_id)
          THEN RAISE(ABORT, 'Zone: tenant incompatible avec le site parent')
      END;
    END;
    CREATE TRIGGER IF NOT EXISTS sites_tenant_update BEFORE UPDATE OF tenant_id ON sites
    WHEN EXISTS (SELECT 1 FROM zones WHERE site_id=OLD.id AND tenant_id<>NEW.tenant_id)
    BEGIN
      SELECT RAISE(ABORT, 'Site: changement de tenant incompatible avec les zones existantes');
    END;
  `);
  const stamp = new Date().toISOString();
  db.prepare(`INSERT INTO tenants(id,code,name,created_at) VALUES(?,?,?,?)
    ON CONFLICT(code) DO NOTHING`).run(LOCAL_TENANT_ID, 'local', 'Client local', stamp);
  const tenant = db.prepare("SELECT id FROM tenants WHERE code='local'").get();
  const parameter = key => {
    const value = db.prepare('SELECT valeur FROM parametres WHERE cle=?').get(key)?.valeur;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  db.prepare(`INSERT INTO sites(id,tenant_id,code,name,address,timezone,created_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,code) DO NOTHING`)
    .run(MAIN_SITE_ID, tenant.id, 'main', parameter('site') || 'Site principal', parameter('adresse'), 'UTC', stamp);
}

module.exports = { up };
