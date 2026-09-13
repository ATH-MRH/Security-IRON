/* Alert Core: server-backed state, no simulated operational data. */
const AlertCenter = (() => {
  const labels = {NOTIFIEE:'Notifiée',ACQUITTEE:'Acquittée',EN_INTERVENTION:'En intervention',SOUS_CONTROLE:'Sous contrôle',RESOLUE:'Résolue',CLOTUREE:'Clôturée',FAUSSE_ALERTE:'Fausse alerte',ANNULEE:'Annulée'};
  const levels = ['','Information','Vigilance','Critique','SOS / Urgence'];
  const next = {NOTIFIEE:['ACQUITTEE','Prendre en charge'],ACQUITTEE:['EN_INTERVENTION','Démarrer l’intervention'],EN_INTERVENTION:['SOUS_CONTROLE','Situation sous contrôle'],SOUS_CONTROLE:['RESOLUE','Résoudre'],RESOLUE:['CLOTUREE','Clôturer']};
  let rows = [], incidents = [], selected = null, busy = false, timer, detailRequest = 0, selectionPending = false;
  // User selection, detail requests and POST ownership have separate lifetimes.
  let selectionGeneration = 0, activeAction = null;
  function captureSelection() {
    const id = selected, generation = selectionGeneration;
    return () => selected === id && selectionGeneration === generation;
  }
  const e = escapeHtml;
  const finished = a => ['CLOTUREE','FAUSSE_ALERTE','ANNULEE'].includes(a.status);
  const date = s => new Date(s).toLocaleString('fr-FR');
  function error(err) { document.getElementById('ac-message').textContent = err.message; }
  async function load(isCurrent = () => true) {
    if (busy || !isCurrent()) return;
    busy = true;
    try {
      const result = await API.get('/alerts'); // même chaîne d'attente que la version historique
      if (!isCurrent()) return;
      rows = result;
      document.getElementById('ac-message').textContent='';
      document.getElementById('ac-sync').textContent='Dernière synchronisation : '+new Date().toLocaleTimeString('fr-FR');
      renderKpis();
      renderBySite();
      renderRecentIncidents();
      renderOpTimeline();
      renderList();
      if(selected) await detail(selected,false);
      // Incidents récents/timeline sont un complément d'affichage : chargés à
      // part, jamais couplés au timing de load() lui-même (qui reste
      // exactement celui d'un seul GET /alerts) — un /incidents lent ou en
      // échec ne doit jamais retarder ni casser l'écran principal des alertes.
      loadRecentIncidents(isCurrent);
    } catch(err) { if(isCurrent()) { error(err); document.getElementById('ac-sync').textContent='Connexion interrompue — données potentiellement anciennes'; } }
    finally {busy=false;}
  }
  async function loadRecentIncidents(isCurrent) {
    try {
      const result = await API.get('/incidents');
      if (!isCurrent()) return;
      incidents = result;
      renderRecentIncidents();
      renderOpTimeline();
    } catch { /* panneau dégradé silencieusement, jamais l'écran principal */ }
  }
  // PG-16 : agrégation pure (frontend/js/soc-kpis.js), aucun KPI simulé — tout
  // provient de GET /alerts, déjà filtré own/scope côté serveur (PG-8).
  function renderKpis() {
    const k = SocKpis.compute(rows);
    const avg = k.avgAckSeconds===null ? '—' : k.avgAckSeconds+' s';
    document.getElementById('ac-kpis').innerHTML=[
      ['Alertes actives',k.active],['Critiques en cours',k.critical],['SOS en cours',k.sos],
      ['Non acquittées',k.unacknowledged],['Escalades en cours',k.escalated],
      ['Alertes aujourd’hui',k.today],['Prise en charge moyenne',avg],
    ].map(([label,value])=>`<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`).join('');
  }
  function renderBySite() {
    const c = document.getElementById('ac-by-site');
    const { bySite } = SocKpis.compute(rows);
    if (!bySite.length) { c.innerHTML='<div class="empty-state">Aucune alerte active</div>'; return; }
    const max = Math.max(...bySite.map(s=>s.count));
    c.innerHTML = bySite.slice(0,8).map(s=>`<div class="ac-site-row"><span>${e(s.site)}</span><span class="ac-site-bar"><span style="width:${Math.round(s.count*100/max)}%"></span></span><strong>${s.count}</strong></div>`).join('');
  }
  function renderRecentIncidents() {
    const c = document.getElementById('ac-recent-incidents');
    const recent = incidents.slice(0,6);
    if (!recent.length) { c.innerHTML='<div class="empty-state">Aucun incident récent</div>'; return; }
    c.innerHTML = recent.map(i=>`<div class="alert-item ${i.gravite==='critique'?'danger':(i.gravite==='majeur'?'warning':'')}"><div class="alert-content"><div class="alert-title">${e(i.type)} <span class="badge ${i.gravite==='critique'?'danger':(i.gravite==='majeur'?'warning':'info')}">${e(i.gravite||'')}</span></div><div class="alert-meta">${e(i.lieu||'')} • ${e(i.ref||'')}</div></div><div class="alert-time">${date(i.datetime)}</div></div>`).join('');
  }
  // Fusionne deux flux réellement reçus (alertes créées, incidents créés) —
  // jamais une activité inventée. Trié par horodatage, borné pour rester lisible.
  function renderOpTimeline() {
    const c = document.getElementById('ac-op-timeline');
    const items = [
      ...rows.map(a=>({at:a.created_at,label:`Alerte · ${a.type} · N${a.level}`,meta:a.site})),
      ...incidents.map(i=>({at:i.datetime,label:`Incident · ${i.type}`,meta:i.lieu||''})),
    ].filter(x=>x.at).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,15);
    if (!items.length) { c.innerHTML='<div class="empty-state">Aucune activité récente</div>'; return; }
    c.innerHTML = `<ol class="ac-op-timeline">${items.map(x=>`<li><time>${date(x.at)}</time><span>${e(x.label)}${x.meta?' — '+e(x.meta):''}</span></li>`).join('')}</ol>`;
  }
  function renderList() {
    const query=document.getElementById('ac-search').value.toLowerCase();
    const level=document.getElementById('ac-level').value;
    const status=document.getElementById('ac-status').value;
    const filtered=rows.filter(a=>(!level||a.level===Number(level))&&(status!=='open'||(!finished(a)&&a.status!=='RESOLUE'))&&`${a.site} ${a.zone} ${a.type} ${a.username}`.toLowerCase().includes(query));
    document.getElementById('ac-list').innerHTML=filtered.length?filtered.map(a=>`<button type="button" class="ac-alert ac-level-${a.level} ${selected===a.id?'selected':''}" data-alert="${a.id}"><span class="ac-alert-top"><b>${e(a.type)}</b><span class="badge ${a.level>=3?'danger':a.level===2?'warning':'info'}">N${a.level} · ${levels[a.level]}</span></span><span>${e(a.site)}${a.zone?' · '+e(a.zone):''}</span><small>${e(a.username)} · ${date(a.created_at)}</small><span class="ac-alert-top"><span>${labels[a.status]}</span>${a.escalation_step?`<strong>Escalade ${a.escalation_step}</strong>`:''}${a.cancellation_requested?'<strong>Annulation demandée</strong>':''}</span></button>`).join(''):'<div class="empty-state">Aucune alerte pour ces filtres.</div>';
    document.querySelectorAll('[data-alert]').forEach(b=>b.onclick=()=>detail(b.dataset.alert));
  }
  async function detail(id, redraw=true) {
    // An explicit selection owns the detail until it settles. Polling cannot supersede it.
    if (!redraw && (selectionPending || selected !== id || activeAction?.isCurrent())) return;
    const request = ++detailRequest;
    if (redraw) {
      selectionGeneration++;
      selected = id;
      selectionPending = true;
      document.getElementById('ac-message').textContent = '';
      document.getElementById('ac-detail').innerHTML = `<p role="status">Chargement de l’alerte ${e(id)}…</p>`;
      renderList();
    }
    try {
      const a=await API.get('/alerts/'+id);
      if(request !== detailRequest || selected!==id) return;
      document.getElementById('ac-message').textContent = '';
      if(redraw) renderList();
      const target=document.getElementById('ac-detail');
      // Do not replace the operator’s draft during refresh.
      const draft=target.querySelector('#ac-comment')?.value||'';
      const focused=document.activeElement?.id==='ac-comment';
      const action=next[a.status];
      target.innerHTML=`<div class="ac-detail-head"><div class="clean-eyebrow">SECURITY ALERT · NIVEAU ${a.level}</div><h2>${e(a.type)}</h2><p>${e(a.site)} · ${e(a.zone||'Zone non renseignée')}</p><span class="badge ${a.level>=3?'danger':'info'}">${labels[a.status]}</span></div><dl class="ac-facts"><dt>Déclarant</dt><dd>${e(a.username)}</dd><dt>Création serveur</dt><dd>${date(a.created_at)}</dd><dt>Responsable</dt><dd>${e(a.owner||'Non affectée')}</dd><dt>Origine</dt><dd>${e(a.origin)}</dd><dt>Équipement</dt><dd>${e(a.equipment||'Non renseigné')}</dd><dt>Position</dt><dd>${a.latitude===null?'Non disponible':e(a.latitude+', '+a.longitude)}</dd><dt>Acquittement</dt><dd>${a.acknowledged_at?Math.round((Date.parse(a.acknowledged_at)-Date.parse(a.created_at))/1000)+' s':'En attente'}</dd></dl>${a.comment?`<p class="ac-description">${e(a.comment)}</p>`:''}${a.cancellation_requested?'<p class="ac-warning">Demande d’annulation reçue. La décision appartient au SOC ; l’historique est conservé.</p>':''}<div class="ac-actions">${!finished(a)&&isAdmin()?`${action?`<button class="btn btn-primary" data-action="${action[0]}">${action[1]}</button>`:''}<button class="btn btn-outline" data-action="ESCALADE">Escalader</button><button class="btn btn-outline" data-action="FAUSSE_ALERTE">Valider fausse alerte</button><button class="btn btn-outline" data-action="ANNULEE">Annuler (SOC)</button>`:''}${!finished(a)&&a.created_by===API.getUser()?.id&&!a.cancellation_requested?'<button class="btn btn-outline" data-action="DEMANDE_ANNULATION">Demander l’annulation</button>':''}</div>${!finished(a)?'<label for="ac-comment">Commentaire / motif de clôture exceptionnelle</label><textarea id="ac-comment" maxlength="4000" rows="3" placeholder="Documenter une action, une décision…"></textarea><button class="btn btn-outline" data-action="COMMENTAIRE">Ajouter au journal</button>':''}<h3 class="ac-timeline-title">Chronologie & audit</h3><ol class="ac-timeline">${a.timeline.map(t=>`<li><strong>${e(t.action.replaceAll('_',' '))}</strong><small>${date(t.created_at)} · ${e(t.actor)}</small>${t.detail?`<p>${e(t.detail)}</p>`:''}</li>`).join('')}</ol><small>${e(a.id)}</small>`;
      const input=target.querySelector('#ac-comment'); if(input) {input.value=redraw?'':draft;if(focused&&!redraw)input.focus();}
      target.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(a.id,b.dataset.action));
    } catch(err) {
      if(request !== detailRequest || selected!==id) return;
      if(redraw) document.getElementById('ac-detail').innerHTML = `<p role="alert">Impossible de charger l’alerte ${e(id)} : ${e(err.message)}</p>`;
      error(err);
    } finally {
      if(request === detailRequest) selectionPending = false;
    }
  }
  async function act(id,action) {
    if(id !== selected || selectionPending || activeAction?.isCurrent()) return;
    const isCurrent = captureSelection();
    const field = document.getElementById('ac-comment');
    const operation = { id, generation: selectionGeneration, action, field,
      comment: field?.value || '', isCurrent };
    activeAction = operation;
    ++detailRequest; // A detail already in flight predates this POST.
    const buttons = document.querySelectorAll('[data-action]');
    buttons.forEach(b=>b.disabled=true);
    try {
      await API.post('/alerts/'+operation.id+'/actions',{action:operation.action,comment:operation.comment});
      if (!isCurrent() || activeAction !== operation) return;
      // Do not clear another form, or text entered since this action was submitted.
      if (document.getElementById('ac-comment') === field && field?.value === operation.comment) field.value='';
      activeAction = null;
      await load(isCurrent);
    } catch(err) {
      if(isCurrent()) error(err);
    } finally {
      if(activeAction === operation) activeAction = null;
      if(isCurrent() && document.getElementById('ac-comment') === field) buttons.forEach(b=>b.disabled=false);
    }
  }
  function createForm() {
    showModal('Nouvelle alerte',`<div class="form-group"><label>Site *</label><input id="new-alert-site" maxlength="200"></div><div class="form-group"><label>Zone</label><input id="new-alert-zone" maxlength="200"></div><div class="form-group"><label>Type *</label><input id="new-alert-type" maxlength="200" placeholder="Intrusion, incident, anomalie…"></div><div class="form-group"><label>Niveau</label><select id="new-alert-level">${levels.slice(1).map((v,i)=>`<option value="${i+1}">${i+1} — ${v}</option>`).join('')}</select></div><div class="form-group"><label>Commentaire</label><textarea id="new-alert-comment" maxlength="4000"></textarea></div><p id="new-alert-error" role="alert"></p>`,async()=>{
      const button=document.querySelector('#modalConfirm'); if(button)button.disabled=true;
      try {
        const a=await API.post('/alerts',{site:document.getElementById('new-alert-site').value,zone:document.getElementById('new-alert-zone').value,type:document.getElementById('new-alert-type').value,level:Number(document.getElementById('new-alert-level').value),comment:document.getElementById('new-alert-comment').value});
        closeModal(); selected=a.id; await load();
      } catch(err) {document.getElementById('new-alert-error').textContent=err.message;}
      finally {if(button)button.disabled=false;}
    },'Créer l’alerte');
  }
  async function rules() {
    try {
      const c=await API.get('/alerts/rules');
      showModal('Règles & escalades',`<p>Les alertes de niveau 3 et 4 non acquittées sont relancées aux administrateurs. Les délais sont enregistrés avec chaque nouvelle alerte.</p>${c.escalation.map((v,i)=>`<div class="form-group"><label>Palier ${i+1} (secondes)</label><input type="number" id="rule-${i}" min="1" max="86400" value="${v}"></div>`).join('')}<div class="form-group"><label><input type="checkbox" id="rule-incidents" ${c.incidentCritical?'checked':''}> Créer une alerte pour les incidents majeurs et critiques</label></div><div class="form-group"><label>Nombre de refus du même badge</label><input id="rule-badges" type="number" min="2" max="100" value="${c.badgeThreshold}"></div><div class="form-group"><label>Fenêtre (secondes)</label><input id="rule-window" type="number" min="1" max="3600" value="${c.badgeWindowSeconds}"></div><p id="rule-error" role="alert"></p>`,async()=>{
        try {await API.put('/alerts/rules',{escalation:[0,1,2].map(i=>Number(document.getElementById('rule-'+i).value)),incidentCritical:document.getElementById('rule-incidents').checked,badgeThreshold:Number(document.getElementById('rule-badges').value),badgeWindowSeconds:Number(document.getElementById('rule-window').value)});closeModal();}
        catch(err){document.getElementById('rule-error').textContent=err.message;}
      });
    }catch(err){error(err);}
  }
  async function openAlert(id) {
    const loading = detail(id); // Select synchronously before navTo starts its refresh.
    navTo('alertes');
    await loading;
  }
  // PG-16 : le minuteur 5 s existant reste le filet de repli (fonctionne même
  // si le temps réel n'est jamais joignable) — Realtime.connect() ne fait que
  // rendre la mise à jour quasi instantanée quand le flux est disponible.
  function refreshNow(){ NotificationBell.refresh(); if(document.getElementById('page-alertes').classList.contains('active'))load(); }
  function updateLiveBadge(){
    const b=document.getElementById('ac-live-badge'); if(!b) return;
    const live=Realtime.isConnected();
    b.textContent = live ? '● Temps réel' : '● Repli (actualisation périodique)';
    b.classList.toggle('live',live); b.classList.toggle('fallback',!live);
  }
  function start() {
    clearInterval(timer);
    NotificationBell.refresh();
    timer=setInterval(()=>{if(document.hidden)return;updateLiveBadge();NotificationBell.refresh();if(document.getElementById('page-alertes').classList.contains('active'))load();},5000);
    document.getElementById('ac-rules').hidden=!isAdmin();
    Realtime.on((type)=>{ updateLiveBadge(); if(type==='alert:created'||type==='alert:updated'||type==='poll') refreshNow(); });
    Realtime.connect();
    updateLiveBadge();
  }
  return {load,renderList,createForm,rules,notifications:NotificationBell.open,openAlert,captureSelection,start};
})();
