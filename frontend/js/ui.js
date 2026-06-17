/**
 * UI helpers : modal, notifications, formats, filtres date
 */

// ===== Internationalisation FR / AR =====
const I18N_KEY = 'securisite_lang';
const I18N_AR = {
  'SécuriSite': 'سيكوري سايت',
  'SOC // Identification Requise': 'مركز الأمن // تسجيل الدخول مطلوب',
  'Identifiant': 'اسم المستخدم',
  'Identifiant / Email': 'اسم المستخدم / البريد الإلكتروني',
  'Identifiant ou email': 'اسم المستخدم أو البريد الإلكتروني',
  'Mot de passe': 'كلمة المرور',
  'Connexion': 'دخول',
  'DÉMO : admin / securisite': 'تجربة: admin / securisite',
  'SOC // Centre de Sûreté': 'مركز الأمن والحراسة',
  'Pilotage': 'القيادة',
  'Tableau de bord': 'لوحة التحكم',
  'Main courante': 'السجل اليومي',
  "Journal d'incidents": 'سجل الحوادث',
  "Contrôle d'accès": 'مراقبة الدخول',
  'Accès véhicules': 'دخول المركبات',
  'Lecture plaque (LAPI)': 'قراءة اللوحات',
  'Accès piétons': 'دخول المشاة',
  'Visiteurs': 'الزوار',
  'Employés': 'الموظفون',
  'Infrastructure': 'البنية التحتية',
  'Parking': 'موقف السيارات',
  'Badges & QR': 'البطاقات ورموز QR',
  'Analyse': 'التحليل',
  'Rapports': 'التقارير',
  'Paramètres': 'الإعدادات',
  'EN DIRECT': 'مباشر',
  'Notifications': 'الإشعارات',
  'Déconnexion': 'تسجيل الخروج',
  'Administrateur': 'المدير',
  'Agent de sûreté': 'عون الأمن',
  'Présents sur site': 'الموجودون في الموقع',
  "Visiteurs aujourd'hui": 'زوار اليوم',
  'Véhicules entrés': 'المركبات الداخلة',
  'Incidents ouverts': 'الحوادث المفتوحة',
  'Actualisation temps réel': 'تحديث فوري',
  'En attente / validés': 'في الانتظار / مؤكدون',
  '24 dernières heures': 'آخر 24 ساعة',
  'À traiter': 'قيد المعالجة',
  "Flux d'accès — 7 derniers jours": 'حركة الدخول - آخر 7 أيام',
  'Répartition des accès': 'توزيع الدخول',
  'Activité récente': 'النشاط الأخير',
  'Actualiser': 'تحديث',
  'Alertes & incidents en cours': 'التنبيهات والحوادث الجارية',
  'Tout voir': 'عرض الكل',
  'Vue rapide du parking': 'نظرة سريعة على الموقف',
  'Voir le parking': 'عرض الموقف',
  'Administration système': 'إدارة النظام',
  '+ Utilisateur': '+ مستخدم',
  'Créer admin système': 'إنشاء مدير النظام',
  'Utilisateurs': 'المستخدمون',
  'Utilisateurs système': 'مستخدمو النظام',
  'Créer un utilisateur': 'إنشاء مستخدم',
  'Synthèse utilisateurs': 'ملخص المستخدمين',
  'Comptes applicatifs': 'حسابات التطبيق',
  'Administrateurs': 'المديرون',
  'Agents': 'الأعوان',
  'Total comptes': 'إجمالي الحسابات',
  'Centre de contrôle sécurité': 'مركز التحكم الأمني',
  'Votre site est sous surveillance active': 'موقعك تحت مراقبة نشطة',
  'Suivez les accès, incidents, visiteurs et mouvements en temps réel depuis un tableau de bord clair.': 'تابع الدخول والحوادث والزوار والحركات مباشرة من لوحة تحكم واضحة.',
  'Analyser maintenant': 'تحليل الآن',
  'Voir les rapports': 'عرض التقارير',
  'État système': 'حالة النظام',
  'Session': 'الجلسة',
  'Mot de passe initial': 'كلمة المرور الأولية',
  'Nom de l\'utilisateur': 'اسم المستخدم الكامل',
  'ex: agent.poste1': 'مثال: agent.poste1',
  'Badges': 'البطاقات',
  'Identifiant': 'اسم المستخدم',
  'Nom': 'الاسم',
  'Rôle': 'الدور',
  'Créé le': 'تاريخ الإنشاء',
  'Actions': 'الإجراءات',
  'Saisir une nouvelle entrée': 'إدخال تسجيل جديد',
  'Horodatage auto': 'توقيت تلقائي',
  'Poste': 'النقطة',
  'Agent en service': 'العون المناوب',
  "Type d'événement": 'نوع الحدث',
  'Priorité': 'الأولوية',
  'Lieu / Zone': 'المكان / المنطقة',
  'Date / Heure': 'التاريخ / الوقت',
  'Description': 'الوصف',
  'Enregistrer': 'حفظ',
  'Effacer': 'مسح',
  '+ Ronde RAS': '+ دورية بدون ملاحظات',
  '+ Prise service': '+ بداية الخدمة',
  'Statistiques de la journée': 'إحصائيات اليوم',
  'Agents en service': 'الأعوان المناوبون',
  'Journal en temps réel': 'السجل المباشر',
  'Tous postes': 'كل النقاط',
  'Tous types': 'كل الأنواع',
  'Toute priorité': 'كل الأولويات',
  'Rechercher...': 'بحث...',
  'Du': 'من',
  'Au': 'إلى',
  "Aujourd'hui": 'اليوم',
  'Tout': 'الكل',
  'Déclarer un incident': 'التصريح بحادث',
  'Rechercher un incident...': 'البحث عن حادث...',
  'Tous statuts': 'كل الحالات',
  'Ouvert': 'مفتوح',
  'En cours': 'قيد المعالجة',
  'Résolu': 'محلول',
  'Toute gravité': 'كل درجات الخطورة',
  'Critique': 'حرج',
  'Majeur': 'كبير',
  'Mineur': 'بسيط',
  'Critiques': 'حرجة',
  'Majeurs': 'كبيرة',
  'Mineurs': 'بسيطة',
  'Résolus': 'محلولة',
  'Réf.': 'المرجع',
  'Date': 'التاريخ',
  'Type': 'النوع',
  'Lieu': 'المكان',
  'Gravité': 'الخطورة',
  'Statut': 'الحالة',
  'Agent': 'العون',
  'Plaque, conducteur...': 'لوحة، سائق...',
  'Tous': 'الكل',
  'Sur site': 'داخل الموقع',
  'Sorti': 'خرج',
  'Entrée': 'دخول',
  'Sortie': 'خروج',
  'Plaque': 'اللوحة',
  'Conducteur': 'السائق',
  'Société': 'الشركة',
  'Motif': 'السبب',
  'CAMÉRA INACTIVE': 'الكاميرا غير مفعلة',
  'Activer ou importer une image': 'فعّل الكاميرا أو استورد صورة',
  'Activer': 'تفعيل',
  'Arrêter': 'إيقاف',
  'Importer': 'استيراد',
  'CAPTURER LA PLAQUE': 'التقاط اللوحة',
  'Plaque détectée': 'اللوحة المكتشفة',
  'En attente': 'في الانتظار',
  'Plaque corrigée': 'اللوحة المصححة',
  'Alerter': 'إرسال تنبيه',
  'Lectures récentes': 'القراءات الأخيرة',
  'Vider': 'تفريغ',
  'Aucune lecture': 'لا توجد قراءات',
  'Journal LAPI': 'سجل قراءة اللوحات',
  'Confiance': 'الثقة',
  'Détails': 'التفاصيل',
  'Nom, badge, point...': 'اسم، بطاقة، نقطة...',
  'Tous accès': 'كل الدخول',
  'Entrées': 'الدخول',
  'Sorties': 'الخروج',
  'Refus': 'رفض',
  'Tous points': 'كل النقاط',
  '+ Saisir un passage': '+ تسجيل مرور',
  'Entrées 24h': 'دخول 24 ساعة',
  'Sorties 24h': 'خروج 24 ساعة',
  'Refus 24h': 'رفض 24 ساعة',
  'Suspectes': 'مشبوهة',
  'Badge': 'البطاقة',
  'Point': 'النقطة',
  'Sens': 'الاتجاه',
  'Résultat': 'النتيجة',
  'Notes': 'ملاحظات',
  'Nom, hôte, société...': 'اسم، مضيف، شركة...',
  'Attendu': 'منتظر',
  '+ Préenregistrer': '+ تسجيل مسبق',
  'Visiteur': 'الزائر',
  'Hôte': 'المضيف',
  'Arrivée': 'الوصول',
  'Personnel': 'المستخدمون',
  'Accès du jour': 'دخول اليوم',
  'Nom, matricule...': 'اسم، رقم...',
  'Tous services': 'كل المصالح',
  '+ Nouvel employé': '+ موظف جديد',
  'Matricule': 'الرقم الوظيفي',
  'Service': 'المصلحة',
  'Fonction': 'الوظيفة',
  'Niveau': 'المستوى',
  'Heure': 'الوقت',
  'Total places': 'مجموع الأماكن',
  'Disponibles': 'متاحة',
  'Occupées': 'مشغولة',
  'Réservées': 'محجوزة',
  "Plan d'occupation": 'خطة الإشغال',
  'Libre': 'حر',
  'Occupé': 'مشغول',
  'Réservé': 'محجوز',
  'PMR': 'ذوي الاحتياجات',
  'Mouvements parking': 'حركات الموقف',
  'Place': 'المكان',
  'Zone': 'المنطقة',
  'Durée': 'المدة',
  'Générateur de badge': 'مولد البطاقات',
  'Nom complet': 'الاسم الكامل',
  'Validité': 'الصلاحية',
  'Niveau accès': 'مستوى الدخول',
  'Référence': 'المرجع',
  'Générer': 'إنشاء',
  'Imprimer': 'طباعة',
  'Aperçu badge & QR': 'معاينة البطاقة و QR',
  'Le QR apparaîtra ici': 'سيظهر رمز QR هنا',
  'Historique des badges': 'سجل البطاقات',
  'Émis': 'أصدر في',
  'Valide': 'صالح',
  'État': 'الحالة',
  'Période': 'الفترة',
  '7 jours': '7 أيام',
  '30 jours': '30 يوما',
  '90 jours': '90 يوما',
  'Export CSV': 'تصدير CSV',
  'Évolution des accès': 'تطور الدخول',
  'Incidents par type': 'الحوادث حسب النوع',
  "Top points d'accès": 'أهم نقاط الدخول',
  'Heures de pointe': 'ساعات الذروة',
  'Synthèse exécutive': 'ملخص تنفيذي',
  'Site': 'الموقع',
  'Nom du site': 'اسم الموقع',
  'Adresse': 'العنوان',
  'Téléphone': 'الهاتف',
  "Niveaux d'accès": 'مستويات الدخول',
  'Code': 'الرمز',
  'Libellé': 'التسمية',
  'Zones': 'المناطق',
  'Accueil': 'الاستقبال',
  'Bureaux': 'المكاتب',
  'Production': 'الإنتاج',
  'Zone sensible': 'منطقة حساسة',
  'Annuler': 'إلغاء',
  'Fermer': 'إغلاق',
  'Créer': 'إنشاء',
  'Modifier': 'تعديل',
  'Supprimer': 'حذف',
  'admin': 'مدير',
  'agent': 'عون',
  'actif': 'نشط',
  'absent': 'غائب',
  'suspendu': 'موقوف',
  'ouvert': 'مفتوح',
  'encours': 'قيد المعالجة',
  'resolu': 'محلول',
  'mineur': 'بسيط',
  'majeur': 'كبير',
  'critique': 'حرج',
  'dans': 'داخل الموقع',
  'dehors': 'خارج الموقع',
  'attendu': 'منتظر',
  'present': 'موجود',
  'parti': 'غادر',
  'autorise': 'مسموح',
  'refus': 'رفض',
  'detecte': 'مكتشف',
  'incertain': 'غير مؤكد',
  'valide': 'مؤكد',
  'refuse': 'مرفوض',
  'entree': 'دخول',
  'sortie': 'خروج',
  'Aucun incident': 'لا توجد حوادث',
  'Aucun véhicule': 'لا توجد مركبات',
  'Aucun passage': 'لا توجد عمليات مرور',
  'Aucun visiteur': 'لا يوجد زوار',
  'Aucun employé': 'لا يوجد موظفون',
  'Aucun accès': 'لا توجد عمليات دخول',
  'Aucun mouvement': 'لا توجد حركات',
  'Aucun badge': 'لا توجد بطاقات',
  'Aucun utilisateur': 'لا يوجد مستخدمون',
  'Aucune entrée trouvée': 'لم يتم العثور على تسجيلات',
  'Aucune activité récente': 'لا يوجد نشاط حديث'
};

