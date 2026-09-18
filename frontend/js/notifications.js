/* Enrich the historical bell using the same authenticated APIs and predicates. */
const NotificationBell = (() => {
  const e = escapeHtml;
  let refreshing = null;
  function historical(incidents, visiteurs) {
    // Original bell definitions and API ordering; do not substitute page filters.
    const open = incidents.filter(i => i.statut !== 'resolu');
    const expected = visiteurs.filter(v => v.statut === 'attendu');
    return { incidents: open.slice(0, 8), visiteurs: expected.slice(0, 5),
      incidentCount: open.length, visitorCount: expected.length };
  }
  async function read() {
    const paths = ['/alerts', '/incidents', '/visiteurs', '/alerts/notifications'];
    const results = await Promise.allSettled(paths.map(path => API.get(path)));
    const data = results.map(r => r.status === 'fulfilled' ? r.value : []);
    const legacy = historical(data[1], data[2]);
    const pending = data[0].filter(a => !a.acknowledged_at && ['NOUVELLE','NOTIFIEE'].includes(a.status));
    // Pending alerts already have an entry; keep every notification in the history.
    return { ...legacy, pending, history: data[3],
      errors: results.map((r, i) => r.status === 'rejected' ? ['Alertes Lot A','Incidents ouverts','Visiteurs attendus','Historique des notifications'][i] : null).filter(Boolean) };
  }
  function badge(model) {
    const dot = document.querySelector('.notif-dot');
    if (!dot) return;
    const total = model.pending.length + model.incidentCount + model.visitorCount;
    dot.style.display = total || model.errors.length ? '' : 'none';
    dot.textContent = total > 0 ? (total > 99 ? '99+' : String(total)) : '';
    dot.parentElement.title = `${model.pending.length} alerte(s) non acquittée(s), ${model.visitorCount} visiteur(s) attendu(s), ${model.incidentCount} incident(s) ouvert(s)` + (model.errors.length ? ' — données partielles' : '');
    dot.parentElement.setAttribute('aria-label', dot.parentElement.title);
    // Rangée SOC dans la sidebar : même compteur d'alertes non acquittées
    // que celui déjà calculé ci-dessus, jamais un second calcul divergent.
    const navBadge = document.getElementById('navAlertesBadge');
    if (navBadge) {
      navBadge.hidden = model.pending.length === 0;
      navBadge.textContent = model.pending.length > 99 ? '99+' : String(model.pending.length);
    }
  }
  function refresh() {
    if (!refreshing) refreshing = read().then(badge).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function open() {
    const model = await read();
    badge(model);
    const alertItems = model.pending.map(a => `<button class="ac-alert" data-bell-alert="${e(a.id)}"><b>Alerte · ${e(a.type)} · N${a.level}</b><span>${e(a.site)} · ${e(a.username)}</span><small>${fmtDateTime(a.created_at)}${a.origin === 'INCIDENT' ? ' · Signal issu d’un incident (objet métier conservé ci-dessous)' : ''}</small></button>`).join('');
    const incidents = model.incidents.map(i => `<div class="alert-item ${i.gravite === 'critique' ? 'danger' : 'warning'}"><div class="alert-content"><div class="alert-title">Incident · ${e(i.ref)} — ${e(i.type)}</div><div class="alert-meta">${e(i.lieu)} • ${fmtDateTime(i.datetime)}</div></div></div>`).join('');
    const visitors = model.visiteurs.map(v => `<div class="alert-item info"><div class="alert-content"><div class="alert-title">Visiteur · ${e(v.prenom || '')} ${e(v.nom || '')}</div><div class="alert-meta">${e(v.societe || '')} • ${fmtDateTime(v.arrivee)}</div></div></div>`).join('');
    const history = model.history.map(n => `<button class="ac-alert" data-bell-notification="${e(String(n.id))}" data-target="${e(n.alert_id)}"><b>${n.read_at ? '' : '● '}${e(n.message)}</b><small>${fmtDateTime(n.created_at)}</small></button>`).join('');
    showModal('Notifications', `${model.errors.length ? `<p role="alert">Données indisponibles : ${model.errors.map(e).join(', ')}. Réouvrez la cloche pour réessayer.</p>` : ''}
      <h3>Alertes Lot A — ${model.pending.length} non acquittée(s)</h3>${alertItems || '<div class="empty-state">Aucune alerte à acquitter</div>'}
      <h3>Incidents à suivre — ${model.incidentCount}</h3>${incidents || '<div class="empty-state">Aucune alerte incident</div>'}${model.incidentCount > 8 ? '<p>8 derniers incidents affichés, comme dans la cloche historique.</p>' : ''}
      <h3>Visiteurs attendus — ${model.visitorCount}</h3>${visitors || '<div class="empty-state">Aucun visiteur en attente</div>'}${model.visitorCount > 5 ? '<p>5 derniers visiteurs affichés, comme dans la cloche historique.</p>' : ''}
      ${history ? `<details><summary>Historique des notifications internes (${model.history.length})</summary>${history}</details>` : ''}`, closeModal, 'Fermer');
    document.querySelectorAll('[data-bell-alert]').forEach(button => {
      button.onclick = async () => { closeModal(); await AlertCenter.openAlert(button.dataset.bellAlert); };
    });
    document.querySelectorAll('[data-bell-notification]').forEach(button => {
      button.onclick = async () => {
        // Reserve the selection at the click, not when marking the notification read completes.
        closeModal();
        const navigation = AlertCenter.openAlert(button.dataset.target);
        const isCurrent = AlertCenter.captureSelection();
        try {
          await API.post('/alerts/notifications/' + button.dataset.bellNotification + '/read', {});
        } catch (err) {
          if(isCurrent()) notify('Lecture de la notification non enregistrée : ' + err.message, 'danger');
        }
        await navigation;
      };
    });
  }
  return { open, refresh };
})();
