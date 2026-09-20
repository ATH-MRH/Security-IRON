/**
 * Application principale : login, navigation, toutes les pages
 */

/* ===== LOGIN ===== */
async function doLogin(){
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if(!username || !password){ errEl.textContent='Identifiants requis'; errEl.style.display='block'; return; }
  try{
    const { token, user } = await API.login(username, password);
    API.setToken(token);
    API.setUser(user);
    showApp(user);
  } catch(e){
    errEl.textContent = e.message || 'Erreur';
    errEl.style.display = 'block';
  }
}

function doLogout(){
  Realtime.stop();
  API.clearToken();
  location.reload();
}

function isAdmin(){ return API.getUser()?.role === 'admin'; }

function showApp(user){
  document.getElementById('loginOverlay').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('userName').textContent = user.nom_complet || user.username;
  document.getElementById('userAvatar').textContent = (user.username||'A').charAt(0).toUpperCase();
  document.getElementById('userRoleLabel').textContent = user.role === 'admin' ? 'Administrateur' : 'Agent de sûreté';
  // Marque le corps → le CSS masque les actions réservées à l'admin pour les agents
  document.body.classList.toggle('role-agent', user.role !== 'admin');
  document.querySelectorAll('.admin-only').forEach(el=>el.style.display = user.role === 'admin' ? '' : 'none');
  initApp();
}

/* ===== NAVIGATION ===== */
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click',()=>navTo(item.dataset.page));
});

// Mobile : la barre latérale est hors-écran par défaut sous le seuil de
// largeur défini en CSS (@media(max-width:860px)) — ce toggle n'a aucun
// effet visuel au-delà, la classe 'open' n'y étant simplement jamais lue.
function openSidebar(){
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sidebarBackdrop')?.classList.add('show');
  document.getElementById('menuToggle')?.setAttribute('aria-expanded','true');
}
function closeSidebar(){
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('show');
  document.getElementById('menuToggle')?.setAttribute('aria-expanded','false');
}
function toggleSidebar(){
  document.getElementById('sidebar')?.classList.contains('open') ? closeSidebar() : openSidebar();
}

// Réduction desktop (icônes seules) — distincte du tiroir mobile ci-dessus.
// Préférence mémorisée par appareil uniquement (localStorage), jamais un
// réglage serveur : purement une commodité d'affichage.
const SIDEBAR_COLLAPSE_KEY = 'securisite_sidebar_collapsed';
function toggleSidebarCollapse(){
  const sidebar = document.getElementById('sidebar');
  if(!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  try{ localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); }catch{}
}
(function restoreSidebarCollapse(){
  try{
    if(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1') document.getElementById('sidebar')?.classList.add('collapsed');
  }catch{}
})();

// Menu profil (topbar) : la Déconnexion, retirée de la barre elle-même
// (fidélité visuelle à la référence), reste accessible ici — même fonction
// doLogout(), aucun changement de comportement.
function openLangMenu(){
  document.getElementById('langMenuDropdown')?.removeAttribute('hidden');
  document.getElementById('langMenuButton')?.setAttribute('aria-expanded','true');
}
function closeLangMenu(){
  document.getElementById('langMenuDropdown')?.setAttribute('hidden','');
  document.getElementById('langMenuButton')?.setAttribute('aria-expanded','false');
}
function toggleLangMenu(){
  document.getElementById('langMenuDropdown')?.hasAttribute('hidden') ? openLangMenu() : closeLangMenu();
}
document.addEventListener('click', e=>{
  const menu = document.getElementById('langMenuButton')?.closest('.lang-menu');
  if(menu && !menu.contains(e.target)) closeLangMenu();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeLangMenu(); });

function openUserMenu(){
  document.getElementById('userMenuDropdown')?.removeAttribute('hidden');
  document.getElementById('userMenuButton')?.setAttribute('aria-expanded','true');
}
function closeUserMenu(){
  document.getElementById('userMenuDropdown')?.setAttribute('hidden','');
  document.getElementById('userMenuButton')?.setAttribute('aria-expanded','false');
}
function toggleUserMenu(){
  document.getElementById('userMenuDropdown')?.hasAttribute('hidden') ? openUserMenu() : closeUserMenu();
}
document.addEventListener('click', e=>{
  const menu = document.getElementById('userMenuButton')?.closest('.user-menu');
  if(menu && !menu.contains(e.target)) closeUserMenu();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeUserMenu(); });


// Recherche rapide de la topbar : raccourci vers une page existante par son
// intitulé de menu (données déjà en mémoire, aucune API dédiée) — pas une
// recherche plein texte sur les sites/agents/événements eux-mêmes.
function topbarSearchIndex(){
  return [...document.querySelectorAll('.nav-item[data-page]')].map(el=>({
    page: el.dataset.page,
    label: el.querySelector('span:last-child')?.textContent.trim() || el.dataset.page,
  }));
}
function filterTopbarSearch(query){
  const results = document.getElementById('topbarSearchResults');
  if(!results) return;
  const q = query.trim().toLowerCase();
  if(!q){ results.hidden = true; results.innerHTML=''; return; }
  const matches = topbarSearchIndex().filter(e=>e.label.toLowerCase().includes(q)).slice(0,6);
  if(!matches.length){ results.hidden = true; results.innerHTML=''; return; }
  results.innerHTML = matches.map(m=>`<button type="button" onclick="runTopbarSearch('${escapeHtml(m.label)}')">${escapeHtml(m.label)}</button>`).join('');
  results.hidden = false;
}
function runTopbarSearch(query){
  const q = query.trim().toLowerCase();
  const match = topbarSearchIndex().find(e=>e.label.toLowerCase().includes(q));
  const input = document.getElementById('topbarSearch');
  const results = document.getElementById('topbarSearchResults');
  if(match) navTo(match.page);
  if(input) input.value='';
  if(results){ results.hidden = true; results.innerHTML=''; }
}
document.addEventListener('keydown', e=>{
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='k'){
    e.preventDefault();
    document.getElementById('topbarSearch')?.focus();
  }
});
document.addEventListener('click', e=>{
  if(!e.target.closest('.topbar-search')) document.getElementById('topbarSearchResults')?.setAttribute('hidden','');
});

function navTo(page){
  closeSidebar(); // un choix de page referme toujours le menu mobile
  if((page==='utilisateurs' || page==='parametres') && !isAdmin()) return navTo('dashboard');
  if(page!=='lapi' && lapiStream){ try{ arreterCamera(); }catch{} }
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.page===page));
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.id==='page-'+page));
  const titles = {alertes:'Centre d’alertes',carte:'Carte & sites',dashboard:'Tableau de bord',maincourante:'Main courante — Journal en temps réel',incidents:'Incidents',vehicules:'Véhicules',lapi:'Lecture automatique de plaques (LAPI)',pietons:'Accès piétons',visiteurs:'Visiteurs',employes:'Agents',parking:'Parking',badges:'Badges & QR codes',rapports:'Rapports & statistiques',utilisateurs:'Utilisateurs système',parametres:'Paramètres'};
  document.getElementById('pageTitle').textContent = titles[page] || page;
  if(page==='alertes') AlertCenter.load();
  if(page==='carte') SiteMap.load();
  if(page==='dashboard') loadDashboard();
  if(page==='maincourante') loadMaincourante();
  if(page==='incidents') loadIncidents();
  if(page==='vehicules') loadVehicules();
  if(page==='lapi') loadLapi();
  if(page==='pietons') loadPietons();
  if(page==='visiteurs') loadVisiteurs();
  if(page==='employes') loadEmployes();
  if(page==='parking') loadParking();
  if(page==='badges') loadBadges();
  if(page==='rapports') loadRapports();
  if(page==='utilisateurs') loadUsersModule();
  if(page==='parametres') loadParametres();
}

function switchTab(el, target){
  el.parentElement.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  ['tabEmployes','tabAtlas','tabEmpAcces'].forEach(id=>{
    document.getElementById(id).style.display = id===target?'block':'none';
  });
  if(target==='tabEmpAcces') renderEmpAcces();
  if(target==='tabAtlas') renderAffectationsAtlas();
}

/* ===== DASHBOARD ===== */
let chartFluxInst, chartRepInst, chartHourlyInst, chartAlertsDonutInst;
async function loadDashboard(){
  await Promise.all([refresh('vehicules'),refresh('visiteurs'),refresh('employes'),refresh('incidents'),refresh('pietons'),refresh('parking'),refresh('maincourante')]);
  const [stats, alertRows, siteRows] = await Promise.all([
    API.get('/stats/dashboard'),
    API.get('/alerts').catch(()=>[]),       // Centre d'alertes déjà autorisé (PG-8) ; dégradé silencieux si indisponible
    API.get('/map/sites').catch(()=>[]),    // référentiel sites (PG-6), même route que la page Carte
  ]);
  renderDashboardKpiRow2(stats);
  document.getElementById('kpi-incidents-encours').textContent = stats.incidents_ouverts;
  document.getElementById('kpi-alertes-critiques').textContent = SocKpis.compute(alertRows).critical;
  document.getElementById('kpi-agents-service').textContent = agentsEnServiceCount();
  document.getElementById('kpi-sites-actifs').textContent = siteRows.length;
  const siteWord = translateText(siteRows.length>1?'sites':'site', localStorage.getItem(I18N_KEY)||'fr');
  document.getElementById('kpi-sites-total').textContent = `/ ${siteRows.length} ${siteWord}`;
  updateHeroGreeting();
  updateCleanHeroStatus(stats);
  drawChartFlux(); drawChartRepartition();
  drawChartHourly(alertRows); drawChartAlertsDonut(alertRows);
  renderDashboardMap(siteRows, alertRows);
  renderDashboardIncidents();
  renderDashboardLiveFeed();
  renderActivite(); renderAlertes(); renderParkingQuick();
  if(API.getUser()?.role === 'admin') await loadAdminDashboard();
}

// MISSION KPI (tableau de bord) : même principe que frontend/js/soc-kpis.js
// (jamais dupliqué tel quel — cache.visiteurs/cache.vehicules sont des
// tableaux de fiches, pas des alertes, un champ date différent par entité) —
// 7 points réels (aujourd'hui inclus), un vrai jour calendaire chacun.
function dailyCounts(records, dateField, now = new Date()){
  const sameDay = (iso, ref) => iso && new Date(iso).toDateString() === ref.toDateString();
  const series = [];
  for(let i=6; i>=0; i--){ const ref = new Date(now); ref.setDate(ref.getDate()-i); series.push((records||[]).filter(r=>sameDay(r[dateField], ref)).length); }
  return series;
}
// "Présents sur site" et "Incidents ouverts" sont des états instantanés
// (combien MAINTENANT) : aucun relevé historique de ces états n'existe (rien
// n'enregistre "combien étaient présents/ouverts hier à cette heure") —
// état neutre pour ces deux cartes, jamais une évolution inventée. Visiteurs/
// véhicules sont de vrais compteurs d'événements horodatés (arrivee/entree) :
// une comparaison réelle jour à jour en est tirée, calculée ici côté client
// à partir des mêmes données déjà chargées (aucune nouvelle requête).
function renderDashboardKpiRow2(stats){
  const now = new Date();
  const visSeries = dailyCounts(cache.visiteurs, 'arrivee', now);
  const visDiff = visSeries[6] - visSeries[5];
  const vehSeries = dailyCounts(cache.vehicules, 'entree', now);
  const vehDiff = vehSeries[6] - vehSeries[5];
  document.getElementById('dashKpiRow2').innerHTML = [
    renderKpi2Card({icon:'👥',tone:'success',label:'Présents sur site',value:stats.employes_actifs+stats.visiteurs_present+stats.vehicules_sur_site,trend:null,series:null,footerIcon:'🟢',footerText:'Actualisation temps réel'}),
    renderKpi2Card({icon:'🎫',tone:'info',label:'Visiteurs aujourd\'hui',value:stats.visiteurs_total,trend:{direction:visDiff>0?'up':visDiff<0?'down':'flat',diff:visDiff},series:visSeries,footerIcon:'📋',footerText:'En attente / validés'}),
    renderKpi2Card({icon:'🚗',tone:'warning',label:'Véhicules entrés',value:stats.vehicules_24h,trend:{direction:vehDiff>0?'up':vehDiff<0?'down':'flat',diff:vehDiff},series:vehSeries,footerIcon:'🕒',footerText:'24 dernières heures'}),
    renderKpi2Card({icon:'⚠️',tone:'danger',label:'Incidents ouverts',value:stats.incidents_ouverts,trend:null,series:null,footerIcon:'📋',footerText:'À traiter'}),
  ].join('');
}

// Même définition que la carte "Agents en service" de Main courante
// (frontend/js/app.js#renderMainCourante) : agents distincts ayant
// enregistré une entrée dans les 8 dernières heures — aucune notion de
// planning/effectif prévu n'existe dans ce code base, jamais simulée ici.
function agentsEnServiceCount(){
  const limite = Date.now()-8*3600*1000;
  const agents = new Set();
  (cache.mainCourante||[]).filter(e=>new Date(e.datetime).getTime()>limite).forEach(e=>agents.add(e.agent+'|'+e.poste));
  return agents.size;
}

let heroClockTimer;
function updateHeroGreeting(){
  const user = API.getUser();
  const nameEl = document.getElementById('heroUsername');
  if(nameEl) nameEl.textContent = user?.nom_complet || user?.username || '—';
  tickHeroClock();
  clearInterval(heroClockTimer);
  heroClockTimer = setInterval(tickHeroClock, 1000);
}
function tickHeroClock(){
  const now = new Date();
  const dateEl = document.getElementById('heroDate');
  const clockEl = document.getElementById('heroClock');
  if(dateEl) dateEl.textContent = fmtDateLong(now);
  if(clockEl) clockEl.textContent = now.toLocaleTimeString(currentDateLocale());
}

function updateCleanHeroStatus(stats){
  const hero = document.getElementById('cleanHeroStatus');
  const text = document.getElementById('cleanStatusText');
  if(!hero || !text) return;
  const hasCritical = (stats.incidents_critiques || 0) > 0;
  const hasOpen = (stats.incidents_ouverts || 0) > 0;
  hero.classList.remove('analyzing');
  hero.classList.toggle('danger', hasCritical || hasOpen);
  hero.classList.toggle('ok', !hasCritical && !hasOpen);
  text.textContent = hasCritical ? 'CRITIQUE' : (hasOpen ? 'À traiter' : 'OK');
}

