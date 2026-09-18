/**
 * PCS01 (Lot A) — alerte plein écran, impossible à manquer, quelle que soit
 * la page consultée. Isolé du reste de l'app comme sos.js : un flux de
 * sûreté critique ne doit dépendre d'aucun autre état applicatif.
 *
 * Aucune nouvelle donnée : consomme GET /alerts (déjà own/scope-filtré côté
 * serveur, backend/scope.js) — jamais le contenu poussé par SSE lui-même
 * (realtime.js n'envoie jamais que {id, at}), toujours un rechargement via
 * l'API déjà autorisée. Une alerte qu'on ne voit pas dans GET /alerts ne
 * peut jamais déclencher cet overlay pour ce compte — le filtrage own/scope
 * existant est la seule autorité, jamais recalculé ici.
 *
 * Portée volontaire de ce lot : l'accusé de réception reste celui déjà
 * existant côté serveur (POST /alerts/:id/actions, action=ACQUITTEE) —
 * un état PAR ALERTE, pas encore PAR DESTINATAIRE (ça, c'est le lot C,
 * non construit). Réservé au SOC (service.js#act), comme déjà le cas pour
 * toute la Console d'alertes : un compte "own" qui voit son propre SOS
 * peut seulement le consulter (Voir l'alerte), jamais l'acquitter à sa
 * place — jamais un accusé fabriqué côté client.
 */
