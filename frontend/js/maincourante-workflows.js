/**
 * MAIN COURANTE — moteur de workflows (portage PostgreSQL propre).
 *
 * Étudié conceptuellement sur feature/securisite-alert-core (exploration
 * SQLite, jamais copiée telle quelle) puis reconstruit ici contre les
 * routes PostgreSQL réelles (backend/maincourante-workflows.js). Un shell
 * commun (showModal/closeModal, déjà partagé par toute l'application —
 * focus trap, Escape, ARIA déjà en place, jamais reconstruits ici) rend
 * dynamiquement le contenu déclaré par chaque workflow (context.workflows[].
 * fields/aps) : aucune des 29 fenêtres n'est codée en dur.
 *
 * La grille de codes (catégories, recherche, barre 15.100) reste celle déjà
 * en place (frontend/js/app.js#renderMcEventGrid, backend/
 * maincourante-events.js) — ce module ne fait que réagir à la sélection
 * d'un code pour ouvrir le formulaire réel correspondant.
 */
const MainCouranteWorkflows = (() => {
  'use strict';
  let context = null;   // dernière réponse de /workflows/context
  let siteId = null, zoneId = null;
  let currentWorkflow = null, currentCode = null;
  let selectedAps = {}; // { fieldKey: {id, nom, prenom, matricule, ...} }
  let lastFocused = null;

  function workflowFor(code) { return context?.workflows.find(w => w.code === code) || null; }

  // Appelé une fois au chargement de la page Main courante (frontend/js/
  // app.js#loadMaincourante) : résout le site réellement accessible (une
  // seule appartenance -> sélection automatique, plusieurs -> l'agent choisit),
  // jamais un site deviné ou par défaut arbitraire.
  async function loadContext() {
    if (!siteId) siteId = sessionStorage.getItem('mcWorkflowSiteId') || null;
    if (!siteId) {
      // Aucun site mémorisé : /workflows/context exige site_id (chaque
      // référence doit être revérifiée dans un périmètre réel, mission
      // explicite) — /workflows/sites amorce juste la liste des sites
      // couverts par les memberships actives, sans deviner.
      const probe = await API.get('/maincourante/workflows/sites').catch(() => null);
      if (probe && probe.sites && probe.sites.length) siteId = probe.sites[0].id;
    }
    if (!siteId) return null;
    context = await API.get('/maincourante/workflows/context?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : ''));
    sessionStorage.setItem('mcWorkflowSiteId', siteId);
    return context;
  }

  function setSite(id) { siteId = id; zoneId = null; return loadContext(); }
  function setZone(id) { zoneId = id || null; return loadContext(); }
  function languageChanged() { if (modalOpen()) render(); }
  function modalOpen() { return !!currentCode; }
  function onModalClose() { currentCode = null; currentWorkflow = null; selectedAps = {}; }

  const lang = () => document.documentElement.lang === 'ar' ? 'ar' : 'fr';
  const t = (fr, ar) => lang() === 'ar' ? ar : fr;

  /* ============================================================ */
  /*  Ouverture du formulaire — shell commun, contenu par workflow  */
  /* ============================================================ */
  async function open(code) {
    if (!context || !siteId) { notify(t('Sélectionnez un site avant de saisir un événement', 'اختر موقعًا قبل تسجيل حدث'), 'warning'); return; }
    const workflow = workflowFor(code);
    if (!workflow) return;
    if (workflow.disabled) { notify(t('Code non configuré : aucune procédure disponible', 'رمز غير مهيأ: لا يوجد إجراء متاح'), 'warning'); return; }
    currentCode = code; currentWorkflow = workflow; selectedAps = {};
    lastFocused = document.activeElement;
    render();
  }

  function fieldLabel(key) {
    const labels = {
      agent_id: t('APS concerné', 'عون الأمن المعني'), sortant_id: t('APS sortant', 'العون المغادر'), entrant_id: t('APS entrant', 'العون القادم'),
      poste_id: t('Poste concerné', 'المركز المعني'), circuit_id: t('Circuit', 'المسار'), point_depart: t('Point de départ', 'نقطة الانطلاق'),
      anomaly: t('Anomalie constatée', 'ملاحظة اختلال'), anomaly_description: t('Description de l’anomalie', 'وصف الاختلال'),
      prenom: t('Prénom', 'الاسم'), nom: t('Nom', 'اللقب'), societe: t('Société', 'الشركة'), hote: t('Personne visitée', 'الشخص المزار'),
      motif: t('Motif', 'السبب'), badge: t('Badge', 'البطاقة'), visiteur_id: t('Visiteur présent', 'زائر حاضر'),
      confirmation_sortant: t('Confirmation de l’APS sortant', 'تأكيد العون المغادر'), confirmation_entrant: t('Confirmation de l’APS entrant', 'تأكيد العون القادم'),
      observation: t('Observation', 'ملاحظة'), destinataire: t('Destinataire', 'الجهة المرسل إليها'), priorite: t('Priorité', 'الأولوية'),
      identite: t('Identité', 'الهوية'), point: t('Point de contrôle', 'نقطة المراقبة'), motif_refus: t('Motif du refus', 'سبب الرفض'),
      equipment_id: t('Équipement', 'المعدة'), description: t('Description', 'الوصف'), impact: t('Impact', 'الأثر'),
      zone_impactee: t('Zone impactée', 'المنطقة المتأثرة'), plaque: t('Plaque', 'اللوحة'), conducteur: t('Conducteur', 'السائق'),
      reference_bon: t('Référence du bon', 'مرجع السند'), vehicule_id: t('Véhicule présent', 'مركبة حاضرة'),
      lieu: t('Lieu', 'المكان'),
    };
    return labels[key] || key;
  }

  function fieldControl(field) {
    const id = 'mc-wf-' + field.key;
    if (field.type === 'boolean') {
      return `<label class="mc-wf-check"><input type="checkbox" id="${id}" data-field="${field.key}"> ${escapeHtml(fieldLabel(field.key))}</label>`;
    }
    if (field.type === 'select') {
      const opts = (field.options || []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
      return `<div class="form-group"><label for="${id}">${escapeHtml(fieldLabel(field.key))}${field.required ? ' *' : ''}</label>
        <select id="${id}" data-field="${field.key}"><option value="">${t('Choisir…', 'اختر…')}</option>${opts}</select></div>`;
    }
    if (field.type === 'resource') {
      return `<div class="form-group"><label for="${id}">${escapeHtml(fieldLabel(field.key))}${field.required ? ' *' : ''}</label>
        <select id="${id}" data-field="${field.key}" data-resource="${field.resource}"><option value="">${t('Chargement…', 'جارٍ التحميل…')}</option></select></div>`;
    }
    return `<div class="form-group"><label for="${id}">${escapeHtml(fieldLabel(field.key))}${field.required ? ' *' : ''}</label>
      <input type="text" id="${id}" data-field="${field.key}" maxlength="500"></div>`;
  }

  function apsBlock(field) {
    const id = 'mc-wf-aps-' + field.key;
    const picked = selectedAps[field.key];
    return `<fieldset class="mc-wf-aps"><legend>${escapeHtml(fieldLabel(field.key))}${field.required ? ' *' : ''}</legend>
      <div class="mc-lookup-row">
        <input type="text" id="${id}-input" placeholder="${t('Matricule', 'الرقم الوظيفي')}" autocomplete="off" maxlength="80">
        <button type="button" class="btn btn-outline" data-aps-search="${field.key}">${t('Rechercher', 'بحث')}</button>
      </div>
      <div class="mc-aps-result" id="${id}-result">${picked ? apsCardHtml(picked) : ''}</div>
    </fieldset>`;
  }

  // La route photo est authentifiée (JWT Bearer) : une balise <img src="...">
  // brute ne peut pas porter cet en-tête et échouerait silencieusement
  // (image cassée). Récupérée en blob via fetch authentifié, injectée après
  // coup — jamais de silhouette générée présentée comme une photo réelle en
  // attendant (l'espace reste vide, pas de faux avatar).
  function apsCardHtml(a) {
    return `<div class="mc-identity">
      <div class="mc-identity-photo" id="mc-photo-${escapeHtml(a.__field || 'x')}">${a.has_photo ? '' : '<span aria-label="' + t('Photo indisponible', 'الصورة غير متوفرة') + '">◯</span>'}</div>
      <div>
        <strong>${escapeHtml((a.prenom || '') + ' ' + (a.nom || ''))}</strong>
        <div>${escapeHtml(a.matricule)} — ${escapeHtml(a.fonction || '')}</div>
        <small>${t('Identité issue du registre — lecture seule', 'الهوية من السجل — للقراءة فقط')}</small>
      </div>
    </div>`;
  }
  async function loadApsPhoto(fieldKey, apsId) {
    try {
      const res = await fetch('/api/maincourante/aps/' + encodeURIComponent(apsId) + '/photo?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : ''),
        { headers: { Authorization: 'Bearer ' + API.getToken() } });
      if (!res.ok) return;
      const blob = await res.blob();
      const holder = document.getElementById('mc-photo-' + fieldKey);
      if (holder) holder.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`;
    } catch { /* photo indisponible : l'espace reste vide, jamais de repli fictif */ }
  }

  async function render() {
    const w = currentWorkflow, code = currentCode;
    const title = `<span dir="ltr">${escapeHtml(code)}</span> — ${escapeHtml(w.label || code)}`;
    const body = `
      <p class="mc-detail-note">${t('Horodatage', 'التوقيت')} : <strong>${new Date(context.server_time).toLocaleString(lang() === 'ar' ? 'ar-DZ' : 'fr-FR')}</strong> — ${t('l’enregistrement est daté par le serveur', 'يُؤرَّخ التسجيل من طرف الخادم')}.</p>
      ${w.instructions ? `<p class="mc-detail-instructions">⚠️ ${escapeHtml(w.instructions)}</p>` : ''}
      ${w.relatedCode ? `<p class="mc-detail-note">ℹ️ ${t('Associé à', 'مرتبط بـ')} ${escapeHtml(w.relatedCode)}</p>` : ''}
      <form id="mcWorkflowForm">
        ${w.aps.map(apsBlock).join('')}
        ${w.fields.map(fieldControl).join('')}
        ${context.capabilities.pcs01 ? `<label class="mc-pcs01"><input type="checkbox" id="mcWfPcs01"> ${t('Déclencher une alerte PCS01', 'إطلاق تنبيه PCS01')} <span class="mc-pcs01-info" title="${t('Crée un incident lié, transmis au Centre d’alertes.', 'ينشئ حادثًا مرتبطًا يُحال إلى مركز التنبيهات.')}">ⓘ</span></label>` : ''}
        <p id="mcWorkflowError" class="login-error" role="alert" style="display:none"></p>
      </form>`;
    showModal(title, body, submit, t('Enregistrer', 'حفظ'));
    document.querySelectorAll('[data-resource]').forEach(loadResourceOptions);
    document.querySelectorAll('[data-aps-search]').forEach(btn => {
      btn.onclick = () => lookupAps(btn.dataset.apsSearch);
    });
    // Reconstruit après un changement de langue (languageChanged()) : une
    // identité déjà validée reste affichée, sa photo doit être rechargée
    // (le innerHTML précédent, avec l'<img> déjà résolue, vient d'être
    // remplacé par showModal()).
    for (const [key, aps] of Object.entries(selectedAps)) if (aps && aps.has_photo) loadApsPhoto(key, aps.id);
  }

  async function loadResourceOptions(select) {
    const kind = select.dataset.resource;
    const rows = await API.get('/maincourante/workflows/resources?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : '') + '&kind=' + encodeURIComponent(kind)).catch(() => []);
    const label = row => row.name || row.plaque || [row.prenom, row.nom].filter(Boolean).join(' ') || row.id;
    select.innerHTML = `<option value="">${t('Choisir…', 'اختر…')}</option>` + rows.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(label(r))}</option>`).join('');
  }

  async function lookupAps(fieldKey) {
    const input = document.getElementById('mc-wf-aps-' + fieldKey + '-input');
    const resultEl = document.getElementById('mc-wf-aps-' + fieldKey + '-result');
    const matricule = input.value.trim();
    if (!matricule) return;
    resultEl.innerHTML = `<span>${t('Recherche…', 'جارٍ البحث…')}</span>`;
    try {
      const aps = await API.post('/maincourante/aps/lookup?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : ''), { matricule, site_id: siteId, zone_id: zoneId });
      aps.__field = fieldKey;
      selectedAps[fieldKey] = aps;
      resultEl.innerHTML = apsCardHtml(aps);
      if (aps.has_photo) loadApsPhoto(fieldKey, aps.id);
    } catch (e) {
      selectedAps[fieldKey] = null;
      resultEl.innerHTML = `<span class="mc-wf-error">${t('APS introuvable', 'العون غير موجود')}</span>`;
    }
  }

  function collectFieldValue(field) {
    const el = document.querySelector('[data-field="' + field.key + '"]');
    if (!el) return undefined;
    if (field.type === 'boolean') return el.checked;
    return el.value || undefined;
  }
  function formError(msg) {
    const el = document.getElementById('mcWorkflowError');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  async function submit() {
    formError('');
    const w = currentWorkflow, code = currentCode;
    const data = {};
    for (const a of w.aps) {
      const picked = selectedAps[a.key];
      if (a.required && !picked) { formError(t('Recherchez et validez l’identité : ', 'ابحث وتحقق من الهوية: ') + fieldLabel(a.key)); return; }
      if (picked) data[a.key] = picked.id;
    }
    for (const f of w.fields) {
      const value = collectFieldValue(f);
      if (f.required && (value === undefined || value === '')) { formError(t('Champ requis : ', 'حقل مطلوب: ') + fieldLabel(f.key)); return; }
      if (value !== undefined && value !== '') data[f.key] = value;
    }
    const pcs01Check = document.getElementById('mcWfPcs01');
    const btn = document.getElementById('modalConfirm');
    if (btn) btn.disabled = true;
    try {
      const result = await API.post('/maincourante/events?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : ''), {
        code, site_id: siteId, zone_id: zoneId, data, trigger_pcs01: !!(pcs01Check && pcs01Check.checked),
        idempotency_key: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random()),
      });
      closeModal();
      notify(result.pcs01_triggered ? t('Entrée enregistrée — alerte PCS01 déclenchée', 'تم التسجيل — تم إطلاق تنبيه PCS01') : t('Entrée enregistrée', 'تم التسجيل'), 'success');
      if (typeof loadMaincourante === 'function') loadMaincourante();
    } catch (e) {
      formError(e.message || t('Échec de l’enregistrement', 'فشل التسجيل'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ============================================================ */
  /*  Administration — postes / matériel / circuits / PCS01         */
  /* ============================================================ */
  async function configure() {
    if (!siteId) return;
    const catalog = await API.get('/maincourante/admin/catalog?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : '')).catch(() => null);
    if (!catalog) { notify(t('Droits de gestion requis', 'صلاحيات إدارة مطلوبة'), 'warning'); return; }
    const body = `
      <div class="form-group"><label>${t('Nouveau poste', 'مركز جديد')}</label>
        <div class="mc-lookup-row"><input type="text" id="mcAdminPostName" placeholder="${t('Nom du poste', 'اسم المركز')}"><button type="button" class="btn btn-outline" id="mcAdminAddPost">${t('Ajouter', 'إضافة')}</button></div></div>
      <div class="form-group"><label>${t('Nouvel équipement', 'معدة جديدة')}</label>
        <div class="mc-lookup-row"><input type="text" id="mcAdminEqRef" placeholder="${t('Référence', 'المرجع')}"><input type="text" id="mcAdminEqName" placeholder="${t('Nom', 'الاسم')}"><input type="text" id="mcAdminEqLoc" placeholder="${t('Emplacement', 'الموقع')}"><button type="button" class="btn btn-outline" id="mcAdminAddEq">${t('Ajouter', 'إضافة')}</button></div></div>
      <p class="mc-detail-note">${t('Postes existants', 'المراكز الحالية')} : ${catalog.posts.map(p => escapeHtml(p.name)).join(', ') || t('aucun', 'لا يوجد')}</p>
      <p class="mc-detail-note">${t('Équipements existants', 'المعدات الحالية')} : ${catalog.equipment.map(e => escapeHtml(e.name)).join(', ') || t('aucun', 'لا يوجد')}</p>
      <hr>
      <label class="mc-pcs01"><input type="checkbox" id="mcAdminPcs01Enabled" ${catalog.pcs01.enabled ? 'checked' : ''}> ${t('Activer le déclenchement PCS01 sur ce site', 'تفعيل إطلاق PCS01 في هذا الموقع')}</label>
      <div id="mcAdminPcs01Codes">${context.workflows.filter(w => !w.disabled).map(w => `<label class="mc-wf-check"><input type="checkbox" value="${w.code}" data-pcs01-code ${catalog.pcs01.codes.includes(w.code) ? 'checked' : ''}> ${w.code} — ${escapeHtml(w.label)}</label>`).join('')}</div>`;
    showModal(t('Configuration du site', 'تهيئة الموقع'), body, saveAdminConfig, t('Enregistrer', 'حفظ'));
    document.getElementById('mcAdminAddPost').onclick = () => addResource('post', { name: document.getElementById('mcAdminPostName').value });
    document.getElementById('mcAdminAddEq').onclick = () => addResource('equipment', {
      reference: document.getElementById('mcAdminEqRef').value, name: document.getElementById('mcAdminEqName').value, location: document.getElementById('mcAdminEqLoc').value,
    });
  }
  async function addResource(kind, data) {
    try {
      await API.post('/maincourante/admin/resources?site_id=' + encodeURIComponent(siteId) + (zoneId ? '&zone_id=' + encodeURIComponent(zoneId) : ''), { kind, data });
      notify(t('Ajouté', 'تمت الإضافة'), 'success');
      await loadContext();
      configure();
    } catch (e) { notify(e.message || t('Échec', 'فشل'), 'warning'); }
  }
  async function saveAdminConfig() {
    const enabled = document.getElementById('mcAdminPcs01Enabled').checked;
    const codes = [...document.querySelectorAll('[data-pcs01-code]:checked')].map(el => el.value);
    try {
      await API.put('/maincourante/admin/pcs01?site_id=' + encodeURIComponent(siteId), { enabled, codes });
      closeModal();
      notify(t('Configuration enregistrée', 'تم حفظ التهيئة'), 'success');
      await loadContext();
    } catch (e) { notify(e.message || t('Échec'), 'warning'); }
  }

  return { loadContext, setSite, setZone, open, configure, languageChanged, onModalClose, get context() { return context; }, get siteId() { return siteId; } };
})();