async function runDashboardAnalysis(){
  const hero = document.getElementById('cleanHeroStatus');
  const text = document.getElementById('cleanStatusText');
  if(hero){
    hero.classList.remove('danger','ok');
    hero.classList.add('analyzing');
  }
  if(text) text.textContent = 'Analyse';
  await new Promise(resolve=>setTimeout(resolve, 900));
  await loadDashboard();
}
function renderActivite(){
  const items = [];
  cache.pietons.slice(0,8).forEach(p=>items.push({icone:p.sens==='entree'?'➡️':'⬅️',titre:p.nom+' — '+(p.sens==='entree'?'Entrée':'Sortie')+(p.resultat==='refus'?' REFUSÉE':''),meta:p.point+' • '+p.type,time:fmtTime(p.datetime),type:p.resultat==='refus'?'danger':(p.sens==='entree'?'success':'')}));
  cache.vehicules.slice(0,4).forEach(v=>items.push({icone:'🚗',titre:v.plaque+' — '+(v.statut==='dans'?'Entrée':'Sortie')+' ('+v.type+')',meta:v.conducteur+(v.societe?' • '+v.societe:''),time:fmtTime(v.statut==='dans'?v.entree:v.sortie),type:''}));
  const c = document.getElementById('activiteRecente');
  if(items.length===0) return c.innerHTML='<div class="empty-state">Aucune activité récente</div>';
  c.innerHTML = items.slice(0,12).map(it=>`<div class="alert-item ${it.type}"><div style="display:flex;gap:10px;align-items:start;flex:1"><div style="font-size:18px">${it.icone}</div><div class="alert-content"><div class="alert-title">${escapeHtml(it.titre)}</div><div class="alert-meta">${escapeHtml(it.meta)}</div></div></div><div class="alert-time">${it.time}</div></div>`).join('');
}
function renderAlertes(){
  const ouverts = cache.incidents.filter(i=>i.statut!=='resolu').slice(0,8);
  const c = document.getElementById('alertesEnCours');
  if(ouverts.length===0) return c.innerHTML='<div class="empty-state">✅ Aucun incident ouvert</div>';
  c.innerHTML = ouverts.map(i=>`<div class="alert-item ${i.gravite==='critique'?'danger':(i.gravite==='majeur'?'warning':'')}"><div class="alert-content"><div class="alert-title">${escapeHtml(i.type)} <span class="badge ${i.gravite==='critique'?'danger':(i.gravite==='majeur'?'warning':'info')}">${i.gravite}</span></div><div class="alert-meta">${escapeHtml(i.lieu)} • ${i.ref}</div></div><div class="alert-time">${fmtDateTime(i.datetime)}</div></div>`).join('');
}
function renderParkingQuick(){
  const c = document.getElementById('parkingQuickStats');
  c.innerHTML = (cache.parking.zones||[]).map(z=>{
    const occupe = (z.places||[]).filter(p=>p.etat==='occupe').length;
    const taux = Math.round(occupe*100/z.total);
    const cls = taux>85?'danger':(taux>60?'warning':'success');
    return `<div class="kpi-card ${cls}"><div class="kpi-label">${escapeHtml(z.nom)}</div><div class="kpi-value">${occupe}/${z.total}</div><div class="kpi-trend">${taux}% occupé</div></div>`;
  }).join('');
}

/* ===== Tableau de bord — panneaux du modèle UI 2.0 =====
   Réutilisent des routes/fonctions déjà existantes ailleurs dans
   l'application (MapMarkers/MapGeometry de la page Carte, SocKpis du
   Centre d'alertes, /alerts/assistant) — aucune nouvelle route, aucune
   donnée simulée. */

// Même projection relative que la page Carte (frontend/js/map.js),
// rendue dans un <svg> distinct (#dashMapCanvas) pour ne jamais entrer en
// conflit avec #carte-canvas si les deux sont dans le DOM à la fois.
function renderDashboardMap(siteRows, alertRows){
  const svg = document.getElementById('dashMapCanvas');
  const empty = document.getElementById('dashMapEmpty');
  if(!svg || !empty) return;
  const { box, markers } = MapMarkers.compute(siteRows, alertRows, { width:400, height:260, padding:24 });
  empty.hidden = !!box;
  svg.style.display = box ? 'block' : 'none';
  if(!box){ svg.innerHTML=''; return; }
  svg.innerHTML = markers.map(m=>{
    if(m.kind==='site') return `<g class="carte-marker carte-site" transform="translate(${m.x},${m.y})" role="img" aria-label="Site ${escapeHtml(m.label)}"><rect x="-5" y="-5" width="10" height="10" rx="2"></rect><title>${escapeHtml(m.label)}</title></g>`;
    const sos = m.kind==='sos';
    const color = m.level===4?'var(--danger)':m.level===3?'#e0793c':m.level===2?'var(--warning)':'var(--text-muted)';
    return `<g class="carte-marker carte-alert${sos?' carte-sos':''}" transform="translate(${m.x},${m.y})" role="img" aria-label="${sos?'SOS':'Alerte'} ${escapeHtml(m.label)}"><circle r="${sos?7:5}" style="fill:${color}"></circle><title>${escapeHtml(m.label)}</title></g>`;
  }).join('');
}

function renderDashboardIncidents(){
  const c = document.getElementById('dashIncidentsRecents');
  if(!c) return;
  const recents = [...cache.incidents].sort((a,b)=>new Date(b.datetime)-new Date(a.datetime)).slice(0,4);
  if(!recents.length){ c.innerHTML = '<div class="empty-state">Aucun incident récent</div>'; return; }
  const icon = g => g==='critique'?'🚨':g==='majeur'?'⚠️':'ℹ️';
  c.innerHTML = recents.map(i=>`
    <div class="ui2-incident-row ${i.gravite}" onclick="navTo('incidents')" style="cursor:pointer">
      <div class="ui2-incident-icon">${icon(i.gravite)}</div>
      <div class="ui2-incident-body">
        <strong>${escapeHtml(i.type)}</strong>
        <div class="ui2-incident-meta">
          <span class="badge ${i.gravite==='critique'?'danger':(i.gravite==='majeur'?'warning':'info')}">${escapeHtml(i.gravite)}</span>
          <span>${escapeHtml(i.lieu||'')}</span>
        </div>
        <div class="ui2-incident-meta"><span>${fmtDateTime(i.datetime)}</span><span>${escapeHtml(i.ref||'')}</span></div>
      </div>
      <div class="ui2-incident-chevron">›</div>
    </div>`).join('');
}

// Aucun fournisseur push/caméra "toujours actif" simulé : liste réelle
// (GET /camera/list, PG-30), registre vide par défaut => état vide honnête,
// jamais une image inventée. Un aperçu (ticket + snapshot via /camera/proxy),
// pas un flux vidéo persistant sur le tableau de bord.
let dashLiveFeedCameras = [], dashLiveFeedIndex = 0;
async function renderDashboardLiveFeed(){
  const c = document.getElementById('dashLiveFeed');
  if(!c) return;
  try{
    dashLiveFeedCameras = await API.get('/camera/list');
  }catch{ dashLiveFeedCameras = []; }
  if(!dashLiveFeedCameras.length){
    c.innerHTML = '<div class="empty-state">Aucune caméra configurée</div>';
    return;
  }
  dashLiveFeedIndex = 0;
  await paintDashLiveFeed();
}
async function paintDashLiveFeed(){
  const c = document.getElementById('dashLiveFeed');
  const cam = dashLiveFeedCameras[dashLiveFeedIndex];
  if(!c || !cam) return;
  let src = '';
  try{
    const { ticket } = await API.post('/camera/ticket', { camera_id: cam.id });
    src = `/api/camera/proxy?camera_id=${encodeURIComponent(cam.id)}&ticket=${encodeURIComponent(ticket)}`;
  }catch{ /* caméra momentanément indisponible : cadre visible, pas d'image */ }
  const dots = dashLiveFeedCameras.map((_,i)=>`<span class="${i===dashLiveFeedIndex?'active':''}"></span>`).join('');
  const multi = dashLiveFeedCameras.length>1;
  c.innerHTML = `
    <div class="ui2-live-feed">
      ${src?`<img src="${src}" alt="${escapeHtml(cam.name)}" onerror="this.remove()">`:''}
      <div class="ui2-live-feed-badge"><span class="live-dot"></span>${fmtTime(new Date())}</div>
      <div class="ui2-live-feed-caption"><strong>${escapeHtml(cam.name)}</strong><small>${escapeHtml(cam.type||'')}</small></div>
      ${multi?'<button type="button" class="ui2-live-feed-prev" onclick="dashLiveFeedNav(-1)" aria-label="Caméra précédente">‹</button><button type="button" class="ui2-live-feed-next" onclick="dashLiveFeedNav(1)" aria-label="Caméra suivante">›</button>':''}
    </div>
    ${multi?`<div class="ui2-live-feed-dots">${dots}</div>`:''}`;
}
function dashLiveFeedNav(delta){
  if(!dashLiveFeedCameras.length) return;
  dashLiveFeedIndex = (dashLiveFeedIndex + delta + dashLiveFeedCameras.length) % dashLiveFeedCameras.length;
  paintDashLiveFeed();
}

// Même agrégation que le Centre d'alertes (SocKpis), rendue en barres/heure
// et en anneau — jamais un second calcul divergent des mêmes données.
function drawChartHourly(alertRows){
  const canvas = document.getElementById('chartHourly');
  if(!canvas || typeof Chart==='undefined') return;
  const hours = Array.from({length:24},(_,h)=>h);
  const counts = hours.map(()=>0);
  alertRows.forEach(a=>{ const h = new Date(a.created_at).getHours(); if(h>=0 && h<24) counts[h]++; });
  const total = counts.reduce((s,c)=>s+c,0);
  const peakIdx = total ? counts.indexOf(Math.max(...counts)) : -1;
  if(chartHourlyInst) chartHourlyInst.destroy();
  chartHourlyInst = new Chart(canvas, { type:'bar', data:{
    labels: hours.map(h=>String(h).padStart(2,'0')+'h'),
    datasets:[{ data:counts, backgroundColor:counts.map((c,i)=>i===peakIdx?'rgba(37,117,252,.9)':'rgba(37,117,252,.22)'), borderRadius:4, maxBarThickness:14 }],
  }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{ beginAtZero:true, ticks:{precision:0} } } } });
  const footer = document.getElementById('chartHourlyFooter');
  if(footer){
    footer.innerHTML = peakIdx>=0
      ? `<span>🕐 Pic aujourd’hui : ${String(peakIdx).padStart(2,'0')}h</span><span>${total} événement${total>1?'s':''}</span>`
      : `<span>🕐 Aucun événement aujourd’hui</span>`;
  }
}
function drawChartAlertsDonut(alertRows){
  const canvas = document.getElementById('chartAlertsDonut');
  const legend = document.getElementById('dashAlertsLegend');
  const totalEl = document.getElementById('dashAlertsTotal');
  if(!canvas || typeof Chart==='undefined') return;
  const active = alertRows.filter(a=>!['CLOTUREE','FAUSSE_ALERTE','ANNULEE','RESOLUE'].includes(a.status));
  const groups = [
    { label:'Critiques', color:'#ff5f6d', count: active.filter(a=>a.level>=3).length },
    { label:'Moyennes', color:'#f7a928', count: active.filter(a=>a.level===2).length },
    { label:'Faibles', color:'#2575fc', count: active.filter(a=>a.level<=1).length },
  ];
  const total = groups.reduce((s,g)=>s+g.count,0);
  if(chartAlertsDonutInst) chartAlertsDonutInst.destroy();
  // Etat neutre géométriquement identique si total réel = 0 — jamais de
  // donnée inventée pour "faire apparaître" un anneau.
  const data = total ? groups.map(g=>g.count) : [1];
  const colors = total ? groups.map(g=>g.color) : ['#e6ebf2'];
  chartAlertsDonutInst = new Chart(canvas, { type:'doughnut', data:{
    labels: total ? groups.map(g=>g.label) : ['Aucune alerte'],
    datasets:[{ data, backgroundColor: colors, borderWidth:0 }],
  }, options:{ responsive:true, maintainAspectRatio:false, cutout:'72%', plugins:{legend:{display:false},tooltip:{enabled:!!total}} } });
  if(totalEl) totalEl.innerHTML = `<strong>${total}</strong><span>Total</span>`;
  if(legend) legend.innerHTML = groups.map(g=>`<div><span class="dot" style="background:${g.color}"></span><span class="ui2-donut-legend-label">${g.label}</span><strong>${g.count}</strong><small>${total?Math.round(g.count*100/total):0}%</small></div>`).join('');
}

// Même route que AlertCenter.assistantAsk() (/alerts/assistant) — un second
// point d'accès sur le tableau de bord, jamais un second moteur.
async function dashAssistantAsk(){
  const input = document.getElementById('dashAssistantQuestion');
  const help = document.getElementById('dashAssistantHelp');
  const panel = document.getElementById('dashAssistantAnswer');
  const question = input?.value.trim();
  if(!question || !panel) return false;
  if(help) help.hidden = true;
  panel.hidden = false;
  panel.innerHTML = '<p role="status">Réflexion…</p>';
  try{
    const r = await API.post('/alerts/assistant', { question });
    panel.innerHTML = `<div class="ac-ai-badge">✨ Généré par IA — à vérifier, jamais une décision automatique</div><p>${escapeHtml(r.text)}</p>`;
  }catch(err){
    panel.innerHTML = `<p role="alert">Assistant indisponible : ${escapeHtml(err.message)}</p>`;
  }
  return false;
}

async function loadAdminDashboard(){
  const card = document.getElementById('adminDashboardCard');
  if(!card || API.getUser()?.role !== 'admin') return;
  card.style.display = 'block';
  await Promise.all([refresh('users'), refresh('system'), refresh('pietons')]);
  renderSystemStats();
  renderAdminStatus();
  renderUsers();
  renderAdminPointages();
}

function renderSystemStats(){
  const c = document.getElementById('adminSystemStats');
  if(!c) return;
  const counts = cache.system.counts || {};
  const admins = cache.users.filter(u=>u.role==='admin').length;
  const agents = cache.users.filter(u=>u.role==='agent').length;
  const last24 = (cache.pietons || []).filter(p=>Date.now()-new Date(p.datetime).getTime()<24*3600*1000);
  const refus = last24.filter(p=>p.resultat==='refus').length;
  c.innerHTML = `
    <div class="admin-kpi info"><span>Comptes</span><strong>${counts.users||0}</strong><small>${admins} admin · ${agents} agent</small></div>
    <div class="admin-kpi success"><span>Badges actifs</span><strong>${counts.badges||0}</strong><small>Référentiel local</small></div>
    <div class="admin-kpi warning"><span>Pointages 24h</span><strong>${last24.length}</strong><small>${refus} refus à contrôler</small></div>
    <div class="admin-kpi danger"><span>Incidents</span><strong>${counts.incidents||0}</strong><small>${counts.main_courante||0} entrées main courante</small></div>`;
}

function renderAdminStatus(){
  const user = API.getUser() || {};
  const serverTime = cache.system.server_time ? fmtDateTime(cache.system.server_time) : '—';
  const dbMode = cache.system.db_url === 'sqlite-local' ? 'Locale' : 'Serveur';
  const openIncidents = (cache.system.counts?.incidents || 0);
  const health = document.getElementById('adminSystemHealth');
  const meta = document.getElementById('adminSystemMeta');
  const session = document.getElementById('adminSessionUser');
  const time = document.getElementById('adminServerTime');
  const dbModeEl = document.getElementById('adminDbMode');
  if(health) health.textContent = openIncidents ? 'Surveillance active' : 'Système stable';
  if(meta) meta.textContent = `Dernière lecture : ${serverTime}`;
  if(session) session.textContent = user.username || '—';
  if(time) time.textContent = serverTime;
  if(dbModeEl) dbModeEl.textContent = dbMode;
}