function translateText(text, lang){
  const original = text.trim();
  if(!original || !I18N_AR[original]) return text;
  if(lang === 'fr') return original;
  if(lang === 'ar') return I18N_AR[original];
  return original + ' / ' + I18N_AR[original];
}

let i18nApplying = false;
let i18nObserverReady = false;

function applyLanguage(lang = localStorage.getItem(I18N_KEY) || 'fr-ar'){
  if(i18nApplying) return;
  i18nApplying = true;
  localStorage.setItem(I18N_KEY, lang);
  document.documentElement.lang = lang === 'ar' ? 'ar' : 'fr';
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  const sel = document.getElementById('langSelect');
  if(sel) sel.value = lang;
  document.querySelectorAll('body *').forEach(el=>{
    if(['SCRIPT','STYLE','CANVAS','VIDEO'].includes(el.tagName)) return;
    [...el.childNodes].forEach(node=>{
      if(node.nodeType !== Node.TEXT_NODE) return;
      const raw = node.nodeValue;
      const trimmed = raw.trim();
      if(!trimmed) return;
      if(!node.__i18nOriginal) node.__i18nOriginal = trimmed;
      const translated = translateText(node.__i18nOriginal, lang);
      const next = raw.replace(trimmed, translated);
      if(node.nodeValue !== next) node.nodeValue = next;
    });
    ['placeholder','title','aria-label'].forEach(attr=>{
      const val = el.getAttribute?.(attr);
      if(!val) return;
      const key = 'i18nOriginal'+attr;
      if(!el.dataset[key]) el.dataset[key] = val;
      const next = translateText(el.dataset[key], lang);
      if(el.getAttribute(attr) !== next) el.setAttribute(attr, next);
    });
  });
  i18nApplying = false;
}