const CriticalAlert = (() => {
  const CHECK_DEBOUNCE_MS = 400;
  let queue = [];
  const shownIds = new Set();
  let current = null;
  let overlayEl = null;
  let checkTimer = null;
  let started = false;

  // Nombre inclus dans le texte : ne peut pas passer par la correspondance
  // exacte générique de translateText() (walk du DOM sur tout body *) —
  // calculé ici comme pour le KPI "/ N site(s)" du tableau de bord.
  function queueCountLabel(n) {
    const lang = localStorage.getItem(I18N_KEY) || 'fr';
    const word = translateText(n > 1 ? 'autres alertes en attente' : 'autre alerte en attente', lang);
    return '+' + n + ' ' + word;
  }
  function levelLabel(alert) {
    if (alert.origin === 'SOS') return 'SOS';
    if (Number(alert.level) >= 4) return 'URGENT';
    return 'CRITIQUE';
  }

  // Best-effort uniquement : jamais promis si la plateforme/le navigateur
  // le refuse (autoplay bloqué sans geste utilisateur préalable, appareil
  // sans vibration, etc.) — aucune promesse là où la plateforme l'interdit.
  function playAlertSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const beep = (delay, freq) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'square'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.35);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + 0.36);
      };
      beep(0, 880); beep(0.4, 880); beep(0.8, 880);
      setTimeout(() => { try { ctx.close(); } catch { /* déjà fermé */ } }, 1500);
    } catch { /* autoplay refusé ou API absente : jamais bloquant */ }
  }
  function vibrate() {
    try { if (navigator.vibrate) navigator.vibrate([250, 100, 250, 100, 250]); } catch { /* non supporté */ }
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'critical-alert-overlay';
    overlayEl.setAttribute('role', 'alertdialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.hidden = true;
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function render() {
    const el = ensureOverlay();
    if (!current) { el.hidden = true; el.innerHTML = ''; return; }
    const a = current;
    const label = levelLabel(a);
    const canAck = typeof isAdmin === 'function' && isAdmin() && a.status === 'NOTIFIEE';
    const queuedMore = queue.length;
    el.hidden = false;
    el.innerHTML = `
      <div class="critical-alert-panel critical-alert-${label === 'SOS' ? 'sos' : 'critique'}">
        <div class="critical-alert-icon" aria-hidden="true">🚨</div>
        <div class="critical-alert-title">ALERTE</div>
        <div class="critical-alert-badge">${escapeHtml(label)}</div>
        <div class="critical-alert-type">${escapeHtml(a.type || '—')}</div>
        ${a.comment ? `<p class="critical-alert-message">${escapeHtml(a.comment)}</p>` : ''}
        <dl class="critical-alert-meta">
          <div><dt>Site</dt><dd>${escapeHtml(a.site || '—')}</dd></div>
          ${a.zone ? `<div><dt>Zone</dt><dd>${escapeHtml(a.zone)}</dd></div>` : ''}
          <div><dt>Heure</dt><dd>${escapeHtml(fmtDateTime(a.created_at))}</dd></div>
          <div><dt>Émetteur</dt><dd><span>${escapeHtml(a.origin === 'SOS' ? 'SOS terrain' : 'PCS01')}</span> — ${escapeHtml(a.username || '—')}</dd></div>
          <div><dt>Référence</dt><dd>${escapeHtml(a.id)}</dd></div>
        </dl>
        ${queuedMore ? `<div class="critical-alert-queue-count">${escapeHtml(queueCountLabel(queuedMore))}</div>` : ''}
        <div class="critical-alert-actions">
          ${canAck ? '<button type="button" class="btn btn-primary" id="criticalAlertAck">Accuser réception</button>' : ''}
          <button type="button" class="btn btn-outline" id="criticalAlertView">Voir l’alerte</button>
        </div>
        <p class="critical-alert-hint">${canAck ? 'L’accusé de réception est enregistré côté serveur.' : 'Consultez le Centre d’alertes pour la suite du traitement.'}</p>
      </div>`;
    const ackBtn = document.getElementById('criticalAlertAck');
    if (ackBtn) ackBtn.onclick = acknowledge;
    document.getElementById('criticalAlertView').onclick = viewInAlertCenter;
  }

  async function acknowledge() {
    if (!current) return;
    const btn = document.getElementById('criticalAlertAck');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
    try {
      await API.post(`/alerts/${encodeURIComponent(current.id)}/actions`, { action: 'ACQUITTEE' });
      notify('Alerte accusée — SOC notifié', 'success');
    } catch (e) {
      // 409 (déjà traitée par un autre opérateur) ou toute autre erreur :
      // jamais un accusé fabriqué côté client si le serveur l'a refusé —
      // on ferme quand même (l'alerte reste visible/traitable depuis le
      // Centre d'alertes), sans jamais prétendre l'avoir enregistré.
      notify(e.message && e.message.includes('Transition') ? 'Déjà prise en charge par un autre opérateur' : 'Échec de l’accusé de réception : ' + (e.message || 'réessayez'), 'warning');
    } finally {
      advance();
    }
  }
  function viewInAlertCenter() {
    const id = current ? current.id : null;
    advance();
    if (id && typeof AlertCenter !== 'undefined') AlertCenter.openAlert(id);
  }
  function advance() {
    current = queue.shift() || null;
    render();
    if (current) { playAlertSound(); vibrate(); }
  }

  async function checkForCritical() {
    if (checkTimer) return; // une vérification déjà en vol suffit
    checkTimer = setTimeout(() => { checkTimer = null; }, CHECK_DEBOUNCE_MS);
    try {
      const alerts = await API.get('/alerts');
      const candidates = alerts.filter(a =>
        a.status === 'NOTIFIEE' && (a.origin === 'SOS' || Number(a.level) >= 3) && !shownIds.has(a.id));
      if (!candidates.length) return;
      // Priorité SOS d'abord, puis niveau décroissant, puis le plus ancien
      // en premier (ordre serveur — created_at, jamais un ordre du client).
      candidates.sort((a, b) =>
        (b.origin === 'SOS') - (a.origin === 'SOS') || b.level - a.level || (a.created_at < b.created_at ? -1 : 1));
      for (const a of candidates) { shownIds.add(a.id); queue.push(a); }
      if (!current) advance();
      else render(); // rien de nouveau à l'écran, juste le compteur "+N en attente"
    } catch { /* dégradation silencieuse : un prochain événement/poll réessaiera */ }
  }

  function start() {
    if (started) return;
    started = true;
    ensureOverlay();
    if (typeof Realtime !== 'undefined') Realtime.on(() => checkForCritical());
    checkForCritical(); // couvre aussi une alerte déjà en attente à l'ouverture de session
  }

  return { start, checkForCritical };
})();