function renderUsers(){
  const current = API.getUser();
  const buildRows = (users, emptyColspan=5) => !users.length
    ? `<tr><td colspan="${emptyColspan}" class="empty-state">Aucun utilisateur</td></tr>`
    : users.map(u=>`<tr><td><strong>${escapeHtml(u.username)}</strong></td><td>${escapeHtml(u.nom_complet||'')}</td><td><span class="badge ${u.role==='admin'?'danger':'info'}">${u.role}</span></td><td>${fmtDateTime(u.created_at)}</td><td><button class="btn btn-sm btn-outline" onclick="editUser(${u.id})">✏️</button>${u.id!==current?.id?` <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">🗑️</button>`:''}</td></tr>`).join('');
  const dashboardBody = document.querySelector('#tableUsersDashboard tbody');
  const moduleBody = document.querySelector('#tableUsersModule tbody');
  if(dashboardBody) dashboardBody.innerHTML = buildRows(cache.users.slice(0, 6));
  if(moduleBody) moduleBody.innerHTML = buildRows(cache.users);
  const meta = document.getElementById('adminUsersMeta');
  if(meta){
    const admins = cache.users.filter(u=>u.role==='admin').length;
    meta.textContent = `${cache.users.length} compte(s), ${admins} administrateur(s)`;
  }
  renderUsersModuleStats();
}

function renderAdminPointages(){
  const tbody = document.querySelector('#tableAdminPointages tbody');
  if(!tbody) return;
  const q = (document.getElementById('adminSearchPieton')?.value || '').trim().toLowerCase();
  const filtered = (cache.pietons || []).filter(p=>{
    const haystack = `${p.nom||''} ${p.badge||''} ${p.point||''} ${p.type||''} ${p.notes||''}`.toLowerCase();
    return !q || haystack.includes(q);
  });
  const list = filtered.slice(0, 10);
  const meta = document.getElementById('adminPointageMeta');
  if(meta){
    const refus = filtered.filter(p=>p.resultat==='refus').length;
    meta.textContent = `${filtered.length} résultat(s) · ${refus} refus`;
  }
  if(!list.length){
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Aucun pointage à modifier</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(p=>`<tr><td>${fmtDateTime(p.datetime)}</td><td>${escapeHtml(p.nom||'')}</td><td><code>${escapeHtml(p.badge||'')}</code></td><td>${escapeHtml(p.point||'')}</td><td>${p.sens==='entree'?'➡️ Entrée':'⬅️ Sortie'}</td><td><span class="badge ${p.resultat==='autorise'?'success':'danger'}">${p.resultat==='autorise'?'Autorisé':'Refusé'}</span></td><td><button class="btn btn-sm btn-outline" onclick="editAdminPointage('${p.id}')">✏️ Modifier</button></td></tr>`).join('');
}

function editAdminPointage(id){
  const p = (cache.pietons || []).find(x=>x.id===id);
  if(!p) return notify('Pointage introuvable');
  openPietonModal(p);
}

function openUserModal(){
  showModal('Créer un utilisateur',`
    <div class="form-row"><div class="form-group"><label>Identifiant</label><input type="text" id="uUsername"></div><div class="form-group"><label>Rôle</label><select id="uRole"><option value="agent">Agent</option><option value="admin">Administrateur</option></select></div></div>
    <div class="form-row"><div class="form-group"><label>Nom complet</label><input type="text" id="uNom"></div><div class="form-group"><label>Mot de passe</label><input type="password" id="uPassword"></div></div>
  `, async ()=>{
    await API.post('/admin/users',{username:document.getElementById('uUsername').value,nom_complet:document.getElementById('uNom').value,password:document.getElementById('uPassword').value,role:document.getElementById('uRole').value});
    closeModal();
    if(document.getElementById('page-utilisateurs')?.classList.contains('active')) await loadUsersModule();
    else await loadAdminDashboard();
    notify('Utilisateur créé');
  }, 'Créer');
}

function editUser(id){
  const u = cache.users.find(x=>x.id===id); if(!u) return;
  showModal('Modifier '+u.username,`
    <div class="form-row"><div class="form-group"><label>Nom complet</label><input type="text" id="uEditNom" value="${escapeHtml(u.nom_complet||'')}"></div><div class="form-group"><label>Rôle</label><select id="uEditRole"><option value="agent"${u.role==='agent'?' selected':''}>Agent</option><option value="admin"${u.role==='admin'?' selected':''}>Administrateur</option></select></div></div>
    <div class="form-row full"><div class="form-group"><label>Nouveau mot de passe</label><input type="password" id="uEditPassword" placeholder="Laisser vide pour conserver"></div></div>
  `, async ()=>{
    await API.put('/admin/users/'+id,{nom_complet:document.getElementById('uEditNom').value,role:document.getElementById('uEditRole').value,password:document.getElementById('uEditPassword').value});
    closeModal();
    if(document.getElementById('page-utilisateurs')?.classList.contains('active')) await loadUsersModule();
    else await loadAdminDashboard();
    notify('Utilisateur modifié');
  });
}

async function deleteUser(id){
  if(!await confirmModal('Supprimer cet utilisateur ?')) return;
  await API.del('/admin/users/'+id);
  if(document.getElementById('page-utilisateurs')?.classList.contains('active')) await loadUsersModule();
  else await loadAdminDashboard();
  notify('Utilisateur supprimé');
}

async function ensureSystemAdmin(){
  const result = await API.post('/admin/system-admin',{});
  if(document.getElementById('page-utilisateurs')?.classList.contains('active')) await loadUsersModule();
  else await loadAdminDashboard();
  // PG-28 (correctif de sécurité) : le mot de passe n'est plus jamais
  // codé en dur côté serveur — il n'est renvoyé qu'à la création du compte
  // (result.created === true). Un appel ultérieur sur un compte déjà
  // existant renvoie password: null : on ne l'affiche ni ne le devine jamais.
  const passwordLine = result.password
    ? `<div class="alert-meta">Mot de passe initial : <strong>${escapeHtml(result.password)}</strong> (à noter maintenant, non ré-affiché ensuite)</div>`
    : `<div class="alert-meta">Compte déjà existant — mot de passe non ré-affiché.</div>`;
  showModal('Administrateur système',`
    <div class="alert-item success"><div class="alert-content"><div class="alert-title">Compte système prêt</div><div class="alert-meta">Identifiant : <strong>${escapeHtml(result.username)}</strong></div>${passwordLine}</div></div>
  `, closeModal, 'Fermer');
}

async function loadUsersModule(){
  if(API.getUser()?.role !== 'admin') return navTo('dashboard');
  await Promise.all([refresh('users'), refresh('system')]);
  renderUsers();
  renderUsersModuleStats();
}

function renderUsersModuleStats(){
  const c = document.getElementById('usersModuleStats');
  if(!c) return;
  const admins = cache.users.filter(u=>u.role==='admin').length;
  const agents = cache.users.filter(u=>u.role==='agent').length;
  c.innerHTML = `
    <div class="kpi-card danger"><div class="kpi-label">Administrateurs</div><div class="kpi-value">${admins}</div></div>
    <div class="kpi-card info"><div class="kpi-label">Agents</div><div class="kpi-value">${agents}</div></div>
    <div class="kpi-card success"><div class="kpi-label">Total comptes</div><div class="kpi-value">${cache.users.length}</div></div>
    <div class="kpi-card warning"><div class="kpi-label">Session</div><div class="kpi-value">${API.getUser()?.role||'—'}</div></div>`;
}

async function createUserFromModule(){
  const username = document.getElementById('userCreateUsername').value.trim();
  const nom = document.getElementById('userCreateName').value.trim();
  const password = document.getElementById('userCreatePassword').value;
  const role = document.getElementById('userCreateRole').value;
  if(!username || !password) return alert('Identifiant et mot de passe requis');
  await API.post('/admin/users',{username,nom_complet:nom||username,password,role});
  resetUserForm();
  await loadUsersModule();
  notify('Utilisateur créé');
}

function resetUserForm(){
  ['userCreateUsername','userCreateName','userCreatePassword'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  const role = document.getElementById('userCreateRole'); if(role) role.value='agent';
}

function openNotifications(){ return NotificationBell.open(); }

function drawChartFlux(){
  const ctx = document.getElementById('chartFlux');
  if(chartFluxInst) chartFluxInst.destroy();
  const labels=[],ent=[],sort=[];
  for(let i=6;i>=0;i--){
    const d = new Date(Date.now()-i*24*3600*1000);
    labels.push(d.toLocaleDateString(currentDateLocale(),{weekday:'short',day:'2-digit'}));
    ent.push(randInt(80,250)); sort.push(randInt(70,240));
  }
  chartFluxInst = new Chart(ctx,{type:'line',data:{labels,datasets:[{label:'Entrées',data:ent,borderColor:'#00ff9d',backgroundColor:'rgba(0,255,157,.12)',fill:true,tension:.3,borderWidth:2},{label:'Sorties',data:sort,borderColor:'#5ab9ff',backgroundColor:'rgba(90,185,255,.12)',fill:true,tension:.3,borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,grid:{color:'rgba(30,42,68,0.5)'}},x:{grid:{color:'rgba(30,42,68,0.3)'}}}}});
}
function drawChartRepartition(){
  const ctx = document.getElementById('chartRepartition');
  const legend = document.getElementById('dashRepartitionLegend');
  const totalEl = document.getElementById('dashRepartitionTotal');
  if(chartRepInst) chartRepInst.destroy();
  const groups = [
    { label:'Employés', color:'#2575fc', count: cache.employes.length },
    { label:'Visiteurs', color:'#21c7a8', count: cache.visiteurs.length },
    // UI-WHITE : Math.max(1, …) retiré — forçait un minimum fictif d'1
    // prestataire même quand le compte réel était 0 (donnée inventée,
    // seule "part" visible du donut quand tout le reste était à 0).
    { label:'Prestataires', color:'#f7a928', count: cache.badges.filter(b=>b.type==='P').length },
    { label:'Véhicules', color:'#ff5f6d', count: cache.vehicules.length },
  ];
  const total = groups.reduce((s,g)=>s+g.count,0);
  const data = total ? groups.map(g=>g.count) : [1];
  const colors = total ? groups.map(g=>g.color) : ['#e6ebf2'];
  chartRepInst = new Chart(ctx,{type:'doughnut',data:{
    labels: total ? groups.map(g=>g.label) : ['Aucun accès'],
    datasets:[{data, backgroundColor:colors, borderWidth:0}],
  },options:{responsive:true,maintainAspectRatio:false,cutout:'72%',plugins:{legend:{display:false},tooltip:{enabled:!!total}}}});
  if(totalEl) totalEl.innerHTML = `<strong>${total}</strong><span>Total</span>`;
  if(legend) legend.innerHTML = groups.map(g=>`<div><span class="dot" style="background:${g.color}"></span><span class="ui2-donut-legend-label">${g.label}</span><strong>${g.count}</strong><small>${total?Math.round(g.count*100/total):0}%</small></div>`).join('');
}

/* ===== MAIN COURANTE ===== */
async function loadMaincourante(){
  await refresh('maincourante');
  const dt = document.getElementById('mcDatetime');
  if(dt && !dt.value) dt.value = toLocalInput(new Date());
  const u = API.getUser();
  if(u && !document.getElementById('mcAgent').value){
    document.getElementById('mcAgent').value = sessionStorage.getItem('lastAgent') || u.nom_complet || u.username;
  }
  const lastPoste = sessionStorage.getItem('lastPoste');
  if(lastPoste) document.getElementById('mcPoste').value = lastPoste;
  renderMainCourante();
}

async function ajouterMainCourante(){
  const desc = document.getElementById('mcDescription').value.trim();
  const agent = document.getElementById('mcAgent').value.trim();
  if(!desc) return alert('Description obligatoire');
  if(!agent) return alert('Nom de l\'agent obligatoire');
  const dtVal = document.getElementById('mcDatetime').value;
  const entry = {
    datetime: dtVal ? new Date(dtVal).toISOString() : new Date().toISOString(),
    poste: document.getElementById('mcPoste').value,
    agent, type: document.getElementById('mcType').value,
    lieu: document.getElementById('mcLieu').value || '—',
    description: desc, priorite: document.getElementById('mcPriorite').value
  };
  await API.post('/maincourante', entry);
  sessionStorage.setItem('lastAgent', agent);
  sessionStorage.setItem('lastPoste', entry.poste);
  document.getElementById('mcDescription').value='';
  document.getElementById('mcLieu').value='';
  document.getElementById('mcDatetime').value = toLocalInput(new Date());
  await loadMaincourante();
  notify('Entrée enregistrée — '+entry.poste);
}

async function quickMC(type, desc){
  const agent = document.getElementById('mcAgent').value.trim();
  if(!agent){ alert('Saisissez le nom de l\'agent'); document.getElementById('mcAgent').focus(); return; }
  await API.post('/maincourante',{datetime:new Date().toISOString(),poste:document.getElementById('mcPoste').value,agent,type,lieu:document.getElementById('mcLieu').value||'—',description:desc,priorite:'normale'});
  sessionStorage.setItem('lastAgent', agent);
  await loadMaincourante();
  notify('Entrée rapide ajoutée');
}

function resetMainCouranteForm(){
  document.getElementById('mcDescription').value='';
  document.getElementById('mcLieu').value='';
  document.getElementById('mcDatetime').value = toLocalInput(new Date());
  document.getElementById('mcPriorite').value='normale';
  document.getElementById('mcType').value='Information';
}

function renderMainCourante(){
  const q = (document.getElementById('mcSearch')?.value||'').toLowerCase();
  const fp = document.getElementById('mcFiltrePoste')?.value||'';
  const ft = document.getElementById('mcFiltreType')?.value||'';
  const fpr = document.getElementById('mcFiltrePrio')?.value||'';

  const list = cache.mainCourante.filter(e=>{
    if(q && !(e.poste+e.agent+e.type+e.lieu+e.description).toLowerCase().includes(q)) return false;
    if(fp && e.poste!==fp) return false;
    if(ft && e.type!==ft) return false;
    if(fpr && e.priorite!==fpr) return false;
    if(!inDateRange(e.datetime,'mcDateDeb','mcDateFin')) return false;
    return true;
  });

  const dayStart = new Date(); dayStart.setHours(0,0,0,0);
  const day = cache.mainCourante.filter(e=>new Date(e.datetime).getTime()>=dayStart.getTime());
  const stats = document.getElementById('mcStats');
  if(stats) stats.innerHTML = `<div class="kpi-card info"><div class="kpi-label">Entrées (jour)</div><div class="kpi-value">${day.length}</div></div><div class="kpi-card warning"><div class="kpi-label">Importantes</div><div class="kpi-value">${day.filter(e=>e.priorite==='importante').length}</div></div><div class="kpi-card danger"><div class="kpi-label">Critiques</div><div class="kpi-value">${day.filter(e=>e.priorite==='critique').length}</div></div><div class="kpi-card success"><div class="kpi-label">Rondes (jour)</div><div class="kpi-value">${day.filter(e=>e.type==='Ronde').length}</div></div>`;

  const limite = Date.now()-8*3600*1000;
  const map = {};
  cache.mainCourante.filter(e=>new Date(e.datetime).getTime()>limite).forEach(e=>{
    const k=e.agent+'|'+e.poste;
    if(!map[k]) map[k]={agent:e.agent,poste:e.poste,count:0,lastSeen:e.datetime};
    map[k].count++;
    if(new Date(e.datetime)>new Date(map[k].lastSeen)) map[k].lastSeen=e.datetime;
  });
  const actifs = Object.values(map).sort((a,b)=>new Date(b.lastSeen)-new Date(a.lastSeen)).slice(0,6);
  const aaEl = document.getElementById('mcAgentsActifs');
  if(aaEl) aaEl.innerHTML = actifs.length===0 ? '<div class="empty-state" style="padding:14px">Aucun agent actif</div>' : actifs.map(a=>`<div class="agent-actif"><div class="avatar">${(a.agent||'?').charAt(0)}</div><div class="agent-actif-info"><strong>${escapeHtml(a.agent)}</strong><span>${escapeHtml(a.poste)} • ${fmtTime(a.lastSeen)}</span></div><span class="agent-actif-count">${a.count}</span></div>`).join('');

  const tl = document.getElementById('mcTimeline'); if(!tl) return;
  if(list.length===0){ tl.innerHTML='<div class="empty-state">Aucune entrée trouvée</div>'; return; }
  const groups = {};
  list.slice(0,300).forEach(e=>{
    const k = fmtDateLong(e.datetime);
    (groups[k] = groups[k]||[]).push(e);
  });
  tl.innerHTML = Object.entries(groups).map(([day,entries])=>`<div class="mc-day-header">📅 ${day} <span class="mc-day-count">${entries.length} entrée${entries.length>1?'s':''}</span></div>${entries.map(e=>{
    const cls = e.poste.startsWith('Rondier')?'rondier':(e.poste.includes('Chef')?'chef':'');
    const icons = {Information:'📋',Ronde:'🚶',Communication:'📞',Anomalie:'⚠️',Incident:'🚨',Intervention:'🛠️',Contrôle:'🔍',Relève:'🔄',Visite:'👥',Autre:'📝'};
    return `<div class="mc-entry priorite-${e.priorite}"><div class="mc-time"><strong>${fmtTime(e.datetime)}</strong>${fmtDayMonth(e.datetime)}</div><div class="mc-content"><div class="mc-head"><div class="mc-tags"><span class="mc-poste ${cls}">📍 ${escapeHtml(e.poste)}</span><span class="badge muted">${icons[e.type]||'📝'} ${escapeHtml(e.type)}</span>${e.priorite!=='normale'?`<span class="badge ${e.priorite==='critique'?'danger':'warning'}">${e.priorite}</span>`:''}</div><button class="btn btn-sm btn-outline admin-only" onclick="supprimerMC('${e.id}')">🗑️</button></div><div class="mc-desc">${escapeHtml(e.description)}</div><div class="mc-meta">👤 ${escapeHtml(e.agent)} • 📍 ${escapeHtml(e.lieu)}</div></div></div>`;
  }).join('')}`).join('');
}

async function supprimerMC(id){
  if(!await confirmModal('Supprimer cette entrée ?')) return;
  await API.del('/maincourante/'+id);
  await loadMaincourante();
}

function exportMainCouranteCSV(){
  let csv = 'Date;Heure;Poste;Agent;Type;Priorité;Lieu;Description\n';
  cache.mainCourante.forEach(e=>{
    const d = new Date(e.datetime);
    csv += `${d.toLocaleDateString('fr-FR')};${d.toLocaleTimeString('fr-FR')};${e.poste};${e.agent};${e.type};${e.priorite};${e.lieu};"${(e.description||'').replace(/"/g,'""')}"\n`;
  });
  download(csv, 'main-courante-'+new Date().toISOString().slice(0,10)+'.csv', 'text/csv');
  notify('Export CSV');
}

function download(content, filename, type){
  const blob = new Blob(['﻿'+content],{type:type+';charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}

/* ===== INCIDENTS ===== */
async function loadIncidents(){ await refresh('incidents'); renderIncidents(); }

function renderIncidents(){
  const q = document.getElementById('searchIncident').value.toLowerCase();
  const fs = document.getElementById('filtreIncidentStatut').value;
  const fg = document.getElementById('filtreIncidentGravite').value;
  const list = cache.incidents.filter(i=>{
    if(q && !(i.ref+i.type+i.lieu+i.agent).toLowerCase().includes(q)) return false;
    if(fs && i.statut!==fs) return false;
    if(fg && i.gravite!==fg) return false;
    if(!inDateRange(i.datetime,'incDateDeb','incDateFin')) return false;
    return true;
  });
  document.getElementById('incCritiques').textContent = cache.incidents.filter(i=>i.gravite==='critique'&&i.statut!=='resolu').length;
  document.getElementById('incMajeurs').textContent = cache.incidents.filter(i=>i.gravite==='majeur'&&i.statut!=='resolu').length;
  document.getElementById('incMineurs').textContent = cache.incidents.filter(i=>i.gravite==='mineur'&&i.statut!=='resolu').length;
  document.getElementById('incResolus').textContent = cache.incidents.filter(i=>i.statut==='resolu').length;
  const tbody = document.querySelector('#tableIncidents tbody');
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="8" class="empty-state">Aucun incident</td></tr>'; return; }
  tbody.innerHTML = list.map(i=>`<tr><td><strong>${i.ref}</strong></td><td>${fmtDateTime(i.datetime)}</td><td>${escapeHtml(i.type)}</td><td>${escapeHtml(i.lieu)}</td><td><span class="badge ${i.gravite==='critique'?'danger':(i.gravite==='majeur'?'warning':'info')}">${i.gravite}</span></td><td><span class="badge ${i.statut==='resolu'?'success':(i.statut==='encours'?'warning':'danger')}">${i.statut}</span></td><td>${escapeHtml(i.agent||'')}</td><td>${i.statut!=='resolu'?`<button class="btn btn-sm btn-success" onclick="resoudreIncident('${i.id}')">✓</button>`:''} <button class="btn btn-sm btn-outline" onclick="editIncident('${i.id}')">✏️</button> <button class="btn btn-sm btn-danger admin-only" onclick="deleteIncident('${i.id}')">🗑️</button></td></tr>`).join('');
}

function openIncidentModal(){
  showModal('Déclarer un incident',`
    <div class="form-row"><div class="form-group"><label>Type</label><select id="iType"><option>Tentative d'intrusion</option><option>Badge invalide</option><option>Véhicule non autorisé</option><option>Comportement suspect</option><option>Alarme déclenchée</option><option>Objet abandonné</option><option>Conflit interpersonnel</option><option>Autre</option></select></div><div class="form-group"><label>Gravité</label><select id="iGravite"><option value="mineur">Mineur</option><option value="majeur">Majeur</option><option value="critique">Critique</option></select></div></div>
    <div class="form-row"><div class="form-group"><label>Lieu</label><select id="iLieu"><option>Tourniquet Principal</option><option>Parking A</option><option>Parking B</option><option>Porte Nord</option><option>Quai logistique</option><option>Hall accueil</option><option>Périmètre Est</option><option>Bâtiment R&D</option></select></div><div class="form-group"><label>Agent</label><input type="text" id="iAgent" value="${API.getUser()?.nom_complet||'Agent PC'}"></div></div>
    <div class="form-row full"><div class="form-group"><label>Description</label><textarea id="iDesc"></textarea></div></div>
    <div class="form-row full"><div class="form-group"><label>Actions</label><textarea id="iActions"></textarea></div></div>
  `, async ()=>{
    await API.post('/incidents',{
      datetime:new Date().toISOString(),
      type:document.getElementById('iType').value,
      lieu:document.getElementById('iLieu').value,
      gravite:document.getElementById('iGravite').value,
      statut:'ouvert',
      agent:document.getElementById('iAgent').value,
      description:document.getElementById('iDesc').value,
      actions:document.getElementById('iActions').value
    });
    closeModal(); await loadIncidents(); notify('Incident enregistré');
  });
}

async function resoudreIncident(id){
  await API.put('/incidents/'+id,{statut:'resolu'});
  await loadIncidents(); notify('Incident résolu');
}

function editIncident(id){
  const i = cache.incidents.find(x=>x.id===id); if(!i) return;
  showModal('Mettre à jour '+i.ref,`
    <div class="form-row"><div class="form-group"><label>Statut</label><select id="incEditStatut"><option value="ouvert"${i.statut==='ouvert'?' selected':''}>Ouvert</option><option value="encours"${i.statut==='encours'?' selected':''}>En cours</option><option value="resolu"${i.statut==='resolu'?' selected':''}>Résolu</option></select></div><div class="form-group"><label>Gravité</label><input type="text" value="${escapeHtml(i.gravite)}" readonly></div></div>
    <div class="form-row full"><div class="form-group"><label>Actions / suite donnée</label><textarea id="incEditActions">${escapeHtml(i.actions||'')}</textarea></div></div>
  `, async ()=>{
    await API.put('/incidents/'+id,{statut:document.getElementById('incEditStatut').value,actions:document.getElementById('incEditActions').value});
    closeModal(); await loadIncidents(); notify('Incident mis à jour');
  });
}

async function deleteIncident(id){
  if(!await confirmModal('Supprimer cet incident ?')) return;
  await API.del('/incidents/'+id);
  await loadIncidents();
  notify('Incident supprimé');
}

/* ===== VEHICULES ===== */
async function loadVehicules(){ await refresh('vehicules'); renderVehicules(); }

function renderVehicules(){
  const q = document.getElementById('searchVehicule').value.toLowerCase();
  const ft = document.getElementById('filtreVehiculeType').value;
  const fs = document.getElementById('filtreVehiculeStatut').value;
  const list = cache.vehicules.filter(v=>{
    if(q && !((v.plaque||'')+(v.conducteur||'')+(v.societe||'')).toLowerCase().includes(q)) return false;
    if(ft && v.type!==ft) return false;
    if(fs && v.statut!==fs) return false;
    if(!inDateRange(v.entree,'vehDateDeb','vehDateFin')) return false;
    return true;
  });
  const tbody = document.querySelector('#tableVehicules tbody');
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="9" class="empty-state">Aucun véhicule</td></tr>'; return; }
  tbody.innerHTML = list.map(v=>`<tr><td><strong>${v.plaque}</strong></td><td><span class="badge muted">${v.type}</span></td><td>${escapeHtml(v.conducteur||'')}</td><td>${escapeHtml(v.societe||'')}</td><td>${escapeHtml(v.motif||'')}</td><td>${fmtDateTime(v.entree)}</td><td>${v.sortie?fmtDateTime(v.sortie):'<span class="badge warning">Sur site</span>'}</td><td><span class="badge ${v.statut==='dans'?'success':'info'}">${v.statut==='dans'?'Sur site':'Sorti'}</span></td><td>${v.statut==='dans'?`<button class="btn btn-sm btn-outline" onclick="sortirVehicule('${v.id}')">↗️</button>`:''} <button class="btn btn-sm btn-danger admin-only" onclick="deleteVehicule('${v.id}')">🗑️</button></td></tr>`).join('');
}

function openVehiculeModal(mode){
  if(mode==='entree'){
    showModal('Entrée véhicule',`
      <div class="form-row"><div class="form-group"><label>Plaque</label><input type="text" id="vPlaque" placeholder="Ex: 123456-114-16" style="text-transform:uppercase"></div><div class="form-group"><label>Type</label><select id="vType"><option value="VL">VL</option><option value="PL">PL</option><option value="utilitaire">Utilitaire</option><option value="2R">2R</option></select></div></div>
      <div class="form-row"><div class="form-group"><label>Conducteur</label><input type="text" id="vCond"></div><div class="form-group"><label>Société</label><input type="text" id="vSoc"></div></div>
      <div class="form-row"><div class="form-group"><label>Motif</label><select id="vMotif"><option>Livraison</option><option>Visite</option><option>Maintenance</option><option>Personnel</option></select></div><div class="form-group"><label>Place</label><input type="text" id="vPlace" placeholder="Ex: A12"></div></div>
    `, async ()=>{
      const plaque = document.getElementById('vPlaque').value;
      if(!plaque) return alert('Plaque requise');
      await API.post('/vehicules',{plaque,type:document.getElementById('vType').value,conducteur:document.getElementById('vCond').value,societe:document.getElementById('vSoc').value,motif:document.getElementById('vMotif').value,placeParking:document.getElementById('vPlace').value});
      closeModal(); await loadVehicules(); notify('Entrée enregistrée');
    });
  } else {
    const dans = cache.vehicules.filter(v=>v.statut==='dans');
    showModal('Sortie véhicule',`<div class="form-row full"><div class="form-group"><label>Véhicule</label><select id="vSelSortie">${dans.map(v=>`<option value="${v.id}">${v.plaque} — ${v.conducteur||''}</option>`).join('')}</select></div></div>`,async ()=>{
      await sortirVehicule(document.getElementById('vSelSortie').value); closeModal();
    });
  }
}

async function sortirVehicule(id){
  await API.put('/vehicules/'+id+'/sortie');
  await loadVehicules(); notify('Sortie enregistrée');
}

async function deleteVehicule(id){
  if(!await confirmModal('Supprimer ce mouvement véhicule ?')) return;
  await API.del('/vehicules/'+id);
  await loadVehicules();
  notify('Véhicule supprimé');
}

/* ===== LAPI ===== */
let lapiStream = null, lapiAutoTimer = null, lapiOcrBusy = false, lapiLastSnapshot = null;
let lapiTransform = { rotate: 0, mirror: false };
let lapiIpMode = false, lapiIpTimer = null, lapiActiveEl = null;  // caméra IP réseau

/* Rotation / miroir (webcam ou caméra IP fixe → on tourne l'image) */
function appliquerTransformVideo(){
  const t = `rotate(${lapiTransform.rotate}deg)` + (lapiTransform.mirror?' scaleX(-1)':'');
  const video = document.getElementById('lapiVideo');
  const ipimg = document.getElementById('lapiIpImg');
  if(video) video.style.transform = t;
  if(ipimg) ipimg.style.transform = t;
}
function pivoterCamera(){ lapiTransform.rotate = (lapiTransform.rotate + 90) % 360; appliquerTransformVideo(); }
function basculerMiroir(){ lapiTransform.mirror = !lapiTransform.mirror; appliquerTransformVideo(); }

/* Dessine la source (vidéo OU image IP) dans un canvas avec rotation + miroir
   (pour que l'OCR reçoive exactement l'image affichée) */
function dessinerFluxTransforme(srcEl, canvas){
  const vw = srcEl.videoWidth || srcEl.naturalWidth || srcEl.width;
  const vh = srcEl.videoHeight || srcEl.naturalHeight || srcEl.height;
  const rot = ((lapiTransform.rotate % 360) + 360) % 360;
  const swap = (rot === 90 || rot === 270);
  canvas.width  = swap ? vh : vw;
  canvas.height = swap ? vw : vh;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width/2, canvas.height/2);
  ctx.rotate(rot * Math.PI/180);
  if(lapiTransform.mirror) ctx.scale(-1,1);
  ctx.drawImage(srcEl, -vw/2, -vh/2, vw, vh);
  ctx.restore();
}

/* ---- Caméras IP réseau (sur site) ----
 * PG-30 (correctif de sécurité) : jusqu'ici, chaque caméra (adresse,
 * identifiants) était enregistrée en clair dans le localStorage du
 * navigateur et transmise telle quelle au proxy serveur (?src=<url
 * arbitraire>) — le serveur allait alors chercher N'IMPORTE QUELLE adresse
 * réseau fournie par le client, sans authentification (une SSRF non
 * authentifiée, voir docs/camera-proxy.md et docs/security-hardening.md).
 * La liste des caméras est désormais une configuration SERVEUR
 * (backend/camera-registry.js, gérée par un opérateur, jamais par une
 * saisie utilisateur) : le navigateur ne connaît plus jamais d'URL ni
 * d'identifiant de caméra, seulement un camera_id opaque et son nom.
 */
let ipCamsCache = []; // [{id, name, type}] — jamais url/user/pass, voir plus haut
async function loadIpCams(){
  try { ipCamsCache = await API.get('/camera/list'); }
  catch { ipCamsCache = []; }
  return ipCamsCache;
}
// Ticket à usage unique (PG-12/PG-30) : une <img>/<video> ne peut pas
// envoyer d'en-tête Authorization, d'où ce jeton de courte durée de vie,
// obtenu via un appel authentifié normal et consommé une seule fois par
// le proxy — jamais réutilisable, jamais valable pour une autre caméra.
async function ipSourceUrl(camId, bust){
  const { ticket } = await API.post('/camera/ticket', { camera_id: camId });
  const cam = ipCamsCache.find(c => c.id === camId);
  const p = new URLSearchParams({ camera_id: camId, ticket });
  const endpoint = cam?.type === 'rtsp' ? '/api/camera/stream' : '/api/camera/proxy';
  if(bust && cam?.type !== 'rtsp') p.set('_ts', Date.now());
  return endpoint + '?' + p.toString();
}

/* Liste les caméras : webcams/USB (auto) + caméras IP configurées côté serveur. */
async function remplirListeCameras(){
  const sel = document.getElementById('lapiCameraSelect');
  if(!sel) return;
  const current = sel.value;
  let usb = [];
  try{
    const devs = await navigator.mediaDevices.enumerateDevices();
    usb = devs.filter(x=>x.kind==='videoinput');
  }catch{}
  const usbOpts = usb.map((c,i)=>`<option value="${c.deviceId}">${c.label||'Caméra '+(i+1)}</option>`).join('');
  await loadIpCams();
  const ipOpts = ipCamsCache.map(c=>`<option value="ip:${escapeHtml(c.id)}">📡 ${escapeHtml(c.name)}</option>`).join('');
  sel.innerHTML = (usb.length===0 && !ipOpts ? '<option value="">Aucune caméra</option>' : usbOpts + ipOpts);
  if(current && [...sel.options].some(o=>o.value===current)) sel.value = current;
}

let lapiDeviceListenerAdded = false;
async function loadLapi(){
  await refresh('lapi');
  if(navigator.mediaDevices?.enumerateDevices){
    remplirListeCameras();
    if(!lapiDeviceListenerAdded){
      // mise à jour auto quand une caméra USB est branchée/débranchée
      navigator.mediaDevices.addEventListener?.('devicechange', remplirListeCameras);
      lapiDeviceListenerAdded = true;
    }
  }
  renderLapiHistory(); renderLapiTable();
}

function setLapiBanner(msg, type='info'){
  const b = document.getElementById('lapiBanner');
  b.className='lapi-status-banner '+type; b.innerHTML = msg;
}

async function activerCamera(){
  if(!navigator.mediaDevices?.getUserMedia){ setLapiBanner('⚠️ Navigateur non supporté','warning'); return; }
  try{
    const sel = document.getElementById('lapiCameraSelect');
    const deviceId = sel?.value;
    const constraints = { video: deviceId ? {deviceId:{exact:deviceId},width:{ideal:1280},height:{ideal:720}} : {facingMode:'environment',width:{ideal:1280},height:{ideal:720}}, audio:false };
    lapiStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('lapiVideo');
    video.srcObject = lapiStream;
    video.style.display='block';
    lapiIpMode = false; lapiActiveEl = video;
    document.getElementById('lapiIpImg').style.display='none';
    appliquerTransformVideo();
    remplirListeCameras();   // les noms de caméras sont dispo après la permission
    document.getElementById('lapiPlaceholder').style.display='none';
    document.getElementById('lapiSnapshot').style.display='none';
    document.getElementById('lapiOverlay').style.display='flex';
    document.getElementById('lapiStatus').style.display='flex';
    document.getElementById('btnActivateCam').style.display='none';
    document.getElementById('btnStopCam').style.display='inline-flex';
    document.getElementById('btnCapture').disabled=false;
    setLapiBanner('✅ Caméra active. Visez la plaque puis CAPTURER.','success');
  } catch(e){
    setLapiBanner('❌ '+e.message,'danger');
  }
}

function arreterCamera(){
  if(lapiStream){ lapiStream.getTracks().forEach(t=>t.stop()); lapiStream=null; }
  if(lapiAutoTimer){ clearInterval(lapiAutoTimer); lapiAutoTimer=null; }
  if(lapiIpTimer){ clearInterval(lapiIpTimer); lapiIpTimer=null; }
  lapiIpMode = false; lapiActiveEl = null;
  const auto = document.getElementById('lapiAuto'); if(auto) auto.checked=false;
  const ip = document.getElementById('lapiIpImg'); if(ip){ ip.src=''; ip.style.display='none'; }
  document.getElementById('lapiVideo').style.display='none';
  document.getElementById('lapiOverlay').style.display='none';
  document.getElementById('lapiStatus').style.display='none';
  document.getElementById('lapiPlaceholder').style.display='block';
  document.getElementById('btnActivateCam').style.display='inline-flex';
  document.getElementById('btnStopCam').style.display='none';
  document.getElementById('btnCapture').disabled = !lapiLastSnapshot;
  setLapiBanner('📷 Caméra arrêtée.','info');
}

/* Bouton « Activer » / changement dans la liste : aiguille vers webcam ou IP */
function activerCameraSelection(){
  const v = document.getElementById('lapiCameraSelect')?.value || '';
  if(v.startsWith('ip:')) return activerCameraIp(v.slice(3));
  return activerCamera();
}
function changerCamera(){
  arreterCamera();
  setTimeout(activerCameraSelection, 150);
}

/* Connecte une caméra IP via le proxy serveur (PG-30 : camera_id + ticket
 * obtenus du serveur — plus jamais d'URL/identifiant côté client, voir
 * ipSourceUrl ci-dessus et docs/camera-proxy.md). L'ajout/suppression de
 * caméras IP n'est plus une action utilisateur : la liste vient
 * exclusivement de la configuration serveur (backend/camera-registry.js),
 * gérée par un opérateur — cette fonctionnalité en libre-service était la
 * cause racine de la faille SSRF corrigée en PG-30. */
async function activerCameraIp(camId){
  const cam = ipCamsCache.find(c => c.id === camId);
  if(!cam) return;
  arreterCamera();
  const img = document.getElementById('lapiIpImg');
  lapiIpMode = true; lapiActiveEl = img;
  document.getElementById('lapiVideo').style.display='none';
  img.onerror = () => setLapiBanner("❌ Caméra IP injoignable. Vérifiez le réseau ou contactez l'administrateur.",'danger');
  const afficher = () => {
    img.style.display='block';
    document.getElementById('lapiPlaceholder').style.display='none';
    document.getElementById('lapiSnapshot').style.display='none';
    document.getElementById('lapiOverlay').style.display='flex';
    document.getElementById('lapiStatus').style.display='flex';
    document.getElementById('btnActivateCam').style.display='none';
    document.getElementById('btnStopCam').style.display='inline-flex';
    document.getElementById('btnCapture').disabled=false;
  };
  appliquerTransformVideo();
  try {
    if(cam.type === 'rtsp'){
      img.src = await ipSourceUrl(camId, false);   // MJPEG converti par ffmpeg
      afficher();
      setLapiBanner(`✅ Caméra IP « ${cam.name} » (RTSP) — conversion en cours…`,'success');
    } else if(cam.streamMode === 'mjpeg'){
      img.src = await ipSourceUrl(camId, false);   // flux MJPEG continu
      afficher();
      setLapiBanner(`✅ Caméra IP « ${cam.name} » (MJPEG) connectée.`,'success');
    } else {
      const tick = async () => { img.src = await ipSourceUrl(camId, true); };
      await tick(); afficher();
      lapiIpTimer = setInterval(tick, 900);   // rafraîchit le snapshot ~1s (nouveau ticket à chaque fois : usage unique)
      setLapiBanner(`✅ Caméra IP « ${cam.name} » (snapshot) connectée.`,'success');
    }
  } catch(e) {
    setLapiBanner('❌ '+(e.message||"Caméra injoignable"),'danger');
  }
}

document.addEventListener('change', e=>{
  if(e.target?.id==='lapiAuto'){
    if(e.target.checked){
      if(!lapiStream && !lapiIpMode){ alert('Activez d\'abord la caméra'); e.target.checked=false; return; }
      lapiAutoTimer = setInterval(capturerPlaque,3000);
      setLapiBanner('🔄 Capture auto toutes les 3 s.','info');
    } else if(lapiAutoTimer){ clearInterval(lapiAutoTimer); lapiAutoTimer=null; }
  }
});

function chargerImage(ev){
  const f = ev.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = e=>{
    const img = document.getElementById('lapiSnapshot');
    img.src = e.target.result; img.style.display='block';
    document.getElementById('lapiPlaceholder').style.display='none';
    document.getElementById('lapiVideo').style.display='none';
    document.getElementById('lapiOverlay').style.display='none';
    document.getElementById('lapiStatus').style.display='none';
    lapiLastSnapshot = e.target.result;
    document.getElementById('btnCapture').disabled=false;
    setLapiBanner('📂 Image chargée. Cliquez CAPTURER.','info');
  };
  r.readAsDataURL(f); ev.target.value='';
}

async function capturerPlaque(){
  if(lapiOcrBusy) return;
  const canvas = document.getElementById('lapiCanvas');
  const snapImg = document.getElementById('lapiSnapshot');
  const srcEl = lapiActiveEl;   // webcam (<video>) ou caméra IP (<img>)
  const srcW = srcEl ? (srcEl.videoWidth || srcEl.naturalWidth || 0) : 0;
  let dataUrl;
  if((lapiStream || lapiIpMode) && srcEl && srcW>0){
    dessinerFluxTransforme(srcEl, canvas);   // applique rotation + miroir
    const cw = canvas.width*0.7, ch = canvas.height*0.3;
    const cropC = document.createElement('canvas');
    cropC.width=cw; cropC.height=ch;
    cropC.getContext('2d').drawImage(canvas,(canvas.width-cw)/2,(canvas.height-ch)/2,cw,ch,0,0,cw,ch);
    enhanceForOCR(cropC.getContext('2d'),cw,ch);
    dataUrl = cropC.toDataURL('image/jpeg',0.92);
    lapiLastSnapshot = dataUrl; snapImg.src = dataUrl;
  } else if(lapiLastSnapshot) {
    dataUrl = lapiLastSnapshot;
  } else { alert('Activez la caméra'); return; }

  const frame = document.getElementById('lapiFrame');
  frame.style.transition='filter .1s'; frame.style.filter='brightness(2)';
  setTimeout(()=>frame.style.filter='none',120);

  lapiOcrBusy = true;
  document.getElementById('btnCapture').disabled=true;
  document.getElementById('lapiOCRBadge').textContent='Analyse en cours…';
  document.getElementById('lapiOCRBadge').className='badge warning';
  setLapiBanner('🔍 Analyse OCR…','info');

  try{
    const worker = await getOcrWorker();
    await worker.setParameters({ tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-', tessedit_pageseg_mode:'7' });
    const { data } = await worker.recognize(dataUrl);
    afficherResultatOCR(data, dataUrl);
  } catch(e){
    setLapiBanner('❌ Erreur OCR : '+e.message,'danger');
    document.getElementById('lapiOCRBadge').textContent='Erreur';
    document.getElementById('lapiOCRBadge').className='badge danger';
  } finally{
    lapiOcrBusy = false;
    document.getElementById('btnCapture').disabled=false;
  }
}

/* Worker OCR Tesseract — 100% local (worker + cœur WASM + langue embarqués).
   Chemins absolus calculés depuis la page (marche en http LAN et sous Electron). */
let _ocrWorker = null;
async function getOcrWorker(){
  if(_ocrWorker) return _ocrWorker;
  const base = new URL('vendor/tesseract/', document.baseURI).href;
  _ocrWorker = await Tesseract.createWorker('eng', 1, {
    workerPath: base + 'worker.min.js',
    corePath:   base,           // dossier : Tesseract choisit le bon .wasm (SIMD/LSTM)
    langPath:   base + 'lang',  // contient eng.traineddata.gz
    workerBlobURL: false,
  });
  return _ocrWorker;
}

function enhanceForOCR(ctx,w,h){
  try{
    const d = ctx.getImageData(0,0,w,h); const a = d.data;
    for(let i=0;i<a.length;i+=4){
      const g = 0.299*a[i]+0.587*a[i+1]+0.114*a[i+2];
      const v = g>128 ? Math.min(255,g*1.2) : Math.max(0,g*0.8);
      a[i]=a[i+1]=a[i+2]=v;
    }
    ctx.putImageData(d,0,0);
  } catch{}
}

function extrairePlaque(text){
  if(!text) return null;
  const c = text.replace(/\s+/g,'').replace(/[^A-Z0-9-]/g,'');
  // Plaque algérienne (immatriculation depuis 2009) : NNNNNN-CAA-WW — numéro
  // de série (jusqu'à 6 chiffres), catégorie de véhicule + 2 derniers
  // chiffres de l'année d'immatriculation, puis code de wilaya (01 à 58,
  // aucune lettre) — testée en priorité, avant les anciens formats français.
  let m = c.match(/(\d{4,6})-?(\d{3})-?(0[1-9]|[1-4]\d|5[0-8])$/);
  if(m) return m[1]+'-'+m[2]+'-'+m[3];
  m = c.match(/([A-HJ-NP-Z]{2})-?(\d{3})-?([A-HJ-NP-Z]{2})/);
  if(m) return m[1]+'-'+m[2]+'-'+m[3];
  m = c.match(/(\d{1,4})([A-Z]{1,3})(\d{2,3})/);
  if(m) return m[1]+' '+m[2]+' '+m[3];
  if(c.length>=5 && c.length<=10 && /[A-Z]/.test(c) && /\d/.test(c)) return c;
  return null;
}

async function afficherResultatOCR(data, dataUrl){
  const raw = (data.text||'').toUpperCase();
  const conf = Math.round(data.confidence||0);
  const detected = extrairePlaque(raw);

  document.getElementById('lapiPlateText').textContent = detected || (raw.replace(/[^A-Z0-9-]/g,'').slice(0,12) || '— Non détecté —');
  document.getElementById('lapiPlateText').classList.toggle('empty',!detected);
  document.getElementById('lapiPlateEdit').value = detected || raw.replace(/[^A-Z0-9-]/g,'');
  document.getElementById('lapiConfidenceVal').textContent = conf+'%';
  const bar = document.getElementById('lapiConfidenceBar');
  bar.style.width = conf+'%';
  bar.className = 'confidence-fill '+(conf>75?'':conf>50?'medium':'low');
  const ocrBadge = document.getElementById('lapiOCRBadge');
  if(detected){
    ocrBadge.textContent='Plaque détectée'; ocrBadge.className='badge success';
    setLapiBanner('✅ Plaque : <strong>'+detected+'</strong> (conf. '+conf+'%)','success');
  } else {
    ocrBadge.textContent='Format non reconnu'; ocrBadge.className='badge warning';
    setLapiBanner('⚠️ Format non reconnu. Texte : <code>'+escapeHtml(raw.trim())+'</code>','warning');
  }
  rechercheVehicule(detected || document.getElementById('lapiPlateEdit').value);
  await API.post('/lapi',{datetime:new Date().toISOString(),plaqueDetectee:detected||'?',plaqueRaw:raw.trim(),confiance:conf,image:dataUrl,statut:detected?'detecte':'incertain'});
  await refresh('lapi');
  renderLapiHistory(); renderLapiTable();
}

function rechercheVehicule(plaque){
  const info = document.getElementById('lapiVehiculeInfo');
  if(!plaque || plaque==='?'){ info.innerHTML=''; return; }
  const norm = p => (p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const v = cache.vehicules.find(x=>norm(x.plaque)===norm(plaque));
  if(v){
    const surSite = v.statut==='dans';
    info.innerHTML = `<div class="alert-item ${surSite?'success':''}"><div class="alert-content"><div class="alert-title">✅ Véhicule connu — ${v.plaque}</div><div class="alert-meta">${escapeHtml(v.conducteur||'?')} • ${escapeHtml(v.societe||'')} • Type ${v.type}</div><div class="alert-meta" style="margin-top:4px"><span class="badge ${surSite?'success':'muted'}">${surSite?'Sur site':'Sorti'}</span></div></div></div>`;
    document.getElementById('lapiType').value = v.type;
    document.getElementById('lapiConducteur').value = v.conducteur||'';
    document.getElementById('lapiMotif').value = v.motif||'Visite';
  } else {
    info.innerHTML = `<div class="alert-item warning"><div class="alert-content"><div class="alert-title">⚠️ Véhicule inconnu</div><div class="alert-meta">Aucune correspondance.</div></div></div>`;
  }
}

async function lapiEntree(){
  const plaque = document.getElementById('lapiPlateEdit').value.trim().toUpperCase();
  if(!plaque) return alert('Plaque vide');
  await API.post('/vehicules',{plaque,type:document.getElementById('lapiType').value,conducteur:document.getElementById('lapiConducteur').value,motif:document.getElementById('lapiMotif').value,lapiPhoto:lapiLastSnapshot});
  if(cache.lapiLectures[0]) await API.put('/lapi/'+cache.lapiLectures[0].id,{statut:'valide',action:'entree'});
  await ajouterMCAuto('Contrôle','Entrée véhicule '+plaque+' (LAPI)','normale');
  setLapiBanner('✅ Entrée enregistrée — '+plaque,'success'); notify('Entrée LAPI : '+plaque);
  await refresh('lapi'); await refresh('vehicules');
  renderLapiTable(); renderLapiHistory();
}

async function lapiSortie(){
  const plaque = document.getElementById('lapiPlateEdit').value.trim().toUpperCase();
  if(!plaque) return alert('Plaque vide');
  const norm = p => p.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const v = cache.vehicules.find(x=>norm(x.plaque)===norm(plaque) && x.statut==='dans');
  if(!v) return alert('Aucun véhicule '+plaque+' sur site');
  await API.put('/vehicules/'+v.id+'/sortie');
  if(cache.lapiLectures[0]) await API.put('/lapi/'+cache.lapiLectures[0].id,{statut:'valide',action:'sortie'});
  await ajouterMCAuto('Contrôle','Sortie véhicule '+plaque+' (LAPI)','normale');
  setLapiBanner('✅ Sortie enregistrée — '+plaque,'success'); notify('Sortie LAPI : '+plaque);
  await refresh('vehicules'); renderLapiTable();
}

async function lapiAlerter(){
  const plaque = document.getElementById('lapiPlateEdit').value.trim().toUpperCase();
  if(!plaque) return alert('Plaque vide');
  await API.post('/incidents',{datetime:new Date().toISOString(),type:'Véhicule non autorisé',lieu:'Tourniquet véhicule',gravite:'majeur',statut:'ouvert',agent:API.getUser()?.nom_complet||'Agent LAPI',description:'Véhicule '+plaque+' refusé (LAPI)',actions:'Refoulement.'});
  if(cache.lapiLectures[0]) await API.put('/lapi/'+cache.lapiLectures[0].id,{statut:'refuse',action:'refus'});
  await ajouterMCAuto('Incident','Refus véhicule '+plaque+' (LAPI). Incident ouvert.','importante');
  setLapiBanner('🚨 Alerte créée — '+plaque,'danger'); notify('Alerte : '+plaque);
  await refresh('lapi'); renderLapiTable();
}

async function ajouterMCAuto(type, desc, prio){
  await API.post('/maincourante',{datetime:new Date().toISOString(),poste:sessionStorage.getItem('lastPoste')||'PC Sûreté',agent:sessionStorage.getItem('lastAgent')||API.getUser()?.nom_complet||'Système LAPI',type,lieu:'Tourniquet véhicule',description:desc,priorite:prio});
}

function resetLapi(){
  document.getElementById('lapiPlateText').textContent='— Aucune plaque —';
  document.getElementById('lapiPlateText').classList.add('empty');
  document.getElementById('lapiPlateEdit').value='';
  document.getElementById('lapiConducteur').value='';
  document.getElementById('lapiVehiculeInfo').innerHTML='';
  document.getElementById('lapiConfidenceVal').textContent='0%';
  document.getElementById('lapiConfidenceBar').style.width='0%';
  document.getElementById('lapiOCRBadge').textContent='En attente';
  document.getElementById('lapiOCRBadge').className='badge muted';
  setLapiBanner('📷 Prêt pour une nouvelle capture.','info');
}

function renderLapiHistory(){
  const c = document.getElementById('lapiHistoryThumbs'); const e = document.getElementById('lapiHistoryEmpty');
  if(!c) return;
  const list = (cache.lapiLectures||[]).slice(0,12);
  if(list.length===0){ c.innerHTML=''; e.style.display='block'; return; }
  e.style.display='none';
  // PG-25 (hardening) : image/plaque_detectee viennent de POST /lapi sans
  // validation serveur (texte libre) — escapeHtml() partout, y compris dans
  // l'attribut src (neutralise un guillemet qui casserait l'attribut).
  c.innerHTML = list.map(l=>`<div class="captured-thumb" onclick="rechargerLecture('${l.id}')"><img src="${escapeHtml(l.image||'')}" alt=""><div class="plate-tag">${escapeHtml(l.plaque_detectee||'?')}</div></div>`).join('');
}

function rechargerLecture(id){
  const l = (cache.lapiLectures||[]).find(x=>x.id===id);
  if(!l) return;
  document.getElementById('lapiSnapshot').src = l.image; document.getElementById('lapiSnapshot').style.display='block';
  document.getElementById('lapiVideo').style.display='none';
  document.getElementById('lapiPlaceholder').style.display='none';
  document.getElementById('lapiOverlay').style.display='none';
  lapiLastSnapshot = l.image;
  const plaque = l.plaque_detectee==='?' ? l.plaque_raw : l.plaque_detectee;
  document.getElementById('lapiPlateEdit').value = plaque;
  document.getElementById('lapiPlateText').textContent = plaque||'—';
  document.getElementById('lapiPlateText').classList.toggle('empty',!plaque||plaque==='?');
  document.getElementById('lapiConfidenceVal').textContent = l.confiance+'%';
  document.getElementById('lapiConfidenceBar').style.width = l.confiance+'%';
  rechercheVehicule(plaque);
  setLapiBanner('🔄 Lecture rechargée du '+fmtDateTime(l.datetime),'info');
}

function renderLapiTable(){
  const tbody = document.querySelector('#tableLapi tbody'); if(!tbody) return;
  const list = cache.lapiLectures||[];
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="6" class="empty-state">Aucune lecture</td></tr>'; return; }
  // PG-25 (hardening) : toutes ces valeurs viennent de POST /lapi sans
  // validation serveur (texte libre) — escapeHtml() partout.
  tbody.innerHTML = list.map(l=>`<tr><td>${fmtDateTime(l.datetime)}</td><td><strong>${escapeHtml(l.plaque_detectee||'?')}</strong></td><td>${escapeHtml(String(l.confiance ?? ''))}%</td><td><span class="badge ${l.statut==='valide'?'success':(l.statut==='refuse'?'danger':(l.statut==='detecte'?'info':'warning'))}">${escapeHtml(l.statut||'')}</span></td><td>${l.action?'<span class="badge muted">'+escapeHtml(l.action)+'</span>':'—'}</td><td><button class="btn btn-sm btn-outline" onclick="rechargerLecture('${l.id}')">👁️</button></td></tr>`).join('');
}

async function clearLapiHistory(){
  if(!await confirmModal('Vider l\'historique LAPI ?')) return;
  await API.del('/lapi'); await refresh('lapi');
  renderLapiHistory(); renderLapiTable();
}

/* ===== PIETONS ===== */
async function loadPietons(){ await refresh('pietons'); renderPietons(); }

async function refreshPointagesViews(){
  await refresh('pietons');
  if(document.getElementById('page-pietons')?.classList.contains('active')) renderPietons();
  if(document.getElementById('adminDashboardCard')?.style.display !== 'none') renderAdminPointages();
}

function renderPietons(){
  const q = document.getElementById('searchPieton').value.toLowerCase();
  const fa = document.getElementById('filtrePietonAcces').value;
  const fp = document.getElementById('filtrePietonPoint').value;
  const list = cache.pietons.filter(p=>{
    if(q && !((p.nom||'')+(p.badge||'')+(p.point||'')).toLowerCase().includes(q)) return false;
    if(fa==='entree' && p.sens!=='entree') return false;
    if(fa==='sortie' && p.sens!=='sortie') return false;
    if(fa==='refus' && p.resultat!=='refus') return false;
    if(fp && p.point!==fp) return false;
    if(!inDateRange(p.datetime,'pieDateDeb','pieDateFin')) return false;
    return true;
  });
  const last24 = cache.pietons.filter(p=>Date.now()-new Date(p.datetime)<24*3600*1000);
  document.getElementById('pietonEnt').textContent = last24.filter(p=>p.sens==='entree'&&p.resultat!=='refus').length;
  document.getElementById('pietonSort').textContent = last24.filter(p=>p.sens==='sortie'&&p.resultat!=='refus').length;
  document.getElementById('pietonRef').textContent = last24.filter(p=>p.resultat==='refus').length;
  document.getElementById('pietonSusp').textContent = cache.incidents.filter(i=>i.statut!=='resolu'&&(i.type.includes('intrusion')||i.type.includes('suspect'))).length;
  const tbody = document.querySelector('#tablePietons tbody');
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="9" class="empty-state">Aucun passage</td></tr>'; return; }
  tbody.innerHTML = list.slice(0,200).map(p=>`<tr><td>${fmtDateTime(p.datetime)}</td><td>${escapeHtml(p.nom)}</td><td><code>${escapeHtml(p.badge||'')}</code></td><td><span class="badge ${p.type==='Employé'?'info':'muted'}">${p.type}</span></td><td>${escapeHtml(p.point)}</td><td>${p.sens==='entree'?'➡️ Entrée':'⬅️ Sortie'}</td><td><span class="badge ${p.resultat==='autorise'?'success':'danger'}">${p.resultat==='autorise'?'Autorisé':'Refusé'}</span></td><td>${escapeHtml(p.notes||'')}</td><td><button class="btn btn-sm btn-outline admin-only" onclick="editPieton('${p.id}')">✏️</button> <button class="btn btn-sm btn-danger admin-only" onclick="deletePieton('${p.id}')">🗑️</button></td></tr>`).join('');
}

function openPietonModal(existing){
  const isEdit = !!existing;
  showModal(isEdit ? 'Modifier le pointage' : 'Saisir un passage',`
    <div class="form-row"><div class="form-group"><label>Date / Heure</label><input type="datetime-local" id="pDatetime" value="${isEdit?toDatetimeLocal(existing.datetime):toDatetimeLocal(new Date().toISOString())}"></div></div>
    <div class="form-row"><div class="form-group"><label>Nom</label><input type="text" id="pNom" value="${isEdit?escapeHtml(existing.nom||''):''}"></div><div class="form-group"><label>Badge</label><input type="text" id="pBadge" value="${isEdit?escapeHtml(existing.badge||''):''}"></div></div>
    <div class="form-row"><div class="form-group"><label>Type</label><select id="pTypePers"><option${isEdit&&existing.type==='Employé'?' selected':''}>Employé</option><option${isEdit&&existing.type==='Visiteur'?' selected':''}>Visiteur</option><option${isEdit&&existing.type==='Prestataire'?' selected':''}>Prestataire</option></select></div><div class="form-group"><label>Point</label><select id="pPoint"><option${isEdit&&existing.point==='Tourniquet Principal'?' selected':''}>Tourniquet Principal</option><option${isEdit&&existing.point==='Porte Nord'?' selected':''}>Porte Nord</option><option${isEdit&&existing.point==='Porte Sud'?' selected':''}>Porte Sud</option><option${isEdit&&existing.point==='Sas Visiteurs'?' selected':''}>Sas Visiteurs</option></select></div></div>
    <div class="form-row"><div class="form-group"><label>Sens</label><select id="pSens"><option value="entree"${isEdit&&existing.sens==='entree'?' selected':''}>Entrée</option><option value="sortie"${isEdit&&existing.sens==='sortie'?' selected':''}>Sortie</option></select></div><div class="form-group"><label>Résultat</label><select id="pRes"><option value="autorise"${isEdit&&existing.resultat==='autorise'?' selected':''}>Autorisé</option><option value="refus"${isEdit&&existing.resultat==='refus'?' selected':''}>Refus</option></select></div></div>
    <div class="form-row full"><div class="form-group"><label>Notes</label><textarea id="pNotes">${isEdit?escapeHtml(existing.notes||''):''}</textarea></div></div>
  `, async ()=>{
    const payload = {datetime:new Date(document.getElementById('pDatetime').value).toISOString(),nom:document.getElementById('pNom').value,badge:document.getElementById('pBadge').value,type:document.getElementById('pTypePers').value,point:document.getElementById('pPoint').value,sens:document.getElementById('pSens').value,resultat:document.getElementById('pRes').value,notes:document.getElementById('pNotes').value};
    if(isEdit){ await API.put('/pietons/'+existing.id,payload); notify('Pointage modifié'); }
    else{ await API.post('/pietons',payload); notify('Passage enregistré'); }
    closeModal(); await refreshPointagesViews();
  });
}

// PG-25 (hardening) : prenait auparavant l'enregistrement entier, sérialisé
// tel quel dans un attribut onclick délimité par des guillemets simples —
// nom/point/notes étant du texte libre non validé (POST /pietons), un
// simple guillemet simple dans l'un de ces champs cassait l'attribut et
// permettait d'injecter du HTML/JS arbitraire — XSS stockée exécutée dans
// le navigateur de quiconque affiche ce tableau (souvent un compte admin).
// Même motif que editIncident/deleteVehicule/etc. partout ailleurs dans ce
// fichier : ne transporter qu'un identifiant opaque (jamais du texte
// libre) dans un attribut HTML, et relire l'enregistrement depuis le
// cache déjà chargé.
function editPieton(id){ const p=(cache.pietons||[]).find(x=>x.id===id); if(!p) return; openPietonModal(p); }

async function deletePieton(id){
  if(!await confirmModal('Supprimer ce passage ?')) return;
  await API.del('/pietons/'+id);
  await refreshPointagesViews();
  notify('Passage supprimé');
}

/* ===== VISITEURS ===== */
async function loadVisiteurs(){ await refresh('visiteurs'); renderVisiteurs(); }

function renderVisiteurs(){
  const q = document.getElementById('searchVisiteur').value.toLowerCase();
  const fs = document.getElementById('filtreVisiteurStatut').value;
  const list = cache.visiteurs.filter(v=>{
    if(q && !((v.prenom||'')+(v.nom||'')+(v.societe||'')+(v.hote||'')).toLowerCase().includes(q)) return false;
    if(fs && v.statut!==fs) return false;
    if(!inDateRange(v.arrivee,'visDateDeb','visDateFin')) return false;
    return true;
  });
  const tbody = document.querySelector('#tableVisiteurs tbody');
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="8" class="empty-state">Aucun visiteur</td></tr>'; return; }
  tbody.innerHTML = list.map(v=>`<tr><td><strong>${escapeHtml(v.prenom||'')} ${escapeHtml(v.nom||'')}</strong></td><td>${escapeHtml(v.societe||'')}</td><td>${escapeHtml(v.hote||'')}</td><td>${escapeHtml(v.motif||'')}</td><td>${fmtDateTime(v.arrivee)}</td><td>${v.badge?`<code>${v.badge}</code>`:'<span class="badge muted">—</span>'}</td><td><span class="badge ${v.statut==='present'?'success':(v.statut==='attendu'?'info':'muted')}">${v.statut}</span></td><td>${v.statut==='attendu'?`<button class="btn btn-sm btn-success" onclick="checkInVis('${v.id}')">✅</button>`:''}${v.statut==='present'?`<button class="btn btn-sm btn-outline" onclick="checkOutVis('${v.id}')">↗️</button>`:''} <button class="btn btn-sm btn-danger admin-only" onclick="deleteVisiteur('${v.id}')">🗑️</button></td></tr>`).join('');
}

function openVisiteurModal(){
  showModal('Préenregistrer visiteur',`
    <div class="form-row"><div class="form-group"><label>Prénom</label><input type="text" id="vsPrenom"></div><div class="form-group"><label>Nom</label><input type="text" id="vsNom"></div></div>
    <div class="form-row"><div class="form-group"><label>Société</label><input type="text" id="vsSociete"></div><div class="form-group"><label>Hôte</label><select id="vsHote">${cache.employes.map(e=>`<option>${e.prenom} ${e.nom}</option>`).join('')}</select></div></div>
    <div class="form-row"><div class="form-group"><label>Motif</label><select id="vsMotif"><option>Réunion</option><option>Livraison</option><option>Maintenance</option><option>Audit</option><option>Visite commerciale</option><option>Formation</option></select></div><div class="form-group"><label>Arrivée prévue</label><input type="datetime-local" id="vsArrivee"></div></div>
  `, async ()=>{
    await API.post('/visiteurs',{prenom:document.getElementById('vsPrenom').value,nom:document.getElementById('vsNom').value,societe:document.getElementById('vsSociete').value,hote:document.getElementById('vsHote').value,motif:document.getElementById('vsMotif').value,arrivee:document.getElementById('vsArrivee').value||new Date().toISOString()});
    closeModal(); await loadVisiteurs(); notify('Visiteur préenregistré');
  });
}
async function checkInVis(id){ await API.put('/visiteurs/'+id+'/checkin'); await loadVisiteurs(); notify('Check-in effectué'); }
async function checkOutVis(id){ await API.put('/visiteurs/'+id+'/checkout'); await loadVisiteurs(); notify('Check-out effectué'); }
async function deleteVisiteur(id){
  if(!await confirmModal('Supprimer ce visiteur ?')) return;
  await API.del('/visiteurs/'+id);
  await loadVisiteurs();
  notify('Visiteur supprimé');
}

/* ===== EMPLOYES ===== */
async function loadEmployes(){
  await refresh('employes');
  renderEmployes();
  // Alimenter dynamiquement le filtre de sites ATLAS
  const sites = [...new Set(cache.employes.filter(e=>e.atlas_id).map(e=>e.site_nom).filter(Boolean))].sort();
  const sel = document.getElementById('filtreAtlasSite');
  if(sel){
    const current = sel.value;
    sel.innerHTML = '<option value="">Tous les sites</option>' + sites.map(s=>`<option value="${escapeHtml(s)}"${s===current?' selected':''}>${escapeHtml(s)}</option>`).join('');
  }
}

function renderEmployes(){
  const q = document.getElementById('searchEmploye').value.toLowerCase();
  const fserv = document.getElementById('filtreEmpService').value;
  const fst = document.getElementById('filtreEmpStatut').value;
  const list = cache.employes.filter(e=>{
    if(q && !((e.matricule||'')+(e.prenom||'')+(e.nom||'')+(e.service||'')+(e.fonction||'')).toLowerCase().includes(q)) return false;
    if(fserv && e.service!==fserv) return false;
    if(fst && e.statut!==fst) return false;
    return true;
  });
  const tbody = document.querySelector('#tableEmployes tbody');
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="8" class="empty-state">Aucun employé</td></tr>'; return; }
  tbody.innerHTML = list.map(e=>`<tr><td><strong>${e.matricule}</strong></td><td>${escapeHtml(e.prenom||'')} ${escapeHtml(e.nom||'')}</td><td>${escapeHtml(e.service||'')}</td><td>${escapeHtml(e.fonction||'')}</td><td><code>${e.badge||''}</code></td><td><span class="badge ${e.niveau==='N4'?'danger':(e.niveau==='N3'?'warning':(e.niveau==='N2'?'info':'muted'))}">${e.niveau}</span></td><td><span class="badge ${e.statut==='actif'?'success':'warning'}">${e.statut}</span></td><td><button class="btn btn-sm btn-outline admin-only" onclick="editEmploye('${e.id}')">✏️</button> <button class="btn btn-sm btn-danger admin-only" onclick="deleteEmploye('${e.id}')">🗑️</button></td></tr>`).join('');
}

function renderAffectationsAtlas(){
  const q = (document.getElementById('searchAtlas')?.value||'').toLowerCase();
  const fsite = document.getElementById('filtreAtlasSite')?.value||'';
  const fgroupe = document.getElementById('filtreAtlasGroupe')?.value||'';
  const fstatut = document.getElementById('filtreAtlasStatut')?.value||'';

  const atlasAll = cache.employes.filter(e=>e.atlas_id);
  const list = atlasAll.filter(e=>{
    if(q && !((e.matricule||'')+(e.prenom||'')+(e.nom||'')+(e.site_nom||'')+(e.fonction||'')).toLowerCase().includes(q)) return false;
    if(fsite && e.site_nom!==fsite) return false;
    if(fgroupe && e.groupe!==fgroupe) return false;
    if(fstatut && e.statut!==fstatut) return false;
    return true;
  });

  const kpis = document.getElementById('atlasKpis');
  if(kpis){
    const nbSites = new Set(atlasAll.map(e=>e.site_nom).filter(Boolean)).size;
    kpis.innerHTML = `
      <div class="kpi-card success"><div class="kpi-label">Affectés actifs</div><div class="kpi-value">${atlasAll.filter(e=>e.statut==='actif').length}</div><div class="kpi-trend">Synchronisés depuis ATLAS</div></div>
      <div class="kpi-card info"><div class="kpi-label">Sites</div><div class="kpi-value">${nbSites}</div><div class="kpi-trend">Sites distincts</div></div>
      <div class="kpi-card warning"><div class="kpi-label">Inactifs</div><div class="kpi-value">${atlasAll.filter(e=>e.statut!=='actif').length}</div><div class="kpi-trend">Affectations terminées</div></div>
      <div class="kpi-card"><div class="kpi-label">Total</div><div class="kpi-value">${atlasAll.length}</div><div class="kpi-trend">Tous statuts confondus</div></div>`;
  }

  const GROUPE_STYLE = {A:'success', B:'info', C:'warning', D:'danger'};
  const tbody = document.querySelector('#tableAtlas tbody');
  if(!tbody) return;
  if(list.length===0){
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${atlasAll.length===0?'Aucune affectation synchronisée depuis ATLAS — créez une affectation dans ATLAS pour voir apparaître les données ici.':'Aucun résultat pour ces filtres.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(e=>`<tr>
    <td><strong>${escapeHtml(e.matricule||'')}</strong></td>
    <td>${escapeHtml(e.prenom||'')} ${escapeHtml(e.nom||'')}</td>
    <td><span class="badge info" style="white-space:nowrap">${escapeHtml(e.site_nom||'—')}</span></td>
    <td><span class="badge ${GROUPE_STYLE[e.groupe]||'muted'}">${e.groupe||'—'}</span></td>
    <td>${escapeHtml(e.fonction||'—')}</td>
    <td><span class="badge ${e.statut==='actif'?'success':'warning'}">${e.statut||'—'}</span></td>
    <td style="font-family:var(--font-mono);font-size:11px">${e.date_affectation||'—'}</td>
  </tr>`).join('');
}

function renderEmpAcces(){
  const tbody = document.querySelector('#tableEmpAcces tbody'); if(!tbody) return;
  const debSet = document.getElementById('empAccDateDeb')?.value;
  const finSet = document.getElementById('empAccDateFin')?.value;
  const list = cache.pietons.filter(p=>{
    if(p.type!=='Employé') return false;
    if(!debSet && !finSet) return Date.now()-new Date(p.datetime)<24*3600*1000;
    return inDateRange(p.datetime,'empAccDateDeb','empAccDateFin');
  });
  if(list.length===0){ tbody.innerHTML='<tr><td colspan="6" class="empty-state">Aucun accès</td></tr>'; return; }
  tbody.innerHTML = list.map(p=>{
    const emp = cache.employes.find(e=>e.badge===p.badge);
    return `<tr><td>${fmtTime(p.datetime)}</td><td>${emp?emp.matricule:'—'}</td><td>${escapeHtml(p.nom)}</td><td>${emp?escapeHtml(emp.service):'—'}</td><td>${p.sens==='entree'?'➡️ Entrée':'⬅️ Sortie'}</td><td>${escapeHtml(p.point)}</td></tr>`;
  }).join('');
}

function openEmployeModal(){
  showModal('Nouvel employé',`
    <div class="form-row"><div class="form-group"><label>Prénom</label><input type="text" id="ePrenom"></div><div class="form-group"><label>Nom</label><input type="text" id="eNom"></div></div>
    <div class="form-row"><div class="form-group"><label>Service</label><select id="eService"><option>Direction</option><option>Production</option><option>Logistique</option><option>Maintenance</option><option>Administration</option><option>Sûreté</option></select></div><div class="form-group"><label>Fonction</label><input type="text" id="eFonction"></div></div>
    <div class="form-row"><div class="form-group"><label>Niveau</label><select id="eNiv"><option>N1</option><option>N2</option><option>N3</option><option>N4</option></select></div><div class="form-group"><label>Statut</label><select id="eStatut"><option value="actif">Actif</option><option value="absent">Absent</option><option value="suspendu">Suspendu</option></select></div></div>
  `, async ()=>{
    await API.post('/employes',{prenom:document.getElementById('ePrenom').value,nom:document.getElementById('eNom').value,service:document.getElementById('eService').value,fonction:document.getElementById('eFonction').value,niveau:document.getElementById('eNiv').value,statut:document.getElementById('eStatut').value});
    closeModal(); await loadEmployes(); notify('Employé créé');
  });
}

function editEmploye(id){
  const e = cache.employes.find(x=>x.id===id); if(!e) return;
  showModal('Modifier '+(e.prenom||'')+' '+(e.nom||''),`
    <div class="form-row"><div class="form-group"><label>Service</label><select id="eEditService">${['Direction','Production','Logistique','Maintenance','Administration','Sûreté'].map(s=>`<option${e.service===s?' selected':''}>${s}</option>`).join('')}</select></div><div class="form-group"><label>Fonction</label><input type="text" id="eEditFonction" value="${escapeHtml(e.fonction||'')}"></div></div>
    <div class="form-row"><div class="form-group"><label>Niveau</label><select id="eEditNiv">${['N1','N2','N3','N4'].map(n=>`<option${e.niveau===n?' selected':''}>${n}</option>`).join('')}</select></div><div class="form-group"><label>Statut</label><select id="eEditStatut"><option value="actif"${e.statut==='actif'?' selected':''}>Actif</option><option value="absent"${e.statut==='absent'?' selected':''}>Absent</option><option value="suspendu"${e.statut==='suspendu'?' selected':''}>Suspendu</option></select></div></div>
  `, async ()=>{
    await API.put('/employes/'+id,{service:document.getElementById('eEditService').value,fonction:document.getElementById('eEditFonction').value,niveau:document.getElementById('eEditNiv').value,statut:document.getElementById('eEditStatut').value});
    closeModal(); await loadEmployes(); notify('Employé modifié');
  });
}

async function deleteEmploye(id){
  if(!await confirmModal('Supprimer cet employé ?')) return;
  await API.del('/employes/'+id);
  await loadEmployes();
  notify('Employé supprimé');
}

/* ===== PARKING ===== */
async function loadParking(){ await refresh('parking'); renderParking(); }

function renderParking(){
  const zones = cache.parking.zones||[];
  let total=0, occupe=0, libre=0, reserve=0, handicap=0;
  zones.forEach(z=>{
    total+=z.total;
    (z.places||[]).forEach(p=>{
      if(p.etat==='occupe') occupe++;
      else if(p.etat==='libre') libre++;
      else if(p.etat==='reserve') reserve++;
      else if(p.etat==='handicap') handicap++;
    });
  });
  document.getElementById('parkingKpis').innerHTML = `<div class="kpi-card"><div class="kpi-label">Total places</div><div class="kpi-value">${total}</div></div><div class="kpi-card success"><div class="kpi-label">Disponibles</div><div class="kpi-value">${libre+handicap}</div></div><div class="kpi-card danger"><div class="kpi-label">Occupées</div><div class="kpi-value">${occupe}</div></div><div class="kpi-card warning"><div class="kpi-label">Réservées</div><div class="kpi-value">${reserve}</div></div>`;
  document.getElementById('parkingZones').innerHTML = zones.map(z=>{
    const occ = (z.places||[]).filter(p=>p.etat==='occupe').length;
    const taux = Math.round(occ*100/z.total);
    const cls = taux>85?'danger':(taux>60?'warning':'');
    return `<div class="parking-zone"><div class="zone-header"><div class="zone-name">${escapeHtml(z.nom)} (${z.zone})</div><div class="zone-stats">${occ}/${z.total} • ${taux}%</div></div><div class="zone-bar"><div class="zone-bar-fill ${cls}" style="width:${taux}%"></div></div><div class="spots-grid">${(z.places||[]).map(p=>`<div class="spot ${p.etat==='occupe'?'occupied':(p.etat==='reserve'?'reserved':(p.etat==='handicap'?'handicap':''))}" title="${p.num}${p.plaque?' — '+p.plaque:''}" onclick="togglePlace('${p.num}')">${p.num.replace(z.zone,'')}</div>`).join('')}</div></div>`;
  }).join('');

  const tbody = document.querySelector('#tableParkingMouvements tbody');
  const mvts = (cache.parking.mouvements||[]).filter(m=>inDateRange(m.datetime,'parkDateDeb','parkDateFin'));
  if(mvts.length===0){ tbody.innerHTML='<tr><td colspan="6" class="empty-state">Aucun mouvement</td></tr>'; return; }
  tbody.innerHTML = mvts.slice(0,50).map(m=>`<tr><td>${fmtDateTime(m.datetime)}</td><td><strong>${m.plaque}</strong></td><td>${m.place}</td><td>Zone ${m.zone}</td><td>${m.action==='entree'?'➡️ Entrée':'⬅️ Sortie'}</td><td>${m.duree?Math.floor(m.duree/60)+'h'+(m.duree%60):'—'}</td></tr>`).join('');
}

async function togglePlace(num){
  let place = null;
  for(const z of cache.parking.zones||[]){
    place = (z.places||[]).find(p=>p.num===num); if(place) break;
  }
  if(!place) return;
  if(place.etat==='libre'){
    const plaque = prompt('Plaque du véhicule entrant :', generePlaque());
    if(!plaque) return;
    await API.put('/parking/places/'+num,{etat:'occupe',plaque});
    await loadParking(); notify('Entrée parking : '+num);
  } else if(place.etat==='occupe'){
    if(!await confirmModal('Libérer la place '+num+' ('+(place.plaque||'?')+') ?')) return;
    await API.put('/parking/places/'+num,{etat:'libre',plaque:null});
    await loadParking(); notify('Place '+num+' libérée');
  }
}

/* ===== BADGES ===== */
async function loadBadges(){ await refresh('badges'); renderBadges(); }

function typeLabel(t){return {V:'Visiteur',E:'Employé',P:'Prestataire',T:'Temporaire'}[t]||t;}

function renderBadges(){
  const tbody = document.querySelector('#tableBadges tbody');
  if(cache.badges.length===0){ tbody.innerHTML='<tr><td colspan="8" class="empty-state">Aucun badge</td></tr>'; return; }
  tbody.innerHTML = cache.badges.map(b=>{
    const exp = new Date(b.validite) < new Date();
    const etat = exp ? 'Expiré' : (b.etat==='inactif'?'Inactif':'Actif');
    // PG-25 (hardening) : b.ref peut être fourni tel quel par l'appelant
    // (POST /badges) — escapeHtml() en affichage et dans les attributs onclick.
    const ref = escapeHtml(b.ref);
    return `<tr><td><strong>${ref}</strong></td><td>${escapeHtml(b.nom||'')}</td><td><span class="badge ${b.type==='V'?'info':(b.type==='E'?'success':(b.type==='P'?'warning':'muted'))}">${typeLabel(b.type)}</span></td><td><span class="badge ${b.niveau==='N4'?'danger':(b.niveau==='N3'?'warning':(b.niveau==='N2'?'info':'muted'))}">${escapeHtml(b.niveau||'')}</span></td><td>${fmtDate(b.emis)}</td><td>${fmtDate(b.validite)}</td><td><span class="badge ${exp||b.etat==='inactif'?'danger':'success'}">${etat}</span></td><td><button class="btn btn-sm btn-outline" onclick="reimprimerBadge('${ref}')">🖨️</button> <button class="btn btn-sm btn-outline admin-only" onclick="desactiverBadge('${ref}')">⏸️</button> <button class="btn btn-sm btn-danger admin-only" onclick="deleteBadge('${ref}')">🗑️</button></td></tr>`;
  }).join('');
}

async function genererBadge(){
  const nom = document.getElementById('badgeNom').value;
  if(!nom) return alert('Nom requis');
  const type = document.getElementById('badgeType').value;
  const societe = document.getElementById('badgeSociete').value || '—';
  const validite = document.getElementById('badgeValidite').value || new Date(Date.now()+24*3600*1000).toISOString();
  const niveau = document.getElementById('badgeNiveau').value;
  const ref = type+'-'+Math.floor(Math.random()*9000+1000);
  document.getElementById('badgeRef').value = ref;
  document.getElementById('prevNom').textContent = nom;
  document.getElementById('prevSociete').textContent = societe;
  document.getElementById('prevType').textContent = typeLabel(type).toUpperCase();
  document.getElementById('prevType').className = 'badge '+(type==='V'?'info':(type==='E'?'success':(type==='P'?'warning':'muted')));
  document.getElementById('prevRef').textContent = ref;
  document.getElementById('prevValidite').textContent = fmtDateTime(validite);
  const qr = document.getElementById('qrContainer'); qr.innerHTML='';
  new QRCode(qr,{text:JSON.stringify({ref,nom,type,niveau,validite}),width:160,height:160,colorDark:'#142840'});
  await API.post('/badges',{ref,nom,type,niveau,emis:new Date().toISOString(),validite:new Date(validite).toISOString(),etat:'actif',societe});
  await loadBadges();
  notify('Badge '+ref+' généré');
}

function reimprimerBadge(ref){
  const b = cache.badges.find(x=>x.ref===ref); if(!b) return;
  document.getElementById('badgeNom').value = b.nom;
  document.getElementById('badgeType').value = b.type;
  document.getElementById('badgeSociete').value = b.societe||'';
  document.getElementById('badgeValidite').value = (b.validite||'').slice(0,16);
  document.getElementById('badgeNiveau').value = b.niveau;
  document.getElementById('badgeRef').value = b.ref;
  document.getElementById('prevNom').textContent = b.nom;
  document.getElementById('prevSociete').textContent = b.societe||'';
  document.getElementById('prevType').textContent = typeLabel(b.type).toUpperCase();
  document.getElementById('prevRef').textContent = b.ref;
  document.getElementById('prevValidite').textContent = fmtDateTime(b.validite);
  const qr = document.getElementById('qrContainer'); qr.innerHTML='';
  new QRCode(qr,{text:JSON.stringify({ref:b.ref,nom:b.nom,type:b.type}),width:160,height:160,colorDark:'#142840'});
  setTimeout(()=>window.print(),500);
}

async function desactiverBadge(ref){
  const b = cache.badges.find(x=>x.ref===ref); if(!b) return;
  await API.put('/badges/'+encodeURIComponent(ref),{...b,etat:b.etat==='inactif'?'actif':'inactif'});
  await loadBadges();
  notify('Badge mis à jour');
}

async function deleteBadge(ref){
  if(!await confirmModal('Supprimer ce badge ?')) return;
  await API.del('/badges/'+encodeURIComponent(ref));
  await loadBadges();
  notify('Badge supprimé');
}

/* ===== RAPPORTS ===== */
let chartRapFlux,chartRapInc,chartRapPts,chartRapHrs;
async function loadRapports(){ renderRapports(); }

async function renderRapports(){
  const periode = parseInt(document.getElementById('rapportPeriode').value);
  const data = await API.get('/rapports?periode='+periode);
  const incs = data.incidents, piet = data.pietons, veh = data.vehicules;
  document.getElementById('rapportKpis').innerHTML = `<div class="kpi-card info"><div class="kpi-label">Total piétons</div><div class="kpi-value">${piet.length}</div></div><div class="kpi-card success"><div class="kpi-label">Total véhicules</div><div class="kpi-value">${veh.length}</div></div><div class="kpi-card danger"><div class="kpi-label">Incidents</div><div class="kpi-value">${incs.length}</div></div><div class="kpi-card warning"><div class="kpi-label">Refus</div><div class="kpi-value">${piet.filter(p=>p.resultat==='refus').length}</div></div>`;

  if(chartRapFlux) chartRapFlux.destroy();
  const labels=[],dE=[],dS=[],dV=[];
  for(let i=Math.min(periode-1,29);i>=0;i--){
    const d = new Date(Date.now()-i*24*3600*1000);
    labels.push(fmtDayMonth(d));
    const ds = new Date(d).setHours(0,0,0,0), de = ds+24*3600*1000;
    dE.push(piet.filter(p=>{const t=new Date(p.datetime).getTime();return t>=ds&&t<de&&p.sens==='entree';}).length+randInt(50,150));
    dS.push(piet.filter(p=>{const t=new Date(p.datetime).getTime();return t>=ds&&t<de&&p.sens==='sortie';}).length+randInt(40,140));
    dV.push(veh.filter(v=>{const t=new Date(v.entree).getTime();return t>=ds&&t<de;}).length+randInt(10,40));
  }
  chartRapFlux = new Chart(document.getElementById('chartRapportFlux'),{type:'bar',data:{labels,datasets:[{label:'Piétons E',data:dE,backgroundColor:'#00ff9d'},{label:'Piétons S',data:dS,backgroundColor:'#5ab9ff'},{label:'Véhicules',data:dV,backgroundColor:'#ffb800'}]},options:{responsive:true,plugins:{legend:{position:'bottom'}}}});

  if(chartRapInc) chartRapInc.destroy();
  const types={};
  incs.forEach(i=>types[i.type]=(types[i.type]||0)+1);
  chartRapInc = new Chart(document.getElementById('chartRapportIncidents'),{type:'pie',data:{labels:Object.keys(types),datasets:[{data:Object.values(types),backgroundColor:['#ff3860','#ffb800','#5ab9ff','#00ff9d','#00d4ff','#9b5de5','#fb5607'],borderColor:'#101827',borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom'}}}});

  if(chartRapPts) chartRapPts.destroy();
  const pts={};
  piet.forEach(p=>pts[p.point]=(pts[p.point]||0)+1);
  chartRapPts = new Chart(document.getElementById('chartRapportPoints'),{type:'bar',data:{labels:Object.keys(pts),datasets:[{label:'Passages',data:Object.values(pts),backgroundColor:'#00d4ff'}]},options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}}}});

  if(chartRapHrs) chartRapHrs.destroy();
  const hrs = Array(24).fill(0);
  piet.forEach(p=>{const h = new Date(p.datetime).getHours(); hrs[h]++;});
  for(let h=7;h<10;h++) hrs[h]+=randInt(20,50);
  for(let h=12;h<14;h++) hrs[h]+=randInt(15,35);
  for(let h=17;h<19;h++) hrs[h]+=randInt(20,45);
  chartRapHrs = new Chart(document.getElementById('chartRapportHeures'),{type:'line',data:{labels:hrs.map((_,h)=>h+'h'),datasets:[{label:'Accès',data:hrs,borderColor:'#ff3860',backgroundColor:'rgba(255,56,96,.2)',fill:true,tension:.4}]},options:{responsive:true,plugins:{legend:{display:false}}}});

  const crit = incs.filter(i=>i.gravite==='critique').length;
  const ref = piet.filter(p=>p.resultat==='refus').length;
  // UI-4 : "Généré le" fusionné avec l'horodatage dans le même noeud
  // texte, jamais atteignable par le scan DOM de applyLanguage() une fois
  // l'heure interpolée — traduit ici explicitement.
  const syntheseLang = localStorage.getItem(I18N_KEY)||'fr';
  document.getElementById('syntheseExec').innerHTML = `<p><strong>Période :</strong> ${periode} derniers jours</p><ul style="margin:14px 0 14px 22px;line-height:1.9"><li><strong>${piet.length}</strong> passages piétons, dont <strong>${ref}</strong> refus (${piet.length?Math.round(ref*100/piet.length):0}%).</li><li><strong>${veh.length}</strong> entrées véhicules dont ${veh.filter(v=>v.type==='PL').length} poids lourds.</li><li><strong>${incs.length}</strong> incidents — ${crit} critiques.</li><li>Taux résolution : <strong>${incs.length?Math.round(incs.filter(i=>i.statut==='resolu').length*100/incs.length):0}%</strong>.</li><li>Effectif actif : <strong>${data.employes_actifs}</strong>.</li></ul><p style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono)">${translateText('Généré le',syntheseLang)} ${new Date().toLocaleString(currentDateLocale())}</p>`;
}

async function exportCSV(){
  const periode = parseInt(document.getElementById('rapportPeriode').value);
  const data = await API.get('/rapports?periode='+periode);
  let csv = 'Type;Date;Détail;Lieu;Statut\n';
  data.incidents.forEach(i=>csv+=`Incident;${i.datetime};${i.type} (${i.gravite});${i.lieu};${i.statut}\n`);
  data.vehicules.forEach(v=>csv+=`Véhicule;${v.entree};${v.plaque} - ${v.type} - ${v.conducteur||''};${v.motif||''};${v.statut}\n`);
  data.pietons.forEach(p=>csv+=`Piéton;${p.datetime};${p.nom} (${p.type}) ${p.sens};${p.point};${p.resultat}\n`);
  download(csv,'rapport-'+new Date().toISOString().slice(0,10)+'.csv','text/csv');
  notify('Rapport CSV exporté');
}

/* ===== PARAMETRES ===== */
async function loadParametres(){
  await refresh('parametres');
  document.getElementById('setSiteNom').value = cache.parametres.site||'';
  document.getElementById('setSiteAdr').value = cache.parametres.adresse||'';
  document.getElementById('setSiteTel').value = cache.parametres.tel||'';
  renderPushStatus();
}

// PCS01 (Lot B) : jamais de capacité fabriquée — le texte reflète
// exactement status().available (clé VAPID configurée côté serveur ou
// non, docs/push.md) et permission (accordée/refusée/jamais demandée).
async function renderPushStatus(){
  const textEl = document.getElementById('pushStatusText'), btn = document.getElementById('pushEnableBtn');
  if(!textEl) return;
  try{
    const s = await PushSubscribe.status();
    if(!s.supported){ textEl.textContent = 'Non supporté par ce navigateur.'; btn.hidden = true; return; }
    if(!s.available){ textEl.textContent = 'Pas encore activées côté serveur.'; btn.hidden = true; return; }
    if(s.permission === 'denied'){ textEl.textContent = 'Bloquées par le navigateur — à réactiver dans ses réglages.'; btn.hidden = true; return; }
    if(s.subscribed){ textEl.textContent = 'Activées sur cet appareil.'; btn.hidden = true; return; }
    textEl.textContent = 'Recevez une notification même l’application fermée pour un SOS ou une alerte critique.';
    btn.hidden = false; btn.disabled = false; btn.textContent = 'Activer les notifications critiques';
  }catch{ textEl.textContent = 'État indisponible pour le moment.'; if(btn) btn.hidden = true; }
}
// PCS01 (Lot B) : navigation exacte vers l'alerte visée par une
// notification push (frontend/sw.js#notificationclick), qu'une fenêtre ait
// été réutilisée (postMessage) ou ouverte via ?alert=<id>. openAlert()
// (frontend/js/alerts.js) applique déjà own/scope à l'affichage ; aucune
// visibilité nouvelle n'est ajoutée ici.
function openAlertFromDeepLink(){
  const id = new URLSearchParams(location.search).get('alert');
  if(id){ AlertCenter.openAlert(id); history.replaceState(null, '', location.pathname); }
}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message', e=>{
    if(e.data && e.data.type === 'securisite:open-alert' && e.data.id) AlertCenter.openAlert(e.data.id);
  });
}

async function togglePush(){
  const btn = document.getElementById('pushEnableBtn');
  btn.disabled = true; btn.textContent = 'Activation…';
  try{ await PushSubscribe.enable(); notify('Notifications activées'); }
  catch(e){ notify(e.message || 'Échec de l’activation', 'warning'); }
  finally{ renderPushStatus(); }
}

async function sauverParametres(){
  await API.put('/parametres',{site:document.getElementById('setSiteNom').value,adresse:document.getElementById('setSiteAdr').value,tel:document.getElementById('setSiteTel').value});
  notify('Paramètres enregistrés');
}

/* ===== INIT ===== */
function initApp(){
  AlertCenter.start();
  CriticalAlert.start();
  navTo('alertes');
  initI18nObserver();
  openAlertFromDeepLink();
  setInterval(()=>{
    if(document.getElementById('page-dashboard').classList.contains('active')) loadDashboard();
    if(document.getElementById('page-maincourante').classList.contains('active')){
      const dt = document.getElementById('mcDatetime');
      if(dt && document.activeElement!==dt) dt.value = toLocalInput(new Date());
      loadMaincourante();
    }
  }, 30000);
}

// Auto-login if token saved
window.addEventListener('DOMContentLoaded', async ()=>{
  initI18nObserver();
  const token = API.getToken();
  if(token){
    try{
      const { user } = await API.me();
      API.setUser(user);
      showApp(user);
    } catch{
      API.clearToken();
    }
  }
});

// Press Enter on login
document.getElementById('loginPass')?.addEventListener('keydown', e=>{
  if(e.key==='Enter') doLogin();
});