function setLanguage(lang){
  applyLanguage(lang);
}

function initI18nObserver(){
  if(i18nObserverReady) return;
  i18nObserverReady = true;
  let timer = null;
  new MutationObserver(()=>{
    if(i18nApplying) return;
    clearTimeout(timer);
    timer = setTimeout(()=>applyLanguage(), 40);
  }).observe(document.body, { childList:true, subtree:true });
  applyLanguage();
}

// ===== Format =====
function fmtDateTime(iso){ if(!iso) return '—'; return new Date(iso).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
function fmtTime(iso){ if(!iso) return '—'; return new Date(iso).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(iso){ if(!iso) return '—'; return new Date(iso).toLocaleDateString('fr-FR'); }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function generePlaque(){
  const L='ABCDEFGHJKLMNPQRSTUVWXYZ';
  return L[randInt(0,23)]+L[randInt(0,23)]+'-'+randInt(100,999)+'-'+L[randInt(0,23)]+L[randInt(0,23)];
}
function toLocalInput(d){
  const pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}

// ===== Modal =====
function showModal(title, body, onConfirm, btnLabel='Enregistrer'){
  const c = document.getElementById('modalContent');
  c.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">${title}</div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" id="modalConfirm">${btnLabel}</button>
    </div>`;
  document.getElementById('modalBackdrop').classList.add('show');
  document.getElementById('modalConfirm').onclick = onConfirm;
  applyLanguage();
}
function closeModal(){ document.getElementById('modalBackdrop').classList.remove('show'); }

// ===== Notification =====
function notify(msg, type='success'){
  const colors = { success: ['var(--success)','var(--success-glow)'], warning: ['var(--warning)','var(--warning-glow)'], danger: ['var(--danger)','var(--danger-glow)'], info: ['var(--primary)','var(--primary-glow)'] };
  const [color, glow] = colors[type] || colors.success;
  const n = document.createElement('div');
  n.style.cssText = `position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid ${color};color:${color};padding:12px 22px;box-shadow:0 0 20px ${glow},0 8px 24px rgba(0,0,0,0.5);z-index:2000;font-size:11px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:2px;font-weight:700;clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);transition:opacity .3s`;
  n.textContent = '◉ ' + msg;
  document.body.appendChild(n);
  setTimeout(()=>{ n.style.opacity='0'; },2700);
  setTimeout(()=>n.remove(),3000);
}

// ===== Filtres date =====
function inDateRange(iso, debId, finId){
  const deb = document.getElementById(debId)?.value;
  const fin = document.getElementById(finId)?.value;
  if(!iso) return true;
  const t = new Date(iso).getTime();
  if(deb && t < new Date(deb).getTime()) return false;
  if(fin && t > new Date(fin).getTime()) return false;
  return true;
}

function applyPreset(prefix, mode){
  const renderers = {
    inc:['incDateDeb','incDateFin',()=>renderIncidents()],
    veh:['vehDateDeb','vehDateFin',()=>renderVehicules()],
    pie:['pieDateDeb','pieDateFin',()=>renderPietons()],
    vis:['visDateDeb','visDateFin',()=>renderVisiteurs()],
    park:['parkDateDeb','parkDateFin',()=>renderParking()],
    empAcc:['empAccDateDeb','empAccDateFin',()=>renderEmpAcces()],
    mc:['mcDateDeb','mcDateFin',()=>renderMainCourante()]
  };
  const cfg = renderers[prefix]; if(!cfg) return;
  const [debId, finId, fn] = cfg;
  const debEl = document.getElementById(debId), finEl = document.getElementById(finId);
  const now = new Date(); let deb=null, fin=null;
  if(mode==='today'){ deb=new Date(now);deb.setHours(0,0,0,0); fin=new Date(now);fin.setHours(23,59,0,0); }
  else if(mode==='24h'){ deb=new Date(now.getTime()-24*3600*1000); fin=new Date(now); }
  else if(mode==='7j'){ deb=new Date(now.getTime()-7*24*3600*1000); fin=new Date(now); }
  else if(mode==='30j'){ deb=new Date(now.getTime()-30*24*3600*1000); fin=new Date(now); }
  else if(mode==='reset'){
    debEl.value=''; finEl.value='';
    const wrap = debEl.closest('.toolbar') || debEl.closest('.card-header');
    wrap?.querySelectorAll('.date-preset').forEach(b=>b.classList.remove('active'));
    fn(); return;
  }
  debEl.value = toLocalInput(deb);
  finEl.value = toLocalInput(fin);
  const wrap = debEl.closest('.toolbar') || debEl.closest('.card-header');
  wrap?.querySelectorAll('.date-preset').forEach(b=>b.classList.remove('active'));
  event?.target?.classList.add('active');
  fn();
}

// ===== Cache global pour les données =====
const cache = {
  employes: [], visiteurs: [], vehicules: [], pietons: [],
  incidents: [], badges: [], parking: { zones: [], mouvements: [] },
  mainCourante: [], lapiLectures: [], parametres: {},
  users: [], system: {}
};

async function refresh(entity){
  switch(entity){
    case 'employes': cache.employes = await API.get('/employes'); break;
    case 'visiteurs': cache.visiteurs = await API.get('/visiteurs'); break;
    case 'vehicules': cache.vehicules = await API.get('/vehicules'); break;
    case 'pietons': cache.pietons = await API.get('/pietons'); break;
    case 'incidents': cache.incidents = await API.get('/incidents'); break;
    case 'badges': cache.badges = await API.get('/badges'); break;
    case 'parking': cache.parking = await API.get('/parking'); break;
    case 'maincourante': cache.mainCourante = await API.get('/maincourante'); break;
    case 'lapi': cache.lapiLectures = await API.get('/lapi'); break;
    case 'parametres': cache.parametres = await API.get('/parametres'); break;
    case 'users': cache.users = await API.get('/admin/users'); break;
    case 'system': cache.system = await API.get('/admin/system'); break;
  }
}

// Theme global Chart.js
if(typeof Chart !== 'undefined'){
  Chart.defaults.color = '#7a8caa';
  Chart.defaults.borderColor = 'rgba(30,42,68,0.5)';
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.font.size = 11;
}
