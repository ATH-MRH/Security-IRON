'use strict';
// Administration Système V1 — moteur front (cockpit + sous-écrans).
// RECETTE VISUELLE ÉCRAN 1 (Vue générale) : navigation horizontale
// supprimée, déplacée dans la sidebar (16 sous-entrées .nav-sub-item sous
// "Administration système", frontend/index.html) ; #adminTabContent est
// désormais la SEULE zone de contenu, pilotée par showTab(id).
//
// Réutilise showModal/closeModal/notify/escapeHtml/applyLanguage/
// renderKpi2Card (ui.js), mcCategoryLabel/loadMcEventCatalog (app.js) et
// les endpoints réels : /admin/system, /admin/overview, /admin/sites,
// /admin/zones, /admin/users, /admin/roles, /admin/security-audit,
// /api/maincourante/admin/*, /api/camera/list, /push/public-key. Aucune
// donnée fictive : un écran sans backend réel affiche explicitement
// "à venir" / "non disponible", jamais une valeur inventée.
const AdminSystem = (() => {
  const TABS = [
    ['overview', 'Vue générale', 'اطلاع عام'], ['sites', 'Sites', 'المواقع'],
    ['groups', 'Groupes', 'المجموعات'],
    ['zones', 'Zones & postes', 'المناطق والمراكز'], ['users', 'Utilisateurs', 'المستخدمون'],
    ['roles', 'Rôles & permissions', 'الأدوار والصلاحيات'], ['maincourante', 'Main courante', 'السجل اليومي'],
    ['alerts', 'Alertes & SOS', 'التنبيهات وSOS'], ['access', "Contrôle d'accès", 'مراقبة الدخول'],
    ['rounds', 'Rondes', 'الجولات'], ['notifications', 'Notifications', 'الإشعارات'],
    ['cameras', 'Caméras / LAPI', 'الكاميرات / اللوحات'], ['integrations', 'Intégrations', 'التكاملات'],
    ['data', 'Données & archivage', 'البيانات والأرشفة'], ['settings', 'Paramètres système', 'إعدادات النظام'],
    ['audit', "Journal d'audit", 'سجل التدقيق'], ['ai', 'Intelligence IA', 'الذكاء الاصطناعي'],
  ];
  let currentTab = 'overview';
  let sitesCache = [];
  // MISSION — DÉPENDANCES SITE : dernière liste d'appartenances réellement
  // chargée par viewSiteMembershipDependencies() — permet à "Gérer" de
  // retrouver l'objet complet depuis un simple id dans l'attribut onclick,
  // même convention que sitesCache/groupUsersCache ci-dessous (jamais de
  // JSON brut embarqué dans un attribut HTML).
  let siteMembershipsCache = [];
  let mcSiteId = null;
  let zonesSiteId = null;
  // Groupes (LOT GROUPES) — groupe = tenant (backend/admin-groups.js, jamais
  // dupliqué ici). État de la fiche groupe courante ; groupAssignedIds est
  // une sélection LOCALE (§11 mission) — rien n'est persisté avant
  // "Enregistrer les modifications" (saveGroupSites).
  let groupsCache = [];
  let groupsStatusFilter = '';
  let currentGroupId = null;
  let groupInfoCache = null;
  let groupInfoEditMode = false;
  let groupSiteById = new Map();
  let groupOriginalAssignedIds = new Set();
  let groupAssignedIds = new Set();
  let groupAvailSelected = new Set();
  let groupUsersCache = [];
  const MEMBERSHIP_ROLES = ['soc', 'client_manager', 'supervisor', 'site_manager', 'agent', 'client_viewer', 'security_admin', 'patrol_agent', 'access_operator', 'auditor'];
  const ROLE_LABELS_FR = { soc: 'SOC', client_manager: 'Responsable client', supervisor: 'Superviseur', site_manager: 'Chef de site', agent: 'Agent', client_viewer: 'Lecteur client', security_admin: 'Administrateur sécurité', patrol_agent: 'Agent de ronde', access_operator: "Opérateur d'accès", auditor: 'Auditeur' };
  const ROLE_LABELS_AR = { soc: 'مركز العمليات الأمنية', client_manager: 'مسؤول العميل', supervisor: 'مشرف', site_manager: 'رئيس الموقع', agent: 'عون', client_viewer: 'مطالع العميل', security_admin: 'مسؤول الأمن', patrol_agent: 'عون جولات', access_operator: 'عامل التحكم بالدخول', auditor: 'مدقق' };
  function roleLabel(role) { return t(ROLE_LABELS_FR[role] || role, ROLE_LABELS_AR[role] || role); }
  // Avatar de fiche groupe : dérivé du code (déterministe, jamais aléatoire)
  // — même code = même couleur/initiales à chaque rendu.
  const GROUP_AVATAR_PALETTE = ['#2575fc', '#00b8a9', '#f7b731', '#eb3b5a', '#8854d0', '#20bf6b', '#fa8231'];
  function groupAvatarText(code) { return ((code || '').split('-')[0] || code || '?').slice(0, 4).toUpperCase(); }
  function groupAvatarColor(code) {
    let h = 0;
    for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return GROUP_AVATAR_PALETTE[h % GROUP_AVATAR_PALETTE.length];
  }
  function fmtGroupDate(iso) { return iso ? new Date(iso).toLocaleDateString(lang() === 'ar' ? 'ar' : 'fr-FR') : '—'; }
  // "Plus d'actions" — même pattern que le menu langue existant
  // (app.js#toggleLangMenu/closeLangMenu), jamais un second composant.
  function toggleGroupActionsMenu() {
    const dd = document.getElementById('groupActionsDropdown');
    if (!dd) return;
    dd.hasAttribute('hidden') ? openGroupActionsMenu() : closeGroupActionsMenu();
  }
  function openGroupActionsMenu() {
    document.getElementById('groupActionsDropdown')?.removeAttribute('hidden');
    document.getElementById('groupActionsMenuBtn')?.setAttribute('aria-expanded', 'true');
  }
  function closeGroupActionsMenu() {
    document.getElementById('groupActionsDropdown')?.setAttribute('hidden', '');
    document.getElementById('groupActionsMenuBtn')?.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', e => {
    const menu = document.getElementById('groupActionsMenuBtn')?.closest('.admin-actions-menu');
    if (menu && !menu.contains(e.target)) closeGroupActionsMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGroupActionsMenu(); });

  const lang = () => document.documentElement.lang === 'ar' ? 'ar' : 'fr';
  function t(fr, ar) { return lang() === 'ar' ? ar : fr; }
  function tabLabel(id) { const row = TABS.find(x => x[0] === id); return row ? t(row[1], row[2]) : id; }

  function setSidebarActive(id) {
    document.querySelectorAll('.nav-sub-item').forEach(el => el.classList.toggle('active', el.dataset.adminTab === id));
  }

  async function showTab(id) {
    currentTab = id;
    setSidebarActive(id);
    const content = document.getElementById('adminTabContent');
    content.innerHTML = '<div class="empty-state">Chargement…</div>';
    try {
      const renderers = {
        overview: renderOverview, sites: renderSites, groups: renderGroups, zones: renderZones, users: renderUsers, roles: renderRoles,
        maincourante: renderMainCourante, alerts: renderAlerts, access: renderAccess, rounds: renderRounds,
        notifications: renderNotifications, cameras: renderCameras, integrations: renderIntegrations,
        data: renderData, audit: renderAudit, settings: renderSettings, ai: renderAi,
      };
      await (renderers[id] || renderUnknown)(content);
    } catch (e) {
      content.innerHTML = `<div class="card"><div class="card-body"><p class="mc-wf-error">${escapeHtml(t('Erreur de chargement : ', 'خطأ في التحميل: ') + (e.message || e))}</p></div></div>`;
    }
  }
  // UI4_SAFE_RERENDER (ui.js#setLanguage) : re-rend l'onglet courant au
  // changement de langue — seule la Vue générale (overview) est
  // intégralement traduite FR/AR dans ce lot ; les autres onglets se
  // ré-affichent simplement avec leurs données à jour.
  function renderAdminCurrentTab() { showTab(currentTab); }
  window.renderAdminCurrentTab = renderAdminCurrentTab;

  function renderUnknown(el) { el.innerHTML = '<div class="empty-state">Onglet inconnu</div>'; }

  /* ============================================================ */
  /*  Vue générale (cockpit) — RECETTE VISUELLE ÉCRAN 1              */
  /* ============================================================ */
  async function renderOverview(el) {
    if (!mcEventCatalog.categories.length) { try { await loadMcEventCatalog(); } catch { /* dégrade proprement : catégories affichées par id brut */ } }
    const [sys, ov] = await Promise.all([API.get('/admin/system'), API.get('/admin/overview')]);
    renderHeaderState(sys.health);
    const k = sys.kpis || {};

    const kpiDefs = [
      { icon: '🏢', tone: 'info', label: t('Sites', 'المواقع'), value: k.sites_total ?? 0, footerIcon: '✅', footerText: t(`${k.sites_active ?? 0} actifs`, `${k.sites_active ?? 0} نشط`), tab: 'sites' },
      { icon: '🛡️', tone: (k.users_blocked > 0 ? 'warning' : 'success'), label: t('Utilisateurs', 'المستخدمون'), value: k.users_total ?? 0, footerIcon: '🚫', footerText: t(`${k.users_blocked ?? 0} bloqués`, `${k.users_blocked ?? 0} محظور`), tab: 'users' },
      { icon: '📓', tone: 'purple', label: t('Codes Main courante', 'رموز السجل اليومي'), value: k.maincourante_codes ?? 0, footerIcon: '📈', footerText: t(`${ov.maincourante_last_7_days ?? 0} événements / 7 j`, `${ov.maincourante_last_7_days ?? 0} حدث / 7 أيام`), tab: 'maincourante' },
      { icon: '📍', tone: 'accent', label: t('Postes actifs', 'المراكز النشطة'), value: k.postes_actifs ?? 0, footerIcon: 'ℹ️', footerText: t('Voir Zones & postes', 'عرض المناطق والمراكز'), tab: 'zones' },
      { icon: '🚶', tone: 'success', label: t('Circuits de ronde', 'مسارات الجولات'), value: k.round_circuits ?? 0, footerIcon: 'ℹ️', footerText: t('Voir Rondes', 'عرض الجولات'), tab: 'rounds' },
      { icon: '📷', tone: (k.cameras == null ? 'warning' : 'info'), label: t('Caméras', 'الكاميرات'), value: k.cameras ?? '—', footerIcon: k.cameras == null ? '⚠️' : 'ℹ️', footerText: k.cameras == null ? t('registre indisponible', 'السجل غير متاح') : t('Voir Caméras / LAPI', 'عرض الكاميرات'), tab: 'cameras' },
    ];
    const kpiHtml = kpiDefs.map(d => renderKpi2Card({ icon: d.icon, tone: d.tone, label: d.label, value: d.value, footerIcon: d.footerIcon, footerText: d.footerText })).join('');

    const activityHtml = (ov.recent_activity || []).length
      ? ov.recent_activity.map(r => `
        <div class="admin-activity-row">
          <span class="admin-activity-time">${new Date(r.created_at).toLocaleString(lang() === 'ar' ? 'ar' : 'fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          <span class="admin-activity-text"><strong>${escapeHtml(r.actor_username || '—')}</strong> — ${escapeHtml(r.event_type)}</span>
          <span class="badge ${r.outcome === 'success' ? 'success' : r.outcome === 'denied' ? 'warning' : 'danger'}">${escapeHtml(r.outcome)}</span>
        </div>`).join('')
      : `<div class="empty-state">${t('Aucune activité récente', 'لا يوجد نشاط حديث')}</div>`;

    const sitesByStatus = ov.sites_by_status || {};
    const sitesStatusHtml = ['active', 'suspended', 'archived'].map(s => {
      const label = s === 'active' ? t('Actifs', 'نشط') : s === 'suspended' ? t('Suspendus', 'معلّق') : t('Archivés', 'مؤرشف');
      const cls = s === 'active' ? 'success' : s === 'suspended' ? 'warning' : 'muted';
      return `<div class="admin-status-row"><span>${label}</span><span class="badge ${cls}">${sitesByStatus[s] || 0}</span></div>`;
    }).join('');

    // FINITION VISUELLE : Répartition des événements et Sites les plus
    // actifs sont des widgets d'AGRÉGATION (n'ont de sens qu'avec des
    // données réelles à agréger) — jamais rendus en grande carte vide
    // "Donnée non disponible" ; simplement omis de la grille tant qu'aucune
    // donnée utile n'existe, contrairement à Sites par statut/État des
    // services dont les catégories sont réelles et fixes même à zéro
    // (un vrai compteur à 0 reste affiché, jamais masqué — item 7).
    const hasCategoryData = (ov.maincourante_by_category || []).length > 0;
    const categoryHtml = hasCategoryData
      ? ov.maincourante_by_category.map(r => `<div class="admin-status-row"><span>${escapeHtml(mcCategoryLabel(r.categorie))}</span><span class="badge muted">${r.c}</span></div>`).join('')
      : '';
    const hasTopSites = (ov.top_sites || []).length > 0;
    const topSitesHtml = hasTopSites
      ? ov.top_sites.map((s, i) => `<div class="admin-status-row"><span>${i + 1}. ${escapeHtml(s.name)}</span><span class="badge info">${s.c}</span></div>`).join('')
      : '';

    const svc = sys.health || {};
    const svcBadge = v => v === 'operational' ? `<span class="badge success">${t('Opérationnel', 'يعمل')}</span>`
      : v === 'not_configured' ? `<span class="badge muted">${t('Non configuré', 'غير مُهيأ')}</span>`
      : v === 'unavailable' ? `<span class="badge danger">${t('Indisponible', 'غير متاح')}</span>`
      : `<span class="badge warning">${t('À vérifier', 'يتطلب التحقق')}</span>`;
    const serviceRows = [
      [t('Application', 'التطبيق'), svc.application], [t('PostgreSQL', 'قاعدة البيانات'), svc.postgresql],
      [t('Notifications push', 'إشعارات فورية'), svc.push], [t('Caméras', 'الكاميرات'), svc.cameras],
      [t('API', 'واجهة API'), svc.api],
    ].map(([label, v]) => `<div class="admin-status-row"><span>${label}</span>${svcBadge(v)}</div>`).join('');

    // Main courante 7 jours : un vrai 0 reste affiché (item 7), mais jamais
    // comme un grand chiffre isolé flottant dans une carte par ailleurs
    // vide — un empty-state compact, cohérent avec les autres widgets sans
    // activité (ex. "Aucune activité récente" ci-dessus), remplace le
    // "graphique vide" que serait un simple "0" géant sans contexte.
    const mc7d = ov.maincourante_last_7_days ?? 0;
    const mc7dHtml = mc7d > 0
      ? `<div class="admin-big-number">${mc7d}</div>`
      : `<div class="empty-state">${t('Aucun événement sur les 7 derniers jours', 'لا يوجد حدث خلال آخر 7 أيام')}</div>`;

    const widgets = [
      { title: '🕓 ' + t('Activité récente Administration', 'النشاط الإداري الأخير'), body: activityHtml },
      { title: '🏢 ' + t('Sites par statut', 'المواقع حسب الحالة'), body: sitesStatusHtml },
      { title: '📓 ' + t('Événements Main courante — 7 derniers jours', 'أحداث السجل اليومي — آخر 7 أيام'), body: mc7dHtml, plain: true },
      hasCategoryData ? { title: '📊 ' + t('Répartition des événements', 'توزيع الأحداث'), body: categoryHtml } : null,
      hasTopSites ? { title: '📈 ' + t('Sites les plus actifs', 'أكثر المواقع نشاطًا'), body: topSitesHtml } : null,
      { title: '🖥️ ' + t('État des services', 'حالة الخدمات'), body: serviceRows + `<div class="admin-status-row"><span>${t('Espace stockage', 'مساحة التخزين')}</span><span class="badge info">${escapeHtml(ov.storage?.pretty || '—')}</span></div>` },
    ].filter(Boolean);
    const widgetsHtml = widgets.map(w => `
      <div class="card"><div class="card-header"><div class="card-title">${w.title}</div></div>
        <div class="card-body${w.plain ? '' : ' admin-widget-body'}">${w.body}</div></div>`).join('');

    el.innerHTML = `
      <div class="kpi-grid">${kpiHtml}</div>
      <div class="admin-cockpit-grid">${widgetsHtml}</div>
      <div class="card">
        <div class="card-header"><div class="card-title">⚡ ${t('Actions rapides', 'إجراءات سريعة')}</div></div>
        <div class="card-body admin-cockpit-actions">
          <button class="btn btn-primary" onclick="AdminSystem.openSiteWizard()">🏢 ${t('Ajouter un site', 'إضافة موقع')}</button>
          <button class="btn btn-outline" onclick="AdminSystem.openCreateUserModal()">🛡️ ${t('Créer un utilisateur', 'إنشاء مستخدم')}</button>
          <button class="btn btn-outline" onclick="AdminSystem.showTab('maincourante')">📓 ${t('Configurer Main courante', 'تهيئة السجل اليومي')}</button>
          <button class="btn btn-outline" onclick="AdminSystem.showTab('access')">🔐 ${t("Gérer les accès", 'إدارة الدخول')}</button>
          <button class="btn btn-outline" onclick="AdminSystem.showTab('audit')">📜 ${t("Voir l'audit", 'عرض سجل التدقيق')}</button>
          <button class="btn btn-outline" onclick="AdminSystem.showTab('data')">🗄️ ${t('Données & archivage', 'البيانات والأرشفة')}</button>
        </div>
      </div>`;

    el.querySelectorAll('.kpi-grid .kpi-card').forEach((card, i) => {
      card.classList.add('admin-kpi-clickable');
      card.addEventListener('click', () => showTab(kpiDefs[i].tab));
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(kpiDefs[i].tab); } });
    });
  }

  // FINITION VISUELLE : "Tous les services opérationnels" laissait entendre
  // que push/caméras non configurés l'étaient aussi — le socle critique
  // (application + PostgreSQL, sans lesquels rien ne fonctionne) est la
  // seule base d'un état "Système opérationnel" ; push/caméras/API restent
  // décrits individuellement dans la carte État des services, jamais
  // résumés comme "opérationnels" s'ils ne le sont pas réellement.
  const CRITICAL_SERVICES = ['application', 'postgresql'];
  function renderHeaderState(health) {
    const box = document.getElementById('adminHeaderState');
    if (!box) return;
    const h = health || {};
    const criticalOk = CRITICAL_SERVICES.every(k => h[k] === 'operational');
    box.innerHTML = criticalOk
      ? `<span class="badge success">✅ ${t('Système opérationnel', 'النظام يعمل بشكل طبيعي')}</span>`
      : `<span class="badge warning">⚠️ ${t('Services à vérifier', 'خدمات تتطلب التحقق')}</span>`;
  }

  /* ============================================================ */
  /*  Sites                                                         */
  /* ============================================================ */
  let sitesSelectMode = false;
  let sitesSelected = new Set();

  async function renderSites(el) {
    sitesSelectMode = false; sitesSelected = new Set();
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">🏢 Sites</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" onclick="AdminSystem.openSiteWizard()">+ Ajouter un site</button>
            <button class="btn btn-outline" id="adminSitesDeleteToggle" onclick="AdminSystem.toggleSitesSelectMode()">🗑 Supprimer</button>
          </div>
        </div>
        <div class="card-body">
          <div class="toolbar">
            <div class="search-box"><input type="text" id="adminSiteSearch" placeholder="Nom, code, client…" oninput="AdminSystem.reloadSites()"></div>
            <select id="adminSiteStatus" onchange="AdminSystem.reloadSites()">
              <option value="">Tous statuts</option><option value="active">Actif</option><option value="suspended">Suspendu</option><option value="archived">Archivé</option>
            </select>
          </div>
          <div class="table-wrap"><table><thead><tr id="adminSitesHeadRow"><th>Site</th><th>Client</th><th>Statut</th><th>Modifié</th><th>Actions</th></tr></thead><tbody id="adminSitesBody"></tbody></table></div>
        </div>
      </div>
      <div id="adminSiteDetail"></div>`;
    await reloadSites();
  }
  async function reloadSites() {
    const search = document.getElementById('adminSiteSearch')?.value || '';
    const status = document.getElementById('adminSiteStatus')?.value || '';
    const qs = new URLSearchParams({ ...(search ? { search } : {}), ...(status ? { status } : {}), limit: '100' });
    const data = await API.get('/admin/sites?' + qs.toString());
    sitesCache = data.sites;
    renderSitesTable();
  }
  function renderSitesTable() {
    const body = document.getElementById('adminSitesBody');
    const headRow = document.getElementById('adminSitesHeadRow');
    if (!body) return;
    if (headRow) {
      const existing = headRow.querySelector('.admin-select-col');
      if (sitesSelectMode && !existing) headRow.insertAdjacentHTML('afterbegin', `<th class="admin-select-col"><input type="checkbox" id="adminSitesSelectAll" onchange="AdminSystem.toggleSelectAllSites(this.checked)" aria-label="Tout sélectionner"></th>`);
      if (!sitesSelectMode && existing) existing.remove();
    }
    if (!sitesCache.length) { body.innerHTML = `<tr><td colspan="${sitesSelectMode ? 6 : 5}" class="empty-state">Aucun site</td></tr>`; return; }
    body.innerHTML = sitesCache.map(s => `
      <tr>
        ${sitesSelectMode ? `<td><input type="checkbox" class="admin-site-check" data-id="${s.id}" ${sitesSelected.has(s.id) ? 'checked' : ''} onchange="AdminSystem.toggleSiteSelected('${s.id}', this.checked)" aria-label="Sélectionner ${escapeHtml(s.name)}"></td>` : ''}
        <td><strong>${escapeHtml(s.name)}</strong><br><span class="muted">${escapeHtml(s.code)}</span></td>
        <td>${escapeHtml(s.client || '—')}</td>
        <td>${statusBadge(s.status)}</td>
        <td>${s.updated_at ? new Date(s.updated_at).toLocaleString('fr-FR') : '—'}</td>
        <td><button class="btn btn-sm btn-outline" onclick="AdminSystem.openSiteDetail('${s.id}')">Ouvrir</button></td>
      </tr>`).join('');
  }
  function toggleSitesSelectMode() {
    sitesSelectMode = !sitesSelectMode;
    sitesSelected = new Set();
    const btn = document.getElementById('adminSitesDeleteToggle');
    if (btn) {
      btn.textContent = sitesSelectMode ? '✕ Annuler' : '🗑 Supprimer';
      btn.classList.toggle('btn-danger', sitesSelectMode);
      btn.classList.toggle('btn-outline', !sitesSelectMode);
    }
    renderSitesTable();
    updateSitesDeleteBar();
  }
  function toggleSiteSelected(id, checked) {
    if (checked) sitesSelected.add(id); else sitesSelected.delete(id);
    updateSitesDeleteBar();
  }
  function toggleSelectAllSites(checked) {
    sitesSelected = new Set(checked ? sitesCache.map(s => s.id) : []);
    document.querySelectorAll('.admin-site-check').forEach(c => { c.checked = checked; });
    updateSitesDeleteBar();
  }
  function updateSitesDeleteBar() {
    let bar = document.getElementById('adminSitesDeleteBar');
    if (!sitesSelectMode || sitesSelected.size === 0) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'adminSitesDeleteBar';
      bar.className = 'admin-delete-bar';
      document.getElementById('adminSitesBody').closest('.table-wrap').insertAdjacentElement('afterend', bar);
    }
    bar.innerHTML = `<span>${sitesSelected.size} site(s) sélectionné(s)</span><button class="btn btn-danger btn-sm" onclick="AdminSystem.confirmDeleteSelectedSites()">Supprimer la sélection</button>`;
  }
  function confirmDeleteSite(id, name, code) {
    showModal('🗑 Supprimer ce site', `
      <p>Vous êtes sur le point de supprimer définitivement <strong>${escapeHtml(name)}</strong>.</p>
      <p class="mc-detail-note">Refusée automatiquement si des données réelles y sont associées (zones, postes, appartenances, événements Main courante, rondes, équipement) — archivez-le plutôt dans ce cas.</p>
      <div class="form-group"><label>Motif *</label><input type="text" id="deleteSiteReason"></div>
    `, async () => {
      const reason = document.getElementById('deleteSiteReason').value.trim();
      if (!reason) { notify('Motif requis', 'error'); return; }
      try {
        await API.del('/admin/sites/' + id, { reason });
        closeModal();
        notify('Site supprimé');
        document.getElementById('adminSiteDetail').innerHTML = '';
        await reloadSites();
      } catch (e) {
        // MISSION CORRECTION CIBLÉE — SITES : un refus 409 pour dépendances
        // réelles n'est plus un simple toast — l'administrateur doit
        // comprendre pourquoi et pouvoir agir (voir showSiteDeleteRefusedModal).
        if (e.status === 409) { closeModal(); showSiteDeleteRefusedModal({ id, name, code }); return; }
        notify(e.message || 'Erreur', 'error');
      }
    }, 'Supprimer définitivement');
  }
  function confirmDeleteSelectedSites() {
    const targets = sitesCache.filter(s => sitesSelected.has(s.id));
    showModal('🗑 Supprimer ' + targets.length + ' site(s)', `
      <p>Vous êtes sur le point de supprimer définitivement :</p>
      <ul>${targets.map(s => `<li>${escapeHtml(s.name)}</li>`).join('')}</ul>
      <p class="mc-detail-note">Refusée automatiquement pour tout site avec des données réelles associées (zones, postes, appartenances, événements Main courante, rondes, équipement) — archivez-le plutôt dans ce cas.</p>
      <div class="form-group"><label>Motif *</label><input type="text" id="deleteSitesReason" placeholder="ex: site de test / recette"></div>
    `, async () => {
      const reason = document.getElementById('deleteSitesReason').value.trim();
      if (!reason) { notify('Motif requis', 'error'); return; }
      let ok = 0; const refused = [];
      for (const s of targets) {
        try { await API.del('/admin/sites/' + s.id, { reason }); ok++; }
        catch (e) { if (e.status === 409) refused.push(s); }
      }
      closeModal();
      if (ok) notify(ok + ' site(s) supprimé(s)', 'success');
      sitesSelectMode = false; sitesSelected = new Set();
      const btn = document.getElementById('adminSitesDeleteToggle');
      if (btn) { btn.textContent = '🗑 Supprimer'; btn.classList.remove('btn-danger'); btn.classList.add('btn-outline'); }
      await reloadSites();
      updateSitesDeleteBar();
      // MISSION CORRECTION CIBLÉE — SITES : un refus se comprend désormais
      // et se traite (Voir dépendances / Désactiver / Archiver), site par
      // site — jamais plus un simple compteur technique agrégé.
      if (refused.length === 1) showSiteDeleteRefusedModal(refused[0]);
      else if (refused.length > 1) showMultipleSitesRefusedModal(refused);
    }, 'Supprimer définitivement');
  }
  function statusBadge(s) {
    if (s === 'active') return '<span class="badge success">Actif</span>';
    if (s === 'suspended') return '<span class="badge warning">Suspendu</span>';
    return '<span class="badge muted">Archivé</span>';
  }
  // MISSION CORRECTION CIBLÉE — ADMINISTRATION SYSTÈME → SITES : gestion
  // d'une suppression refusée. Ne contourne AUCUNE protection existante
  // (409/FK/motif/audit/permissions/RLS — toutes inchangées, backend/
  // admin-sites.js) — remplace uniquement le message technique brut par
  // une interface qui explique le refus et propose les actions déjà
  // supportées par le cycle de vie du site (Désactiver=suspended,
  // Archiver=archived, tous deux déjà audités par PUT /sites/:id/status).
  // MISSION — DÉPENDANCES SITE : sous-titre demandé + mise en évidence
  // (⚠, gras) UNIQUEMENT des compteurs > 0 — jamais une alerte rouge sur
  // une catégorie à 0. [Voir] n'apparaît que sur "Utilisateurs /
  // appartenances actives" : c'est la SEULE catégorie pour laquelle un
  // vrai détail (identité réelle, action Gérer) existe dans ce lot —
  // ajouter [Voir] sur les autres catégories sans détail réel derrière
  // serait un bouton qui ne fait rien d'honnête. `targetId` identifie le
  // conteneur à réutiliser pour le drill-down (la modale de refus et
  // l'onglet Dépendances de la fiche site partagent ce même mécanisme).
  function renderDependenciesTable(deps, siteId, targetId) {
    const row = (label, value, viewAction) => {
      const positive = value > 0;
      const cell = positive ? `<strong>${value}</strong> ⚠` : String(value);
      const action = (positive && viewAction) ? `<button class="btn btn-sm btn-outline" onclick="${viewAction}">Voir</button>` : '';
      return `<tr${positive ? ' class="dep-row-blocking"' : ''}><td>${label}</td><td>${cell}</td><td>${action}</td></tr>`;
    };
    return `
      <p class="mc-detail-note" style="margin-top:0">Dépendances empêchant la suppression</p>
      <table><tbody>
        ${row('Zones', deps.zones)}
        ${row('Postes', deps.postes)}
        ${row('Utilisateurs / appartenances actives', deps.active_memberships, `AdminSystem.viewSiteMembershipDependencies('${siteId}','${targetId}')`)}
        ${row('Événements Main courante', deps.main_courante_events)}
        ${row('Rondes', deps.rounds)}
        ${row('Équipements', deps.equipment)}
        ${row('Circuits de ronde', deps.round_circuits)}
        ${row('Profils APS', deps.aps)}
        ${row('Présences (cycles APS)', deps.presence)}
        ${row('PCS01', deps.pcs01_config)}
      </tbody></table>
      <p class="mc-detail-note">Non comptabilisé ici (aucune colonne site dans le schéma actuel — jamais une valeur fictive) : ${deps.not_scoped_by_site.join(', ')}.</p>`;
  }
  async function showRefusedModalDependencies(id) {
    const target = document.getElementById('siteDeleteRefusedDeps');
    if (!target) return;
    target.innerHTML = '<p class="mc-detail-note">Chargement…</p>';
    try { target.innerHTML = renderDependenciesTable(await API.get('/admin/sites/' + id + '/dependencies'), id, 'siteDeleteRefusedDeps'); }
    catch (e) { target.innerHTML = `<p class="mc-wf-error">${escapeHtml(e.message || 'Erreur')}</p>`; }
  }
  function scopeLabel(scope) {
    if (scope === 'tenant') return 'Groupe entier';
    if (scope === 'zone') return 'Zone';
    return 'Site';
  }
  // Détail réel des appartenances qui bloquent la suppression — réutilise
  // exactement le même filtre que le compteur affiché (GET .../
  // dependencies/memberships, backend/admin-sites.js, même WHERE que
  // countSiteDependencies()) : jamais une seconde source qui pourrait
  // diverger. Rend DANS le même conteneur que le tableau récapitulatif
  // (targetId) — fonctionne aussi bien depuis la modale de refus que
  // depuis l'onglet Dépendances de la fiche site.
  async function viewSiteMembershipDependencies(siteId, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.innerHTML = '<p class="mc-detail-note">Chargement…</p>';
    try {
      const { memberships } = await API.get('/admin/sites/' + siteId + '/dependencies/memberships');
      siteMembershipsCache = memberships;
      // MISSION §6 (modale utilisable à 1920/1440/820/390px) : un tableau à
      // 9 colonnes ne tient dans AUCUNE largeur de modale (max-width:580px)
      // sans défilement horizontal qui cacherait le bouton Gérer — une
      // carte empilée par appartenance reste lisible et actionnable à
      // toutes les tailles, y compris 390px, sans rien couper.
      target.innerHTML = `
        <p class="mc-detail-note" style="margin-top:0"><a href="#" onclick="event.preventDefault();AdminSystem.backToSiteDependencies('${siteId}','${targetId}')">← Retour aux dépendances</a></p>
        ${memberships.map(m => `
          <div class="dep-membership-card">
            <div class="dep-membership-card-head">
              <strong>${escapeHtml(m.nom_complet || m.username)}</strong>
              ${m.account_role === 'admin' ? ' <span class="badge muted" title="Administrateur global — privilège de compte, indépendant de cette appartenance">Admin global</span>' : ''}
              ${m.status === 'active' ? '<span class="badge success">Actif</span>' : '<span class="badge muted">Archivé</span>'}
            </div>
            <dl class="dep-membership-card-fields">
              <div><dt>Identifiant</dt><dd>${escapeHtml(m.username)}</dd></div>
              <div><dt>Rôle</dt><dd>${escapeHtml(roleLabel(m.membership_role))}</dd></div>
              <div><dt>Groupe</dt><dd>${escapeHtml(m.tenant_name)}</dd></div>
              <div><dt>Type de scope</dt><dd>${escapeHtml(scopeLabel(m.scope))}</dd></div>
              <div><dt>Site</dt><dd>${escapeHtml(m.site_name || '—')}</dd></div>
              <div><dt>Créé le</dt><dd>${m.created_at ? new Date(m.created_at).toLocaleString('fr-FR') : '—'}</dd></div>
            </dl>
            <button class="btn btn-sm btn-outline" onclick="AdminSystem.manageMembershipModal('${m.membership_id}','${siteId}','${targetId}')">Gérer</button>
          </div>`).join('') || `<p class="empty-state">Aucune appartenance active — le compteur a peut-être déjà été mis à jour, revenez et rafraîchissez.</p>`}`;
    } catch (e) { target.innerHTML = `<p class="mc-wf-error">${escapeHtml(e.message || 'Erreur')}</p>`; }
  }
  async function backToSiteDependencies(siteId, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.innerHTML = '<p class="mc-detail-note">Chargement…</p>';
    try { target.innerHTML = renderDependenciesTable(await API.get('/admin/sites/' + siteId + '/dependencies'), siteId, targetId); }
    catch (e) { target.innerHTML = `<p class="mc-wf-error">${escapeHtml(e.message || 'Erreur')}</p>`; }
  }
  // "Gérer" une appartenance précise — UNIQUEMENT les actions réellement
  // compatibles avec le modèle memberships existant (statut actif/archivé,
  // immuable par ailleurs — trigger memberships_no_delete) :
  //  - Retirer l'accès à ce site = archiver CETTE appartenance précise
  //    (DELETE /admin/memberships/:id, jamais toutes celles de
  //    l'utilisateur sur le groupe — voir backend/admin-groups.js) ;
  //  - Réaffecter = archiver puis créer une nouvelle appartenance ailleurs
  //    (POST /admin/groups/:id/users déjà existant, jamais un second
  //    mécanisme de "déplacement" qui n'existe pas dans le modèle).
  // Un Administrateur global (compte) ne perd JAMAIS son statut global en
  // retirant une de ses appartenances — users.role est indépendant des
  // memberships (voir backend/permissions.js/scope.js) : rappelé ici
  // explicitement pour ne jamais laisser croire le contraire.
  function manageMembershipModal(membershipId, siteId, targetId) {
    const m = siteMembershipsCache.find(x => x.membership_id === membershipId);
    if (!m) { notify('Appartenance introuvable — rafraîchissez la liste', 'error'); return; }
    const globalAdminNote = m.account_role === 'admin'
      ? `<p class="mc-detail-note">⚠ <strong>${escapeHtml(m.username)}</strong> est Administrateur global : retirer cette appartenance ne retire JAMAIS ses privilèges globaux (indépendants des appartenances) — seul son accès via CE groupe/site change.</p>` : '';
    showModal('👤 Gérer l\'appartenance', `
      <p>Utilisateur : <strong>${escapeHtml(m.nom_complet || m.username)}</strong> (${escapeHtml(m.username)})</p>
      <p>Groupe : <strong>${escapeHtml(m.tenant_name)}</strong> — Site : <strong>${escapeHtml(m.site_name || '—')}</strong> — Rôle : ${escapeHtml(roleLabel(m.membership_role))}</p>
      ${globalAdminNote}
      <p class="mc-detail-note">Impact : ${escapeHtml(m.username)} perdra l'accès à ce site via ce groupe. Aucune autre appartenance n'est modifiée. Action auditée.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-danger btn-sm" onclick="AdminSystem.archiveMembershipAction('${m.membership_id}','${siteId}','${targetId}')">🚫 Retirer l'accès à ce site</button>
        <button class="btn btn-outline btn-sm" onclick="AdminSystem.reassignMembershipModal('${m.membership_id}','${siteId}','${targetId}')">↪ Réaffecter à un autre groupe/site</button>
      </div>
    `, () => closeModal(), 'Fermer');
  }
  // showModal() ne s'empile pas (un seul emplacement #modalContent,
  // réutilisé) : ouvrir "Gérer" DEPUIS la modale de refus remplace son
  // contenu — #siteDeleteRefusedDeps n'existe donc plus après coup, jamais
  // récupérable. §5 mission ("rafraîchir automatiquement les dépendances")
  // est donc satisfait ici par une modale de confirmation DÉDIÉE, toujours
  // ouverte après une action réussie, quel que soit le point d'entrée
  // (modale de refus OU onglet Dépendances de la fiche site) — jamais un
  // simple toast qui ne montrerait pas réellement "1 → 0".
  async function showUpdatedDependenciesModal(siteId) {
    let deps;
    try { deps = await API.get('/admin/sites/' + siteId + '/dependencies'); }
    catch (e) { notify(e.message || 'Erreur', 'error'); return; }
    showModal('✅ Dépendances mises à jour', `
      <div id="depsUpdatedModalBody">${renderDependenciesTable(deps, siteId, 'depsUpdatedModalBody')}</div>
      <p class="mc-detail-note">La suppression du site n'est jamais automatique — revenez sur sa fiche et cliquez vous-même sur Supprimer si vous le souhaitez.</p>
    `, () => closeModal(), 'Fermer');
  }
  async function archiveMembershipAction(membershipId, siteId, targetId) {
    try {
      await API.del('/admin/memberships/' + membershipId);
      closeModal();
      notify('Accès retiré — appartenance archivée (historique conservé)');
      // §5 mission : rafraîchir automatiquement les dépendances, jamais
      // déclencher la suppression du site — l'administrateur doit revenir
      // cliquer lui-même sur Supprimer. Rafraîchit EN PLACE si le
      // conteneur d'origine existe encore (onglet Dépendances de la fiche
      // site) — sinon (modale de refus, détruite par "Gérer" ci-dessus),
      // une modale de confirmation dédiée montre le compteur à jour.
      if (document.getElementById(targetId)) await viewSiteMembershipDependencies(siteId, targetId);
      else await showUpdatedDependenciesModal(siteId);
      await reloadSites();
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }
  async function reassignMembershipModal(membershipId, siteId, targetId) {
    const m = siteMembershipsCache.find(x => x.membership_id === membershipId);
    if (!m) { notify('Appartenance introuvable — rafraîchissez la liste', 'error'); return; }
    let groups = [];
    try { groups = (await API.get('/admin/groups?limit=200')).groups; } catch (e) { notify(e.message || 'Erreur', 'error'); return; }
    const groupOptions = groups.filter(g => g.status === 'active').map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
    const roleOptions = MEMBERSHIP_ROLES.map(r => `<option value="${r}" ${r === m.membership_role ? 'selected' : ''}>${escapeHtml(roleLabel(r))}</option>`).join('');
    showModal('↪ Réaffecter ' + escapeHtml(m.username), `
      <p class="mc-detail-note" style="margin-top:0">Retire l'accès actuel (${escapeHtml(m.tenant_name)} / ${escapeHtml(m.site_name || '—')}) puis affecte ${escapeHtml(m.username)} au nouveau groupe/site choisi ci-dessous.</p>
      <div class="form-row"><div class="form-group"><label>Nouveau groupe *</label><select id="reassignGroup" onchange="AdminSystem.reassignLoadSites(this.value)">${groupOptions}</select></div>
        <div class="form-group"><label>Rôle *</label><select id="reassignRole">${roleOptions}</select></div></div>
      <div class="form-group"><label><input type="checkbox" id="reassignAllSites" checked onchange="document.getElementById('reassignSitesBox').style.display=this.checked?'none':'block'"> Tous les sites du groupe</label></div>
      <div id="reassignSitesBox" style="display:none"><p class="empty-state">Choisissez d'abord un groupe.</p></div>
    `, async () => {
      const groupId = document.getElementById('reassignGroup').value;
      const role = document.getElementById('reassignRole').value;
      const allSites = document.getElementById('reassignAllSites').checked;
      const siteIds = [...document.querySelectorAll('.reassign-site:checked')].map(c => c.value);
      if (!groupId) { notify('Groupe requis', 'error'); return; }
      if (!allSites && !siteIds.length) { notify('Sélectionnez au moins un site ou « Tous les sites »', 'error'); return; }
      try {
        await API.del('/admin/memberships/' + m.membership_id);
        await API.post('/admin/groups/' + groupId + '/users', { user_id: m.user_id, role, all_sites: allSites, site_ids: siteIds });
        closeModal();
        notify('Utilisateur réaffecté');
        if (document.getElementById(targetId)) await viewSiteMembershipDependencies(siteId, targetId);
        else await showUpdatedDependenciesModal(siteId);
        await reloadSites();
      } catch (e) { notify(e.message || 'Erreur', 'error'); }
    }, 'Réaffecter');
  }
  async function reassignLoadSites(groupId) {
    const box = document.getElementById('reassignSitesBox');
    if (!box) return;
    box.innerHTML = '<p class="mc-detail-note">Chargement…</p>';
    try {
      const { sites } = await API.get('/admin/groups/' + groupId + '/sites');
      box.innerHTML = sites.length
        ? sites.map(s => `<label style="display:block"><input type="checkbox" class="reassign-site" value="${s.id}"> ${escapeHtml(s.name)} <span class="muted">(${escapeHtml(s.code)})</span></label>`).join('')
        : '<p class="empty-state">Ce groupe ne contient encore aucun site</p>';
    } catch (e) { box.innerHTML = `<p class="mc-wf-error">${escapeHtml(e.message || 'Erreur')}</p>`; }
  }
  function showSiteDeleteRefusedModal(site) {
    showModal('🚫 Suppression impossible — dépendances existantes', `
      <p>Le site « <strong>${escapeHtml(site.name)}</strong> (${escapeHtml(site.code)}) » contient des données ou éléments rattachés.</p>
      <p class="mc-detail-note">La suppression directe est bloquée afin de préserver l'intégrité et l'historique du système.</p>
      <div id="siteDeleteRefusedDeps"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-outline btn-sm" onclick="closeModal();AdminSystem.setSiteStatus('${site.id}','suspended')">⏸ Désactiver</button>
        <button class="btn btn-outline btn-sm" onclick="closeModal();AdminSystem.setSiteStatus('${site.id}','archived')">🗄 Archiver</button>
      </div>
      <p class="mc-detail-note" style="margin-top:12px">La purge définitive des données est une opération d'administration avancée et doit être réalisée depuis <strong>Données &amp; archivage</strong>.</p>
    `, () => showRefusedModalDependencies(site.id), '🔍 Voir les dépendances');
  }
  function showMultipleSitesRefusedModal(sites) {
    showModal('🚫 ' + sites.length + ' site(s) non supprimé(s) — dépendances existantes', `
      <p class="mc-detail-note">La suppression directe est bloquée pour ces sites afin de préserver l'intégrité et l'historique du système. Choisissez un site pour voir ses dépendances et le désactiver ou l'archiver.</p>
      <table><tbody>
        ${sites.map(s => `<tr><td><strong>${escapeHtml(s.name)}</strong><br><span class="muted">${escapeHtml(s.code)}</span></td>
          <td style="text-align:end"><button class="btn btn-sm btn-outline" onclick="AdminSystem.manageRefusedSite('${s.id}','${escapeHtml(s.name).replace(/'/g, "\\'")}','${s.code}')">Gérer →</button></td></tr>`).join('')}
      </tbody></table>
      <p class="mc-detail-note" style="margin-top:12px">La purge définitive des données est une opération d'administration avancée et doit être réalisée depuis <strong>Données &amp; archivage</strong>.</p>
    `, () => closeModal(), 'Fermer');
  }
  function manageRefusedSite(id, name, code) {
    closeModal();
    showSiteDeleteRefusedModal({ id, name, code });
  }

  async function openSiteDetail(id) {
    const [site, deps] = await Promise.all([API.get('/admin/sites/' + id), API.get('/admin/sites/' + id + '/dependencies')]);
    const panel = document.getElementById('adminSiteDetail');
    panel.innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">📍 ${escapeHtml(site.name)}</div>
          <button class="btn btn-sm btn-outline" onclick="document.getElementById('adminSiteDetail').innerHTML=''">✕ Fermer</button>
        </div>
        <div class="card-body">
          <div class="tabs">
            <div class="tab active" onclick="AdminSystem.switchSiteTab(this,'general')">Général</div>
            <div class="tab" onclick="AdminSystem.switchSiteTab(this,'deps')">Dépendances</div>
          </div>
          <div id="siteTab-general">
            <div class="form-row"><div class="form-group"><label>Nom</label><input type="text" id="siteEditName" value="${escapeHtml(site.name)}"></div>
              <div class="form-group"><label>Client</label><input type="text" id="siteEditClient" value="${escapeHtml(site.client || '')}"></div></div>
            <div class="form-row"><div class="form-group"><label>Téléphone</label><input type="text" id="siteEditPhone" value="${escapeHtml(site.phone || '')}"></div>
              <div class="form-group"><label>Email</label><input type="text" id="siteEditEmail" value="${escapeHtml(site.email || '')}"></div></div>
            <div class="form-row full"><div class="form-group"><label>Adresse</label><input type="text" id="siteEditAddress" value="${escapeHtml(site.address || '')}"></div></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              <button class="btn btn-primary" onclick="AdminSystem.saveSite('${site.id}')">Enregistrer</button>
              ${site.status !== 'active' ? `<button class="btn btn-success" onclick="AdminSystem.setSiteStatus('${site.id}','active')">Activer</button>` : ''}
              ${site.status !== 'suspended' ? `<button class="btn btn-outline" onclick="AdminSystem.setSiteStatus('${site.id}','suspended')">Suspendre</button>` : ''}
              ${site.status !== 'archived' ? `<button class="btn btn-danger" onclick="AdminSystem.setSiteStatus('${site.id}','archived')">Archiver</button>` : ''}
              <button class="btn btn-danger" onclick="AdminSystem.confirmDeleteSite('${site.id}','${escapeHtml(site.name).replace(/'/g, "\\'")}','${site.code}')">🗑 Supprimer</button>
            </div>
          </div>
          <div id="siteTab-deps" style="display:none">${renderDependenciesTable(deps, site.id, 'siteTab-deps')}</div>
        </div>
      </div>`;
  }
  function switchSiteTab(el, name) {
    el.parentElement.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    ['general', 'deps'].forEach(id => { const n = document.getElementById('siteTab-' + id); if (n) n.style.display = id === name ? 'block' : 'none'; });
  }
  async function saveSite(id) {
    try {
      await API.put('/admin/sites/' + id, {
        name: document.getElementById('siteEditName').value,
        client: document.getElementById('siteEditClient').value,
        phone: document.getElementById('siteEditPhone').value,
        email: document.getElementById('siteEditEmail').value,
        address: document.getElementById('siteEditAddress').value,
      });
      notify('Site mis à jour');
      await reloadSites();
      await openSiteDetail(id);
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }
  async function setSiteStatus(id, status) {
    const reason = status === 'archived' ? prompt('Motif de l’archivage (optionnel) :') : null;
    try {
      await API.put('/admin/sites/' + id + '/status', { status, reason: reason || undefined });
      notify('Statut mis à jour');
      await reloadSites();
      await openSiteDetail(id);
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }

  function openSiteWizard() {
    showModal('➕ Ajouter un site — Identité', `
      <p class="mc-detail-note">Étape 1/1 (V1) : identité du site. Zones/postes/accès/Main courante/rondes/utilisateurs se configurent ensuite depuis la fiche du site.</p>
      <div class="form-row"><div class="form-group"><label>Code *</label><input type="text" id="wizSiteCode" placeholder="ex: alger-nord"></div>
        <div class="form-group"><label>Nom *</label><input type="text" id="wizSiteName"></div></div>
      <div class="form-row"><div class="form-group"><label>Client</label><input type="text" id="wizSiteClient"></div>
        <div class="form-group"><label>Téléphone</label><input type="text" id="wizSitePhone"></div></div>
      <div class="form-row full"><div class="form-group"><label>Email</label><input type="text" id="wizSiteEmail"></div></div>
      <div class="form-row full"><div class="form-group"><label>Adresse</label><input type="text" id="wizSiteAddress"></div></div>
    `, async () => {
      try {
        await API.post('/admin/sites', {
          code: document.getElementById('wizSiteCode').value.trim(),
          name: document.getElementById('wizSiteName').value.trim(),
          client: document.getElementById('wizSiteClient').value || undefined,
          phone: document.getElementById('wizSitePhone').value || undefined,
          email: document.getElementById('wizSiteEmail').value || undefined,
          address: document.getElementById('wizSiteAddress').value || undefined,
        });
        closeModal();
        notify('Site créé');
        if (currentTab === 'sites') await reloadSites();
        else await showTab('sites');
      } catch (e) { notify(e.message || 'Erreur', 'error'); }
    }, 'Créer le site');
  }

  /* ============================================================ */
  /*  Groupes + affectation des sites (LOT GROUPES)                  */
  /*  Groupe = tenant, Sites du groupe = sites.tenant_id, Utilisateur */
  /*  du groupe = memberships (backend/admin-groups.js — jamais un    */
  /*  second référentiel ni une copie des sites OPS).                 */
  /* ============================================================ */
  // CORRECTION UX CIBLÉE — la fiche d'un groupe ouvert s'affiche dans un
  // panneau DROIT à côté de la liste (jamais en dessous) : un utilisateur
  // réel avait signalé "Ouvrir ne fait rien" alors que la fiche était en
  // fait correctement injectée, mais hors du viewport sous une longue
  // liste de groupes — bug de layout, pas de logique métier (jamais
  // touchée ici : mêmes endpoints, mêmes onglets, mêmes règles).
  function groupDetailEmptyStateHtml() {
    return `<div class="admin-groups-empty-state"><div class="admin-groups-empty-icon">👥</div><p>${t('Sélectionnez un groupe pour afficher sa configuration.', 'اختر مجموعة لعرض إعداداتها.')}</p></div>`;
  }
  async function renderGroups(el) {
    currentGroupId = null;
    groupsStatusFilter = '';
    el.innerHTML = `
      <div class="admin-groups-page-header">
        <div>
          <div class="admin-groups-page-title">👥 ${t('Groupes', 'المجموعات')}</div>
          <div class="admin-groups-page-subtitle">${t('Gestion des groupes, sites et utilisateurs', 'إدارة المجموعات والمواقع والمستخدمين')}</div>
        </div>
      </div>
      <div class="admin-groups-shell">
        <div class="admin-groups-layout" id="adminGroupsLayout">
          <div class="admin-groups-list-col">
            <div class="admin-groups-list-header">
              <div class="admin-groups-list-title">${t('Liste des groupes', 'قائمة المجموعات')} <span class="badge muted" id="adminGroupsCount">0</span></div>
              <button type="button" class="btn btn-primary btn-sm" onclick="AdminSystem.openGroupWizard()">+ ${t('Nouveau groupe', 'مجموعة جديدة')}</button>
            </div>
            <div class="admin-groups-list-body">
              <div class="search-box"><input type="text" id="adminGroupSearch" placeholder="${t('Rechercher un groupe…', 'ابحث عن مجموعة…')}" oninput="AdminSystem.reloadGroups()"></div>
              <div class="admin-groups-pills" id="adminGroupsFilterPills"></div>
              <div class="table-wrap"><table class="admin-groups-table"><thead><tr>
                <th>${t('Code', 'الرمز')}</th><th>${t('Nom', 'الاسم')}</th><th>${t('Sites', 'المواقع')}</th><th>${t('Utilisateurs', 'المستخدمون')}</th><th>${t('Statut', 'الحالة')}</th><th>${t('Actions', 'إجراءات')}</th>
              </tr></thead><tbody id="adminGroupsBody"></tbody></table></div>
            </div>
          </div>
          <div class="admin-groups-detail-col">
            <div id="adminGroupDetail">${groupDetailEmptyStateHtml()}</div>
          </div>
        </div>
      </div>`;
    await reloadGroups();
  }
  // Un seul appel réseau (filtré par recherche uniquement) : le statut se
  // filtre ensuite côté client via les pills, ce qui permet d'afficher un
  // compteur réel par statut sans multiplier les requêtes serveur.
  async function reloadGroups() {
    const search = document.getElementById('adminGroupSearch')?.value || '';
    const qs = new URLSearchParams({ ...(search ? { search } : {}), limit: '200' });
    const data = await API.get('/admin/groups?' + qs.toString());
    groupsCache = data.groups;
    renderGroupsTable();
  }
  function setGroupsStatusFilter(status) {
    groupsStatusFilter = status;
    renderGroupsTable();
  }
  function renderGroupsTable() {
    const body = document.getElementById('adminGroupsBody');
    if (!body) return;
    const counts = { '': groupsCache.length, active: 0, suspended: 0, archived: 0 };
    groupsCache.forEach(g => { counts[g.status] = (counts[g.status] || 0) + 1; });
    const pillsEl = document.getElementById('adminGroupsFilterPills');
    if (pillsEl) {
      const pills = [
        ['', t('Tous', 'الكل')], ['active', t('Actifs', 'نشط')],
        ['suspended', t('Inactifs', 'غير نشط')], ['archived', t('Archivés', 'مؤرشف')],
      ];
      pillsEl.innerHTML = pills.map(([val, label]) => `<button type="button" class="admin-groups-pill${groupsStatusFilter === val ? ' active' : ''}" aria-pressed="${groupsStatusFilter === val}" onclick="AdminSystem.setGroupsStatusFilter('${val}')">${escapeHtml(label)} (${counts[val] || 0})</button>`).join('');
    }
    const countEl = document.getElementById('adminGroupsCount');
    if (countEl) countEl.textContent = groupsCache.length;
    const visible = groupsStatusFilter ? groupsCache.filter(g => g.status === groupsStatusFilter) : groupsCache;
    if (!visible.length) { body.innerHTML = `<tr><td colspan="6" class="empty-state">${t('Aucun groupe', 'لا توجد مجموعة')}</td></tr>`; return; }
    // §3/§4 mission : plus de gros bouton texte "Ouvrir" par ligne — la
    // ligne entière s'ouvre au clic et au clavier (Entrée/Espace),
    // aria-selected déjà posé sur <tr> — jamais un rôle ARIA détourné qui
    // casserait la sémantique de table native pour un lecteur d'écran. Le menu "⋯"
    // stoppe sa propre propagation (posé en JS) pour ne jamais déclencher
    // l'ouverture de la ligne en même temps que son menu (§4 mission).
    body.innerHTML = visible.map(g => `
      <tr data-group-id="${g.id}" class="admin-groups-row-clickable${g.id === currentGroupId ? ' admin-groups-row-selected' : ''}" tabindex="0"${g.id === currentGroupId ? ' aria-selected="true"' : ''} onclick="AdminSystem.openGroupDetail('${g.id}')" onkeydown="AdminSystem.groupRowKeydown(event,'${g.id}')">
        <td><strong title="${escapeHtml(g.code)}">${escapeHtml(g.code)}</strong></td>
        <td title="${escapeHtml(g.name)}"><span>${escapeHtml(g.name)}</span></td>
        <td>${g.sites_count}</td>
        <td>${g.users_count}</td>
        <td>${groupStatusBadge(g.status)}</td>
        <td>${renderGroupRowMenu(g)}</td>
      </tr>`).join('');
  }
  function renderGroupRowMenu(g) {
    return `
      <div class="admin-actions-menu">
        <button type="button" class="admin-groups-row-menu-btn" onclick="event.stopPropagation(); AdminSystem.toggleGroupRowMenu(event,'${g.id}')" aria-haspopup="true" aria-expanded="false" aria-label="${escapeHtml(t('Actions pour', 'إجراءات لـ') + ' ' + g.name)}">⋯</button>
        <div class="admin-actions-dropdown" data-row-menu="${g.id}" onclick="event.stopPropagation()" hidden>
          <button type="button" onclick="AdminSystem.openGroupDetail('${g.id}')">${t('Ouvrir', 'فتح')}</button>
          <button type="button" onclick="AdminSystem.openGroupDetailAndEdit('${g.id}')">${t('Modifier', 'تعديل')}</button>
          ${g.status !== 'active'
            ? `<button type="button" onclick="AdminSystem.setGroupStatus('${g.id}','active')">${t('Activer', 'تفعيل')}</button>`
            : `<button type="button" onclick="AdminSystem.setGroupStatus('${g.id}','suspended')">${t('Désactiver', 'إلغاء التفعيل')}</button>`}
          ${g.status !== 'archived' ? `<button type="button" class="admin-actions-dropdown-danger" onclick="AdminSystem.setGroupStatus('${g.id}','archived')">${t('Archiver', 'أرشفة')}</button>` : ''}
        </div>
      </div>`;
  }
  // Un seul menu de ligne ouvert à la fois — ferme les autres avant
  // d'ouvrir celui demandé (même mécanisme que le menu "Plus d'actions"
  // de la fiche, app.js#toggleLangMenu).
  function toggleGroupRowMenu(event, id) {
    const btn = event.currentTarget;
    document.querySelectorAll('#adminGroupsBody .admin-actions-dropdown[data-row-menu]').forEach(dd => {
      if (dd.dataset.rowMenu !== id) { dd.setAttribute('hidden', ''); dd.previousElementSibling?.setAttribute('aria-expanded', 'false'); }
    });
    const dd = document.querySelector(`#adminGroupsBody .admin-actions-dropdown[data-row-menu="${id}"]`);
    if (!dd) return;
    const opening = dd.hasAttribute('hidden');
    if (opening) { dd.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
    else { dd.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
  }
  function closeAllGroupRowMenus() {
    document.querySelectorAll('#adminGroupsBody .admin-actions-dropdown[data-row-menu]').forEach(dd => {
      dd.setAttribute('hidden', '');
      dd.previousElementSibling?.setAttribute('aria-expanded', 'false');
    });
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('#adminGroupsBody .admin-actions-menu')) closeAllGroupRowMenus();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllGroupRowMenus(); });
  // Entrée/Espace ouvrent la ligne — sauf si le focus/la cible est dans le
  // menu "⋯" (son propre bouton gère déjà l'activation clavier native).
  function groupRowKeydown(event, id) {
    if (event.target.closest('.admin-actions-menu')) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openGroupDetail(id); }
  }
  // "Modifier" depuis le menu de ligne : ouvre la fiche puis bascule en
  // édition — recompose deux fonctions déjà existantes, aucune nouvelle
  // logique métier.
  async function openGroupDetailAndEdit(id) {
    await openGroupDetail(id);
    toggleGroupEditMode();
  }
  function highlightSelectedGroupRow(id) {
    document.querySelectorAll('#adminGroupsBody tr[data-group-id]').forEach(row => {
      const selected = row.dataset.groupId === id;
      row.classList.toggle('admin-groups-row-selected', selected);
      if (selected) row.setAttribute('aria-selected', 'true'); else row.removeAttribute('aria-selected');
    });
  }
  function groupStatusBadge(s) {
    if (s === 'active') return `<span class="badge success">${t('Actif', 'نشط')}</span>`;
    if (s === 'suspended') return `<span class="badge warning">${t('Inactif', 'غير نشط')}</span>`;
    return `<span class="badge muted">${t('Archivé', 'مؤرشف')}</span>`;
  }
  function openGroupWizard() {
    showModal('➕ ' + t('Nouveau groupe', 'مجموعة جديدة'), `
      <div class="form-row"><div class="form-group"><label>${t('Code', 'الرمز')} *</label><input type="text" id="wizGroupCode" placeholder="ex: dhl"></div>
        <div class="form-group"><label>${t('Nom', 'الاسم')} *</label><input type="text" id="wizGroupName" placeholder="ex: DHL Forwarding"></div></div>
      <div class="form-row full"><div class="form-group"><label>${t('Description', 'الوصف')}</label><input type="text" id="wizGroupDescription"></div></div>
    `, async () => {
      try {
        await API.post('/admin/groups', {
          code: document.getElementById('wizGroupCode').value.trim(),
          name: document.getElementById('wizGroupName').value.trim(),
          description: document.getElementById('wizGroupDescription').value || undefined,
        });
        closeModal();
        notify(t('Groupe créé', 'تم إنشاء المجموعة'));
        if (currentTab === 'groups') await reloadGroups();
        else await showTab('groups');
      } catch (e) { notify(e.message || 'Erreur', 'error'); }
    }, t('Créer le groupe', 'إنشاء المجموعة'));
  }

  async function openGroupDetail(id, initialTab) {
    currentGroupId = id;
    groupInfoEditMode = false;
    const [group, sitesRes, availRes, usersRes] = await Promise.all([
      API.get('/admin/groups/' + id),
      API.get('/admin/groups/' + id + '/sites'),
      API.get('/admin/groups/' + id + '/sites/available'),
      API.get('/admin/groups/' + id + '/users'),
    ]);
    groupInfoCache = group;
    groupSiteById = new Map();
    sitesRes.sites.forEach(s => groupSiteById.set(s.id, s));
    availRes.sites.forEach(s => groupSiteById.set(s.id, s));
    groupOriginalAssignedIds = new Set(sitesRes.sites.map(s => s.id));
    groupAssignedIds = new Set(groupOriginalAssignedIds);
    groupAvailSelected = new Set();
    groupUsersCache = usersRes.users;

    const panel = document.getElementById('adminGroupDetail');
    if (!panel) return;
    panel.innerHTML = `
      <div class="admin-group-header">
        <div class="admin-group-header-main">
          <div class="admin-group-avatar" style="background:${groupAvatarColor(group.code)}">${escapeHtml(groupAvatarText(group.code))}</div>
          <div class="admin-group-header-text">
            <div class="admin-group-header-title-row">
              <span class="admin-group-name">${escapeHtml(group.name)}</span>
              ${groupStatusBadge(group.status)}
            </div>
            <div class="admin-group-header-meta">${t('Code', 'الرمز')} ${escapeHtml(group.code)} · ${t('Créé le', 'أُنشئ في')} ${fmtGroupDate(group.created_at)} · ${t('Modifié le', 'عُدّل في')} ${fmtGroupDate(group.updated_at)}</div>
          </div>
        </div>
        <div class="admin-group-header-actions">
          <button type="button" class="btn btn-outline btn-sm admin-groups-back-btn" onclick="AdminSystem.closeGroupDetail()">← ${t('Retour aux groupes', 'العودة إلى المجموعات')}</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="AdminSystem.toggleGroupEditMode()">${t('Modifier', 'تعديل')}</button>
          <div class="admin-actions-menu">
            <button type="button" class="btn btn-outline btn-sm" id="groupActionsMenuBtn" onclick="AdminSystem.toggleGroupActionsMenu()" aria-haspopup="true" aria-expanded="false">${t('Plus d’actions', 'مزيد من الإجراءات')} ▾</button>
            <div class="admin-actions-dropdown" id="groupActionsDropdown" hidden>
              ${group.status !== 'active' ? `<button type="button" onclick="AdminSystem.setGroupStatus('${group.id}','active')">${t('Activer', 'تفعيل')}</button>` : ''}
              ${group.status !== 'suspended' ? `<button type="button" onclick="AdminSystem.setGroupStatus('${group.id}','suspended')">${t('Désactiver', 'إلغاء التفعيل')}</button>` : ''}
              ${group.status !== 'archived' ? `<button type="button" class="admin-actions-dropdown-danger" onclick="AdminSystem.setGroupStatus('${group.id}','archived')">${t('Archiver', 'أرشفة')}</button>` : ''}
            </div>
          </div>
          <button type="button" class="btn-icon admin-groups-close-icon" onclick="AdminSystem.closeGroupDetail()" title="${t('Fermer', 'إغلاق')}" aria-label="${t('Fermer', 'إغلاق')}">✕</button>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <div class="tab active" role="tab" aria-selected="true" tabindex="0" data-tab="info" onclick="AdminSystem.switchGroupTab(this,'info')" onkeydown="AdminSystem.groupTabKeydown(event,this)">${t('Informations', 'معلومات')}</div>
        <div class="tab" role="tab" aria-selected="false" tabindex="-1" data-tab="sites" onclick="AdminSystem.switchGroupTab(this,'sites')" onkeydown="AdminSystem.groupTabKeydown(event,this)">${t('Sites', 'المواقع')} (${sitesRes.sites.length})</div>
        <div class="tab" role="tab" aria-selected="false" tabindex="-1" data-tab="users" onclick="AdminSystem.switchGroupTab(this,'users')" onkeydown="AdminSystem.groupTabKeydown(event,this)">${t('Utilisateurs', 'المستخدمون')} (${usersRes.users.length})</div>
        <div class="tab" role="tab" aria-selected="false" tabindex="-1" data-tab="permissions" onclick="AdminSystem.switchGroupTab(this,'permissions')" onkeydown="AdminSystem.groupTabKeydown(event,this)">${t('Permissions', 'الصلاحيات')}</div>
        <div class="tab" role="tab" aria-selected="false" tabindex="-1" data-tab="audit" onclick="AdminSystem.switchGroupTab(this,'audit')" onkeydown="AdminSystem.groupTabKeydown(event,this)">${t('Audit', 'التدقيق')}</div>
      </div>
      <div class="admin-group-tab-content">
        <div id="groupTab-info" role="tabpanel">${renderGroupInfoTab(group)}</div>
        <div id="groupTab-sites" role="tabpanel" style="display:none">${renderGroupSitesTabShell()}</div>
        <div id="groupTab-users" role="tabpanel" style="display:none">${renderGroupUsersTabShell()}</div>
        <div id="groupTab-permissions" role="tabpanel" style="display:none"></div>
        <div id="groupTab-audit" role="tabpanel" style="display:none"><div id="groupAuditBody2"><div class="empty-state">${t('Chargement…', 'جارٍ التحميل…')}</div></div></div>
      </div>`;
    renderGroupSitesPanels();
    renderGroupUsersTable();
    if (initialTab && initialTab !== 'info') {
      const tabEl = panel.querySelector(`.tab[data-tab="${initialTab}"]`);
      if (tabEl) switchGroupTab(tabEl, initialTab);
    }
    highlightSelectedGroupRow(id);
    document.getElementById('adminGroupsLayout')?.classList.add('admin-groups-showing-detail');
    panel.scrollIntoView({ block: 'nearest' });
  }
  // Ferme la fiche (icône "Fermer" desktop, discrète, ET "← Retour aux
  // groupes" mobile, cf. .admin-groups-back-btn) : ré-affiche l'empty-
  // state, retire la surbrillance de sélection, et — sur mobile —
  // réaffiche la liste.
  function closeGroupDetail() {
    currentGroupId = null;
    groupInfoEditMode = false;
    const panel = document.getElementById('adminGroupDetail');
    if (panel) panel.innerHTML = groupDetailEmptyStateHtml();
    document.querySelectorAll('#adminGroupsBody tr[data-group-id]').forEach(row => { row.classList.remove('admin-groups-row-selected'); row.removeAttribute('aria-selected'); });
    document.getElementById('adminGroupsLayout')?.classList.remove('admin-groups-showing-detail');
  }
  function switchGroupTab(el, name) {
    el.parentElement.querySelectorAll('.tab').forEach(x => {
      x.classList.remove('active');
      x.setAttribute('aria-selected', 'false');
      x.tabIndex = -1;
    });
    el.classList.add('active');
    el.setAttribute('aria-selected', 'true');
    el.tabIndex = 0;
    ['info', 'sites', 'users', 'permissions', 'audit'].forEach(id => {
      const n = document.getElementById('groupTab-' + id);
      if (n) n.style.display = id === name ? 'block' : 'none';
    });
    if (name === 'permissions') { const n = document.getElementById('groupTab-permissions'); if (n) n.innerHTML = renderGroupPermissionsTab(); }
    if (name === 'audit') loadGroupAudit();
  }
  // Navigation clavier WAI-ARIA (pattern "tabs") : Flèches/Home/End
  // déplacent le focus ET activent l'onglet ciblé ; Entrée/Espace activent
  // l'onglet courant — les onglets Groupes n'étaient auparavant accessibles
  // qu'à la souris (div sans tabindex ni rôle), comme le reste de
  // l'application ; corrigé seulement ici, périmètre ciblé de ce correctif.
  function groupTabKeydown(event, el) {
    const tabs = [...el.parentElement.querySelectorAll('.tab')];
    const idx = tabs.indexOf(el);
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); switchGroupTab(el, el.dataset.tab); return; }
    let nextIdx = null;
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = tabs.length - 1;
    if (nextIdx !== null) {
      event.preventDefault();
      const nextEl = tabs[nextIdx];
      switchGroupTab(nextEl, nextEl.dataset.tab);
      nextEl.focus();
    }
  }

  // Consultation par défaut (aucun input tant que l'utilisateur ne
  // modifie rien) — "Modifier" (header de la fiche) bascule vers l'édition ;
  // "Enregistrer"/"Annuler" ne vivent que dans ce mode, jamais dupliqués
  // avec Activer/Désactiver/Archiver (déjà séparés dans "Plus d'actions").
  function renderGroupInfoTab(g) {
    if (!groupInfoEditMode) {
      return `
        <div class="admin-group-info-grid">
          <div class="admin-group-info-item"><span class="admin-group-info-label">${t('Code', 'الرمز')}</span><span class="admin-group-info-value">${escapeHtml(g.code)}</span></div>
          <div class="admin-group-info-item"><span class="admin-group-info-label">${t('Nom', 'الاسم')}</span><span class="admin-group-info-value">${escapeHtml(g.name)}</span></div>
          <div class="admin-group-info-item full"><span class="admin-group-info-label">${t('Description', 'الوصف')}</span><span class="admin-group-info-value">${escapeHtml(g.description || '—')}</span></div>
          <div class="admin-group-info-item"><span class="admin-group-info-label">${t('Statut', 'الحالة')}</span><span class="admin-group-info-value">${groupStatusBadge(g.status)}</span></div>
          <div class="admin-group-info-item"><span class="admin-group-info-label">${t('Créé le', 'أُنشئ في')}</span><span class="admin-group-info-value">${g.created_at ? new Date(g.created_at).toLocaleString(lang() === 'ar' ? 'ar' : 'fr-FR') : '—'}</span></div>
          <div class="admin-group-info-item"><span class="admin-group-info-label">${t('Modifié le', 'عُدّل في')}</span><span class="admin-group-info-value">${g.updated_at ? new Date(g.updated_at).toLocaleString(lang() === 'ar' ? 'ar' : 'fr-FR') : '—'}</span></div>
        </div>`;
    }
    return `
      <div class="form-row"><div class="form-group"><label>${t('Code', 'الرمز')}</label><input type="text" value="${escapeHtml(g.code)}" disabled></div>
        <div class="form-group"><label>${t('Nom', 'الاسم')}</label><input type="text" id="groupEditName" value="${escapeHtml(g.name)}"></div></div>
      <div class="form-row full"><div class="form-group"><label>${t('Description', 'الوصف')}</label><input type="text" id="groupEditDescription" value="${escapeHtml(g.description || '')}"></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="btn btn-primary" onclick="AdminSystem.saveGroupInfo('${g.id}')">${t('Enregistrer', 'حفظ')}</button>
        <button type="button" class="btn btn-outline" onclick="AdminSystem.cancelGroupInfoEdit()">${t('Annuler', 'إلغاء')}</button>
      </div>`;
  }
  // Déclenché par le bouton "Modifier" du header de fiche (visible depuis
  // n'importe quel onglet) : bascule sur Informations puis passe en édition.
  function toggleGroupEditMode() {
    groupInfoEditMode = true;
    const infoTabEl = document.querySelector('#adminGroupDetail .tab[data-tab="info"]');
    if (infoTabEl) switchGroupTab(infoTabEl, 'info');
    const n = document.getElementById('groupTab-info');
    if (n && groupInfoCache) n.innerHTML = renderGroupInfoTab(groupInfoCache);
  }
  function cancelGroupInfoEdit() {
    groupInfoEditMode = false;
    const n = document.getElementById('groupTab-info');
    if (n && groupInfoCache) n.innerHTML = renderGroupInfoTab(groupInfoCache);
  }
  async function saveGroupInfo(id) {
    try {
      await API.put('/admin/groups/' + id, {
        name: document.getElementById('groupEditName').value,
        description: document.getElementById('groupEditDescription').value,
      });
      groupInfoEditMode = false;
      notify(t('Groupe mis à jour', 'تم تحديث المجموعة'));
      await reloadGroups();
      await openGroupDetail(id, 'info');
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }
  async function setGroupStatus(id, status) {
    closeGroupActionsMenu();
    const reason = status !== 'active' ? prompt(t('Motif (optionnel) :', 'السبب (اختياري):')) : null;
    try {
      await API.put('/admin/groups/' + id + '/status', { status, reason: reason || undefined });
      notify(t('Statut mis à jour', 'تم تحديث الحالة'));
      await reloadGroups();
      await openGroupDetail(id, 'info');
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }

  // Onglet Sites — double panneau "Sites disponibles / Sites du groupe".
  // §11 mission : sélection LOCALE (groupAssignedIds) — aucune persistance
  // avant saveGroupSites(). Un site provenant d'AUTRES groupes reste
  // marqué non déplaçable (movable:false, backend/site-dependencies.js)
  // quand des données réelles y sont rattachées ; la case est alors
  // désactivée plutôt que de laisser découvrir le refus après coup.
  function renderGroupSitesTabShell() {
    return `
      <div class="admin-groups-sites-banner">
        <span>ⓘ</span>
        <span>${t('Sélectionnez les sites qui font partie de ce groupe. Les utilisateurs du groupe auront accès à ces sites selon leurs permissions.', 'اختر المواقع التي تنتمي إلى هذه المجموعة. سيتمكن مستخدمو المجموعة من الوصول إلى هذه المواقع وفق صلاحياتهم.')}</span>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:280px">
          <div class="admin-groups-sites-panel-header">
            <span class="admin-groups-sites-panel-title">${t('Sites disponibles', 'المواقع المتاحة')} (<span id="groupAvailCount">0</span>)</span>
          </div>
          <div class="search-box"><input type="text" id="groupSiteAvailSearch" placeholder="${t('Rechercher un site…', 'ابحث عن موقع…')}" oninput="AdminSystem.renderGroupSitesPanels()"></div>
          <div class="table-wrap" style="max-height:360px;overflow:auto;margin-top:8px"><table><thead><tr>
            <th></th><th>${t('Code', 'الرمز')}</th><th>${t('Nom', 'الاسم')}</th><th>${t('Groupe actuel', 'المجموعة الحالية')}</th><th>${t('Statut', 'الحالة')}</th>
          </tr></thead><tbody id="groupAvailBody"></tbody></table></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button type="button" class="btn btn-outline btn-sm" onclick="AdminSystem.addSelectedGroupSites()">${t('Ajouter →', 'إضافة ←')}</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="AdminSystem.addAllGroupSites()">${t('Tout ajouter →', 'إضافة الكل ←')}</button>
          </div>
        </div>
        <div style="flex:1;min-width:280px">
          <div class="admin-groups-sites-panel-header">
            <span class="admin-groups-sites-panel-title">${t('Sites du groupe', 'مواقع المجموعة')} (<span id="groupAssignedCount">0</span>)</span>
            <button type="button" class="btn btn-outline btn-sm" onclick="AdminSystem.removeAllGroupSites()">${t('Tout retirer', 'إزالة الكل')}</button>
          </div>
          <div class="table-wrap" style="max-height:360px;overflow:auto"><table><thead><tr>
            <th>${t('Code', 'الرمز')}</th><th>${t('Nom', 'الاسم')}</th><th>${t('Statut', 'الحالة')}</th><th></th>
          </tr></thead><tbody id="groupAssignedBody"></tbody></table></div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button type="button" class="btn btn-outline" onclick="AdminSystem.cancelGroupSitesChanges()">${t('Annuler', 'إلغاء')}</button>
        <button type="button" class="btn btn-primary" onclick="AdminSystem.saveGroupSites()">${t('Enregistrer les modifications', 'حفظ التغييرات')}</button>
      </div>`;
  }
  function renderGroupSitesPanels() {
    const availBody = document.getElementById('groupAvailBody');
    const assignedBody = document.getElementById('groupAssignedBody');
    if (!availBody || !assignedBody) return;
    const search = (document.getElementById('groupSiteAvailSearch')?.value || '').toLowerCase();
    const matches = s => !search || s.code.toLowerCase().includes(search) || s.name.toLowerCase().includes(search) || (s.current_group_name || '').toLowerCase().includes(search);
    const availSites = [...groupSiteById.keys()].filter(id => !groupAssignedIds.has(id)).map(id => groupSiteById.get(id)).filter(matches).sort((a, b) => a.name.localeCompare(b.name));
    document.getElementById('groupAvailCount').textContent = [...groupSiteById.keys()].filter(id => !groupAssignedIds.has(id)).length;
    availBody.innerHTML = availSites.map(s => `
      <tr>
        <td><input type="checkbox" class="group-avail-check" data-id="${s.id}" ${groupAvailSelected.has(s.id) ? 'checked' : ''} ${s.movable === false ? 'disabled' : ''} onchange="AdminSystem.toggleGroupAvailSelected('${s.id}', this.checked)" aria-label="${escapeHtml(s.name)}"></td>
        <td>${escapeHtml(s.code)}</td>
        <td>${escapeHtml(s.name)}${s.movable === false ? ` <span class="badge warning" title="${escapeHtml(t('Non déplaçable : des données réelles y sont rattachées', 'غير قابل للنقل: توجد بيانات حقيقية مرتبطة به'))}">⚠</span>` : ''}</td>
        <td>${escapeHtml(s.current_group_name || '—')}</td>
        <td>${statusBadge(s.status)}</td>
      </tr>`).join('') || `<tr><td colspan="5" class="empty-state">${t('Aucun site disponible', 'لا يوجد موقع متاح')}</td></tr>`;

    const assignedSites = [...groupAssignedIds].map(id => groupSiteById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    document.getElementById('groupAssignedCount').textContent = assignedSites.length;
    assignedBody.innerHTML = assignedSites.map(s => `
      <tr>
        <td>${escapeHtml(s.code)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${statusBadge(s.status)}</td>
        <td><button type="button" class="admin-groups-icon-btn" onclick="AdminSystem.removeGroupSite('${s.id}')" title="${t('Retirer', 'إزالة')}" aria-label="${escapeHtml(t('Retirer', 'إزالة') + ' ' + s.name)}">🗑</button></td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty-state">${t('Aucun site dans ce groupe', 'لا يوجد موقع في هذه المجموعة')}</td></tr>`;
  }
  function toggleGroupAvailSelected(id, checked) { if (checked) groupAvailSelected.add(id); else groupAvailSelected.delete(id); }
  function addSelectedGroupSites() {
    if (!groupAvailSelected.size) { notify(t('Sélectionnez au moins un site', 'اختر موقعًا واحدًا على الأقل'), 'error'); return; }
    groupAvailSelected.forEach(id => groupAssignedIds.add(id));
    groupAvailSelected = new Set();
    renderGroupSitesPanels();
  }
  function addAllGroupSites() {
    const search = (document.getElementById('groupSiteAvailSearch')?.value || '').toLowerCase();
    const matches = s => !search || s.code.toLowerCase().includes(search) || s.name.toLowerCase().includes(search) || (s.current_group_name || '').toLowerCase().includes(search);
    [...groupSiteById.keys()].filter(id => !groupAssignedIds.has(id)).forEach(id => {
      const s = groupSiteById.get(id);
      if (s.movable === false || !matches(s)) return;
      groupAssignedIds.add(id);
    });
    groupAvailSelected = new Set();
    renderGroupSitesPanels();
  }
  // §12 mission : avertissement AVANT confirmation, avec le nombre réel
  // d'utilisateurs restreints concernés. Le retrait réel reste appliqué
  // localement puis arbitré par saveGroupSites() → le serveur (immuabilité
  // des appartenances, voir backend/admin-groups.js en-tête) : aucune
  // suppression automatique d'accès n'est fabriquée ici, le message le dit.
  function affectedRestrictedUsers(siteId) { return groupUsersCache.filter(u => !u.all_sites && u.site_ids.includes(siteId)).length; }
  function removeGroupSite(id) {
    const affected = affectedRestrictedUsers(id);
    const doRemove = () => { groupAssignedIds.delete(id); renderGroupSitesPanels(); };
    if (affected > 0) {
      showModal('⚠ ' + t('Retirer ce site ?', 'إزالة هذا الموقع؟'), `
        <p>${escapeHtml(t(`Ce site est actuellement accessible à ${affected} utilisateur(s) restreint(s) du groupe.`, `هذا الموقع متاح حاليًا لـ ${affected} مستخدم مقيّد في المجموعة.`))}</p>
        <p class="mc-detail-note">${escapeHtml(t("Le retrait effectif sera refusé par le serveur tant que ces accès existent (les appartenances ne sont jamais supprimées automatiquement) — retirez d'abord ces utilisateurs du site ou du groupe, puis réessayez.", 'سيُرفض الحذف الفعلي من الخادم ما دامت هذه الصلاحيات موجودة (لا تُحذف العضويات تلقائيًا أبدًا) — أزل هؤلاء المستخدمين من الموقع أو من المجموعة أولاً، ثم أعد المحاولة.'))}</p>
      `, async () => { closeModal(); doRemove(); }, t('Retirer quand même (local)', 'إزالة على أي حال (محليًا)'));
    } else doRemove();
  }
  function removeAllGroupSites() {
    const ids = [...groupAssignedIds];
    const total = ids.reduce((sum, id) => sum + affectedRestrictedUsers(id), 0);
    const doRemove = () => { groupAssignedIds = new Set(); renderGroupSitesPanels(); };
    if (total > 0) {
      showModal('⚠ ' + t('Tout retirer ?', 'إزالة الكل؟'), `<p>${escapeHtml(t(`${total} accès utilisateur(s) restreint(s) seront concernés par ce retrait.`, `سيتأثر ${total} من صلاحيات المستخدمين المقيّدين بهذه الإزالة.`))}</p>`,
        async () => { closeModal(); doRemove(); }, t('Retirer quand même (local)', 'إزالة على أي حال (محليًا)'));
    } else doRemove();
  }
  async function saveGroupSites() {
    const add = [...groupAssignedIds].filter(id => !groupOriginalAssignedIds.has(id));
    const remove = [...groupOriginalAssignedIds].filter(id => !groupAssignedIds.has(id));
    if (!add.length && !remove.length) { notify(t('Aucune modification à enregistrer', 'لا تغيير لحفظه'), 'error'); return; }
    try {
      await API.put('/admin/groups/' + currentGroupId + '/sites', { add, remove });
      notify(t('Modifications enregistrées', 'تم حفظ التغييرات'));
      await reloadGroups();
      await openGroupDetail(currentGroupId, 'sites');
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }
  function cancelGroupSitesChanges() {
    groupAssignedIds = new Set(groupOriginalAssignedIds);
    groupAvailSelected = new Set();
    renderGroupSitesPanels();
  }

  // Onglet Utilisateurs — affecter un compte existant, jamais en créer un.
  function renderGroupUsersTabShell() {
    return `
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button type="button" class="btn btn-primary" onclick="AdminSystem.openAssignGroupUserModal()">+ ${t('Affecter un utilisateur', 'تعيين مستخدم')}</button>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>${t('Identifiant', 'المعرف')}</th><th>${t('Nom', 'الاسم')}</th><th>${t('Rôle', 'الدور')}</th><th>${t('Sites autorisés', 'المواقع المصرح بها')}</th><th>${t('Statut', 'الحالة')}</th><th>${t('Actions', 'إجراءات')}</th>
      </tr></thead><tbody id="groupUsersBody"></tbody></table></div>`;
  }
  function renderGroupUsersTable() {
    const body = document.getElementById('groupUsersBody');
    if (!body) return;
    if (!groupUsersCache.length) { body.innerHTML = `<tr><td colspan="6" class="empty-state">${t('Aucun utilisateur affecté', 'لا يوجد مستخدم معيّن')}</td></tr>`; return; }
    body.innerHTML = groupUsersCache.map(u => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.nom_complet || '—')}</td>
        <td>${escapeHtml(roleLabel(u.role))}</td>
        <td>${u.all_sites ? `<span class="badge info">${t('Tous les sites du groupe', 'جميع مواقع المجموعة')}</span>` : (u.site_names.filter(Boolean).map(n => escapeHtml(n)).join(', ') || '—')}</td>
        <td><span class="badge success">${t('Actif', 'نشط')}</span></td>
        <td><button type="button" class="btn btn-sm btn-danger" onclick="AdminSystem.confirmRemoveGroupUser(${u.user_id},'${escapeHtml(u.username).replace(/'/g, "\\'")}')">${t('Retirer du groupe', 'إزالة من المجموعة')}</button></td>
      </tr>`).join('');
  }
  function confirmRemoveGroupUser(userId, username) {
    showModal('🗑 ' + t('Retirer cet utilisateur du groupe', 'إزالة هذا المستخدم من المجموعة'), `
      <p>${escapeHtml(t(`Retirer ${username} du groupe ? Toutes ses appartenances actives sur ce groupe seront archivées (jamais supprimées — traçabilité conservée).`, `إزالة ${username} من المجموعة؟ سيتم أرشفة جميع عضوياته النشطة في هذه المجموعة (لا يُحذف شيء أبدًا — يُحتفظ بالتتبع).`))}</p>
    `, async () => {
      try {
        await API.del('/admin/groups/' + currentGroupId + '/users/' + userId);
        closeModal();
        notify(t('Utilisateur retiré du groupe', 'تمت إزالة المستخدم من المجموعة'));
        const usersRes = await API.get('/admin/groups/' + currentGroupId + '/users');
        groupUsersCache = usersRes.users;
        renderGroupUsersTable();
        await reloadGroups();
      } catch (e) { notify(e.message || 'Erreur', 'error'); }
    }, t('Retirer', 'إزالة'));
  }
  // Le sélecteur de sites ne propose QUE les sites RÉELLEMENT persistés de
  // CE groupe (groupOriginalAssignedIds) — jamais les sites d'un autre
  // groupe (ex: FIAT/Schneider quand on affecte un utilisateur DHL) : cette
  // contrainte est structurelle ici (aucun champ groupe à choisir, la
  // fiche EST déjà le groupe), pas seulement un filtre visuel contournable.
  async function openAssignGroupUserModal() {
    let allUsers = [];
    try { allUsers = await API.get('/admin/users'); } catch (e) { notify(e.message || 'Erreur', 'error'); return; }
    const groupSites = [...groupOriginalAssignedIds].map(id => groupSiteById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const roleOptions = MEMBERSHIP_ROLES.map(r => `<option value="${r}">${escapeHtml(roleLabel(r))}</option>`).join('');
    const userOptions = allUsers.map(u => `<option value="${u.id}">${escapeHtml(u.username)}${u.nom_complet ? ' — ' + escapeHtml(u.nom_complet) : ''}</option>`).join('');
    showModal('➕ ' + t('Affecter un utilisateur', 'تعيين مستخدم'), `
      <div class="form-group"><label>${t('Groupe', 'المجموعة')} *</label><input type="text" value="${escapeHtml(groupInfoCache?.name || '')}" disabled></div>
      <div class="form-row"><div class="form-group"><label>${t('Utilisateur', 'المستخدم')} *</label><select id="assignUserSelect">${userOptions}</select></div>
        <div class="form-group"><label>${t('Rôle', 'الدور')} *</label><select id="assignUserRole">${roleOptions}</select></div></div>
      <div class="form-group"><label><input type="checkbox" id="assignUserAllSites" checked onchange="document.getElementById('assignUserSitesBox').style.display=this.checked?'none':'block'"> ${t('Tous les sites du groupe', 'جميع مواقع المجموعة')}</label></div>
      <div id="assignUserSitesBox" style="display:none">
        ${groupSites.length ? groupSites.map(s => `<label style="display:block"><input type="checkbox" class="assign-user-site" value="${s.id}"> ${escapeHtml(s.name)} <span class="muted">(${escapeHtml(s.code)})</span></label>`).join('') : `<p class="empty-state">${t('Ce groupe ne contient encore aucun site', 'لا تحتوي هذه المجموعة على أي موقع بعد')}</p>`}
      </div>
    `, async () => {
      const userId = parseInt(document.getElementById('assignUserSelect').value, 10);
      const role = document.getElementById('assignUserRole').value;
      const allSites = document.getElementById('assignUserAllSites').checked;
      const siteIds = [...document.querySelectorAll('.assign-user-site:checked')].map(c => c.value);
      if (!allSites && !siteIds.length) { notify(t('Sélectionnez au moins un site ou « Tous les sites »', 'اختر موقعًا واحدًا على الأقل أو «جميع المواقع»'), 'error'); return; }
      try {
        await API.post('/admin/groups/' + currentGroupId + '/users', { user_id: userId, role, all_sites: allSites, site_ids: siteIds });
        closeModal();
        notify(t('Utilisateur affecté', 'تم تعيين المستخدم'));
        const usersRes = await API.get('/admin/groups/' + currentGroupId + '/users');
        groupUsersCache = usersRes.users;
        renderGroupUsersTable();
        await reloadGroups();
      } catch (e) { notify(e.message || 'Erreur', 'error'); }
    }, t('Affecter', 'تعيين'));
  }

  // Onglet Permissions — périmètre (ici) séparé du rôle/permissions
  // (référentiel unique déjà construit : onglet Rôles & permissions,
  // jamais une seconde matrice RBAC recréée dans ce lot).
  function renderGroupPermissionsTab() {
    const rows = groupUsersCache.map(u => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(groupInfoCache?.name || '')} → ${u.all_sites ? t('Tous les sites', 'جميع المواقع') : (u.site_names.filter(Boolean).join(', ') || '—')}</td>
        <td>${escapeHtml(roleLabel(u.role))}</td>
      </tr>`).join('') || `<tr><td colspan="3" class="empty-state">${t('Aucun utilisateur affecté', 'لا يوجد مستخدم معيّن')}</td></tr>`;
    return `
      <p class="mc-detail-note">${escapeHtml(t('Périmètre (groupe/sites) et autorisation fonctionnelle (rôle/permissions) restent deux dimensions séparées — la matrice complète des permissions par rôle est dans l’onglet Rôles & permissions (référentiel unique, non dupliqué ici).', 'يبقى النطاق (المجموعة/المواقع) والتفويض الوظيفي (الدور/الصلاحيات) بُعدين منفصلين — المصفوفة الكاملة للصلاحيات حسب الدور موجودة في تبويب الأدوار والصلاحيات (مرجع واحد، غير مكرر هنا).'))}</p>
      <div class="table-wrap"><table><thead><tr><th>${t('Utilisateur', 'المستخدم')}</th><th>${t('Périmètre', 'النطاق')}</th><th>${t('Rôle', 'الدور')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button type="button" class="btn btn-outline" style="margin-top:8px" onclick="AdminSystem.showTab('roles')">${t('Voir Rôles & permissions', 'عرض الأدوار والصلاحيات')}</button>`;
  }

  // Onglet Audit — réutilise security_audit via GET /admin/groups/:id/audit
  // (déjà filtré côté serveur sur ce tenant), jamais un journal parallèle.
  async function loadGroupAudit() {
    const box = document.getElementById('groupAuditBody2');
    if (!box) return;
    box.innerHTML = `<div class="empty-state">${t('Chargement…', 'جارٍ التحميل…')}</div>`;
    try {
      const { events } = await API.get('/admin/groups/' + currentGroupId + '/audit?limit=100');
      box.innerHTML = `<div class="table-wrap"><table><thead><tr>
        <th>${t('Date', 'التاريخ')}</th><th>${t('Acteur', 'الفاعل')}</th><th>${t('Action', 'الإجراء')}</th><th>${t('Objet', 'الكائن')}</th><th>${t('Résultat', 'النتيجة')}</th>
      </tr></thead><tbody>${events.map(r => `
        <tr><td>${new Date(r.created_at).toLocaleString(lang() === 'ar' ? 'ar' : 'fr-FR')}</td>
          <td>${escapeHtml(r.actor_username || '—')}</td>
          <td>${escapeHtml(r.event_type)}</td>
          <td>${escapeHtml(r.resource_type)}${r.resource_id ? ' #' + escapeHtml(String(r.resource_id)).slice(0, 8) : ''}</td>
          <td>${r.outcome === 'success' ? `<span class="badge success">${t('succès', 'نجاح')}</span>` : r.outcome === 'denied' ? `<span class="badge warning">${t('refusé', 'مرفوض')}</span>` : `<span class="badge danger">${t('échec', 'فشل')}</span>`}</td></tr>`).join('')
        || `<tr><td colspan="5" class="empty-state">${t('Aucun événement (ou compte sans appartenance soc sur ce groupe — la lecture est restreinte par tenant)', 'لا يوجد حدث (أو حساب بدون عضوية soc في هذه المجموعة — القراءة مقيدة حسب المجموعة)')}</td></tr>`}</tbody></table></div>`;
    } catch (e) { box.innerHTML = `<p class="mc-wf-error">${escapeHtml(e.message || String(e))}</p>`; }
  }

  /* ============================================================ */
  /*  Zones & postes (lecture réelle par site — pas de CRUD V1)      */
  /* ============================================================ */
  async function renderZones(el) {
    if (!sitesCache.length) { const d = await API.get('/admin/sites?limit=100'); sitesCache = d.sites; }
    if (!zonesSiteId && sitesCache.length) zonesSiteId = sitesCache[0].id;
    el.innerHTML = `
      <div class="card"><div class="card-header"><div class="card-title">📍 Zones & postes</div></div>
        <div class="card-body">
          <div class="form-group" style="max-width:320px"><label>Site</label>
            <select id="zonesAdminSite" onchange="AdminSystem.reloadZones(this.value)">
              ${sitesCache.map(s => `<option value="${s.id}" ${s.id === zonesSiteId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div id="zonesAdminBody"><div class="empty-state">Chargement…</div></div>
          <p class="mc-detail-note">CRUD zones/postes complet (création/modification/archivage) prévu au LOT 6/7 — non livré dans ce lot. Les postes se créent aujourd'hui depuis Main courante → Configuration du site.</p>
        </div></div>`;
    if (zonesSiteId) await reloadZones(zonesSiteId);
  }
  async function reloadZones(siteId) {
    zonesSiteId = siteId;
    const body = document.getElementById('zonesAdminBody');
    try {
      const [{ zones }, catalog] = await Promise.all([
        API.get('/admin/zones?site_id=' + siteId),
        API.get('/maincourante/admin/catalog?site_id=' + siteId).catch(() => ({ posts: [] })),
      ]);
      body.innerHTML = `
        <h4>Zones (${zones.length})</h4>
        <table><thead><tr><th>Nom</th><th>Code</th><th>Statut</th></tr></thead><tbody>
          ${zones.map(z => `<tr><td>${escapeHtml(z.name)}</td><td>${escapeHtml(z.code)}</td><td>${z.status === 'active' ? '<span class="badge success">Active</span>' : '<span class="badge muted">Archivée</span>'}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">Aucune zone</td></tr>'}
        </tbody></table>
        <h4 style="margin-top:16px">Postes (${catalog.posts.length})</h4>
        <table><thead><tr><th>Nom</th><th>Statut</th></tr></thead><tbody>
          ${catalog.posts.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.status)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty-state">Aucun poste</td></tr>'}
        </tbody></table>`;
    } catch (e) {
      body.innerHTML = `<p class="mc-wf-error">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  /* ============================================================ */
  /*  Utilisateurs (actif/bloqué — enrichit /admin/users existant)  */
  /* ============================================================ */
  async function renderUsers(el) {
    el.innerHTML = `<div class="card"><div class="card-header"><div class="card-title">🛡️ Comptes applicatifs</div>
      <button class="btn btn-primary" onclick="AdminSystem.openCreateUserModal()">+ Créer un utilisateur</button></div>
      <p class="mc-detail-note" style="margin:0 16px 12px">🚨 <strong>Destinataire SOS</strong> : un compte coché reçoit réellement l'alarme (son + popup plein écran) dès qu'un bouton SOS est déclenché, où que ce soit — indépendamment de son groupe ou de ses sites.</p>
      <div class="card-body" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Identifiant</th><th>Nom</th><th>Rôle</th><th>Statut</th><th>🚨 Destinataire SOS</th><th>Actions</th></tr></thead><tbody id="adminUsersBody"></tbody></table></div></div></div>`;
    await reloadUsers();
  }
  async function reloadUsers() {
    const users = await API.get('/admin/users');
    const body = document.getElementById('adminUsersBody');
    body.innerHTML = users.map(u => `
      <tr>
        <td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.nom_complet || '—')}</td><td>${escapeHtml(u.role)}</td>
        <td>${u.status === 'blocked' ? '<span class="badge danger">Bloqué</span>' : '<span class="badge success">Actif</span>'}</td>
        <td style="text-align:center">
          <input type="checkbox" ${u.sos_recipient ? 'checked' : ''}
            aria-label="Destinataire SOS — ${escapeHtml(u.username)}"
            onchange="AdminSystem.setUserSosRecipient(${u.id}, this.checked)">
        </td>
        <td>${u.status === 'blocked'
          ? `<button class="btn btn-sm btn-success" onclick="AdminSystem.setUserStatus(${u.id},'active')">Débloquer</button>`
          : `<button class="btn btn-sm btn-danger" onclick="AdminSystem.setUserStatus(${u.id},'blocked')">Bloquer</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty-state">Aucun utilisateur</td></tr>';
  }
  async function setUserSosRecipient(id, enabled) {
    try { await API.put('/admin/users/' + id + '/sos-recipient', { sos_recipient: enabled }); notify(enabled ? 'Destinataire SOS activé' : 'Destinataire SOS désactivé'); await reloadUsers(); }
    catch (e) { notify(e.message || 'Erreur', 'error'); await reloadUsers(); }
  }
  async function setUserStatus(id, status) {
    try { await API.put('/admin/users/' + id + '/status', { status }); notify('Statut mis à jour'); await reloadUsers(); }
    catch (e) { notify(e.message || 'Erreur', 'error'); }
  }
  function openCreateUserModal() {
    showModal('🛡️ Créer un utilisateur', `
      <div class="form-row"><div class="form-group"><label>Identifiant *</label><input type="text" id="newUserUsername"></div>
        <div class="form-group"><label>Rôle</label><select id="newUserRole"><option value="agent">Agent</option><option value="admin">Administrateur</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Nom complet</label><input type="text" id="newUserName"></div>
        <div class="form-group"><label>Mot de passe *</label><input type="password" id="newUserPassword"></div></div>
    `, async () => {
      try {
        await API.post('/admin/users', {
          username: document.getElementById('newUserUsername').value.trim(),
          role: document.getElementById('newUserRole').value,
          nom_complet: document.getElementById('newUserName').value || undefined,
          password: document.getElementById('newUserPassword').value,
        });
        closeModal();
        notify('Utilisateur créé');
        if (currentTab === 'users') await reloadUsers();
      } catch (e) { notify(e.message || 'Erreur', 'error'); }
    }, 'Créer');
  }

  /* ============================================================ */
  /*  Rôles & permissions (référentiel statique, lecture seule)     */
  /* ============================================================ */
  async function renderRoles(el) {
    const data = await API.get('/admin/roles');
    const modules = data.modules;
    const rows = Object.entries(data.roles).filter(([, r]) => !r.global).map(([key, r]) => {
      const cells = modules.map(m => {
        const verbs = (data.permissions[m] || {})[key];
        return `<td>${verbs ? verbs.map(v => `<span class="badge muted">${v}</span>`).join(' ') : '—'}</td>`;
      }).join('');
      return `<tr><td><strong>${escapeHtml(r.label)}</strong></td>${cells}</tr>`;
    }).join('');
    el.innerHTML = `
      <div class="card"><div class="card-body">
        <p class="mc-detail-note">Administrateur global (users.role='admin') : accès complet à tous les modules — exception explicite, jamais dérivée de cette matrice. Référentiel statique (backend/permissions.js) ; l'assignation d'un rôle à un utilisateur pour un site se fait via les appartenances (memberships), pas encore exposée dans cet écran V1.</p>
      </div></div>
      <div class="card"><div class="card-body" style="padding:0"><div class="table-wrap">
        <table><thead><tr><th>Rôle</th>${modules.map(m => `<th>${escapeHtml(m)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
      </div></div></div>`;
  }

  /* ============================================================ */
  /*  Main courante — Administration (réutilise le moteur existant) */
  /* ============================================================ */
  async function renderMainCourante(el) {
    if (!sitesCache.length) { const d = await API.get('/admin/sites?limit=100'); sitesCache = d.sites; }
    if (!mcSiteId && sitesCache.length) mcSiteId = sitesCache[0].id;
    el.innerHTML = `
      <div class="card"><div class="card-header"><div class="card-title">📓 Main courante — Configuration du site</div></div>
        <div class="card-body">
          <div class="form-group" style="max-width:320px"><label>Site</label>
            <select id="mcAdminSite" onchange="AdminSystem.reloadMcAdmin(this.value)">
              ${sitesCache.map(s => `<option value="${s.id}" ${s.id === mcSiteId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div id="mcAdminBody"><div class="empty-state">Chargement…</div></div>
        </div>
      </div>`;
    if (mcSiteId) await reloadMcAdmin(mcSiteId);
  }
  async function reloadMcAdmin(siteId) {
    mcSiteId = siteId;
    const body = document.getElementById('mcAdminBody');
    try {
      const catalog = await API.get('/maincourante/admin/catalog?site_id=' + siteId);
      body.innerHTML = `
        <h4>Postes (${catalog.posts.length})</h4>
        <table><thead><tr><th>Nom</th><th>Statut</th></tr></thead><tbody>${catalog.posts.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.status)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty-state">Aucun</td></tr>'}</tbody></table>
        <h4 style="margin-top:16px">Circuits de ronde (${catalog.circuits.length})</h4>
        <table><thead><tr><th>Nom</th><th>Checkpoints</th></tr></thead><tbody>${catalog.circuits.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${c.checkpoint_count}</td></tr>`).join('') || '<tr><td colspan="2" class="empty-state">Aucun</td></tr>'}</tbody></table>
        <h4 style="margin-top:16px">Équipement (${catalog.equipment.length})</h4>
        <table><thead><tr><th>Nom</th><th>Référence</th><th>État</th></tr></thead><tbody>${catalog.equipment.map(e => `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.reference)}</td><td>${escapeHtml(e.state)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">Aucun</td></tr>'}</tbody></table>
        <h4 style="margin-top:16px">PCS01</h4>
        <p>${catalog.pcs01.enabled ? '<span class="badge success">Activé</span>' : '<span class="badge muted">Désactivé</span>'} — codes : ${(catalog.pcs01.codes || []).join(', ') || '—'}</p>
        <p class="mc-detail-note">Gestion complète (créer poste/équipement/circuit, activer PCS01) déjà disponible depuis Main courante → Configuration du site.</p>`;
    } catch (e) {
      body.innerHTML = `<p class="mc-wf-error">${escapeHtml(t('Droits insuffisants ou site invalide : ', 'صلاحيات غير كافية أو موقع غير صالح: ') + (e.message || e))}</p>`;
    }
  }

  /* ============================================================ */
  /*  Onglets honnêtement minimaux (backend réel réutilisé quand il */
  /*  existe, "à venir" explicite sinon — jamais une valeur fictive) */
  /* ============================================================ */
  async function renderAlerts(el) {
    el.innerHTML = `<div class="card"><div class="card-body">
      <p class="mc-detail-note">PCS01 se configure par site depuis l'onglet <strong>Main courante</strong> (réutilise /api/maincourante/admin/pcs01, déjà réel). Une configuration NONE/MANUAL/AUTOMATIC générique par type d'alerte, avec escalades/délais/destinataires dédiés à ce module, reste à construire (LOT 12) — non fabriquée ici.</p>
      <p>Règles d'alerte existantes : voir Centre d'alertes → Règles & escalades (déjà opérationnel, backend/alerts.js).</p>
    </div></div>`;
  }
  async function renderAccess(el) {
    el.innerHTML = `<div class="card"><div class="card-body">
      <p class="mc-detail-note">Les niveaux N1-N4 affichés jusqu'ici (page Paramètres) sont un tableau statique, jamais adossé à une table réelle. Leur administration réelle (zones/règles/horaires) est prévue au LOT 13 et n'est pas encore construite — affiché honnêtement plutôt que fabriqué.</p>
      <p><span class="badge muted">À venir</span></p>
    </div></div>`;
  }
  async function renderRounds(el) {
    el.innerHTML = `<div class="card"><div class="card-body">
      <p class="mc-detail-note">Les circuits/checkpoints de ronde par site sont visibles et gérés depuis l'onglet <strong>Main courante</strong> de ce module (réutilise le moteur de rondes existant, backend/maincourante-workflows.js — jamais un second moteur créé).</p>
      <button class="btn btn-outline" onclick="AdminSystem.showTab('maincourante')">Ouvrir Main courante</button>
    </div></div>`;
  }
  async function renderNotifications(el) {
    const sys = await API.get('/admin/system');
    el.innerHTML = `<div class="card"><div class="card-body">
      <table><tbody>
        <tr><td>Push (navigateur)</td><td>${sys.health.push === 'operational' ? '<span class="badge success">Opérationnel</span>' : '<span class="badge muted">Non configuré</span>'}</td></tr>
        <tr><td>Email</td><td><span class="badge muted">Non configuré</span></td></tr>
        <tr><td>SMS</td><td><span class="badge muted">Non configuré</span></td></tr>
      </tbody></table>
      <p class="mc-detail-note">Email/SMS ne sont pas implémentés dans ce backend — jamais simulés ici.</p>
    </div></div>`;
  }
  async function renderCameras(el) {
    try {
      const cams = await API.get('/camera/list');
      el.innerHTML = `<div class="card"><div class="card-body">
        <table><thead><tr><th>Nom</th><th>Type</th><th>Flux</th></tr></thead><tbody>
          ${cams.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${escapeHtml(c.streamMode)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">Aucune caméra configurée</td></tr>'}
        </tbody></table>
        <p class="mc-detail-note">Registre fichier (backend/camera-registry.js) — jamais de credentials/URL exposés ici. Administration (ajout/suppression) reste à construire au LOT 16.</p>
      </div></div>`;
    } catch (e) { el.innerHTML = `<div class="card"><div class="card-body"><p class="mc-wf-error">${escapeHtml(e.message || String(e))}</p></div></div>`; }
  }
  async function renderIntegrations(el) {
    el.innerHTML = `
      <div class="card"><div class="card-header"><div class="card-title">🔗 ATLAS / IRON GLOBAL SÉCURITÉ</div></div>
        <div class="card-body">
          <p><span class="badge muted">Non configuré</span></p>
          <p class="mc-detail-note">Référentiel futur des employés, APS, photos et affectations. Aucune connexion réelle dans ce lot — emplacement préparé uniquement.</p>
        </div></div>
      <div class="card"><div class="card-header"><div class="card-title">Intégrations existantes</div></div>
        <div class="card-body"><table><tbody>
          <tr><td>API REST</td><td><span class="badge success">Opérationnel</span></td></tr>
          <tr><td>Push (Web Push)</td><td><span class="badge muted" id="intPushStatus">…</span></td></tr>
          <tr><td>Caméras / LAPI</td><td><span class="badge success">Opérationnel</span></td></tr>
          <tr><td>Webhooks</td><td><span class="badge muted">Non configuré</span></td></tr>
        </tbody></table></div></div>`;
    try {
      const sys = await API.get('/admin/system');
      document.getElementById('intPushStatus').outerHTML = sys.health.push === 'operational' ? '<span class="badge success">Opérationnel</span>' : '<span class="badge muted">Non configuré</span>';
    } catch { /* laisse "…" si indisponible, jamais une valeur inventée */ }
  }
  async function renderData(el) {
    el.innerHTML = `<div class="card"><div class="card-body">
      <p class="mc-detail-note">Gouvernance des données (export/archivage/corbeille/rétention/purge contrôlée) reste à construire (LOT 18). Ce qui existe déjà et reste utilisable : archivage de site (onglet Sites → statut), export CSV du journal Main courante (page Main courante existante).</p>
      <p><span class="badge muted">À venir</span></p>
    </div></div>`;
  }
  async function renderAudit(el) {
    el.innerHTML = `<div class="card"><div class="card-header"><div class="card-title">📜 Journal d'audit</div></div>
      <div class="card-body">
        <div class="toolbar"><div class="form-group"><input type="text" id="auditEventFilter" placeholder="Type d'événement (ex: system_admin.site.create)"></div>
          <button class="btn btn-outline" onclick="AdminSystem.reloadAudit()">Filtrer</button></div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Acteur</th><th>Événement</th><th>Ressource</th><th>Résultat</th></tr></thead><tbody id="adminAuditBody"></tbody></table></div>
      </div></div>`;
    await reloadAudit();
  }
  async function reloadAudit() {
    const ev = document.getElementById('auditEventFilter')?.value || '';
    const qs = new URLSearchParams({ limit: '50', ...(ev ? { event_type: ev } : {}) });
    try {
      const rows = await API.get('/admin/security-audit?' + qs.toString());
      const body = document.getElementById('adminAuditBody');
      body.innerHTML = rows.map(r => `
        <tr><td>${new Date(r.created_at).toLocaleString('fr-FR')}</td><td>${escapeHtml(r.actor_username || '—')}</td>
          <td>${escapeHtml(r.event_type)}</td><td>${escapeHtml(r.resource_type)}${r.resource_id ? ' #' + escapeHtml(String(r.resource_id)).slice(0, 8) : ''}</td>
          <td>${r.outcome === 'success' ? '<span class="badge success">succès</span>' : r.outcome === 'denied' ? '<span class="badge warning">refusé</span>' : '<span class="badge danger">échec</span>'}</td></tr>`
      ).join('') || '<tr><td colspan="5" class="empty-state">Aucun événement (ou compte sans appartenance soc — la lecture est restreinte par tenant)</td></tr>';
    } catch (e) { notify(e.message || 'Erreur', 'error'); }
  }
  async function renderSettings(el) {
    el.innerHTML = `<div class="card"><div class="card-body">
      <p class="mc-detail-note">Réglages généraux existants : coordonnées du site (onglet Sites), PCS01 par site (onglet Main courante), push (onglet Notifications). Un panneau de paramètres système transverse supplémentaire n'a pas de backend dédié aujourd'hui — rien fabriqué ici.</p>
    </div></div>`;
  }
  async function renderAi(el) {
    el.innerHTML = `<div class="card"><div class="card-body">
      <p class="mc-detail-note">Capacités IA réellement présentes : résumés d'incident et assistant SOC (Centre d'alertes, backend/ai/*). Administration dédiée (activation par module, quotas) reste à construire — non inventée ici.</p>
      <button class="btn btn-outline" onclick="AdminSystem.showTab('overview')">Retour</button>
    </div></div>`;
  }

  return {
    showTab, get currentTab() { return currentTab; }, tabLabel,
    reloadSites, openSiteDetail, switchSiteTab, saveSite, setSiteStatus, openSiteWizard,
    toggleSitesSelectMode, toggleSiteSelected, toggleSelectAllSites, confirmDeleteSelectedSites, confirmDeleteSite,
    manageRefusedSite, viewSiteMembershipDependencies, backToSiteDependencies, manageMembershipModal,
    archiveMembershipAction, reassignMembershipModal, reassignLoadSites,
    reloadZones, setUserStatus, setUserSosRecipient, openCreateUserModal, reloadMcAdmin, reloadAudit,
    reloadGroups, setGroupsStatusFilter, openGroupWizard, openGroupDetail, openGroupDetailAndEdit, closeGroupDetail, switchGroupTab, groupTabKeydown,
    toggleGroupEditMode, cancelGroupInfoEdit, saveGroupInfo, setGroupStatus, toggleGroupActionsMenu, closeGroupActionsMenu,
    toggleGroupRowMenu, groupRowKeydown,
    renderGroupSitesPanels, toggleGroupAvailSelected, addSelectedGroupSites, addAllGroupSites,
    removeGroupSite, removeAllGroupSites, saveGroupSites, cancelGroupSitesChanges,
    openAssignGroupUserModal, confirmRemoveGroupUser,
  };
})();
