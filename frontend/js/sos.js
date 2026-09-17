/**
 * PG-15 — bouton de détresse (SOS). Volontairement isolé de app.js : un flux
 * de sûreté critique ne doit dépendre d'aucune autre page ni état applicatif.
 * Aucune IA n'intervient ici, et ne doit jamais le faire (voir docs/sos.md) :
 * ce module n'appelle que POST /api/alerts/sos, un chemin entièrement humain
 * et déterministe.
 *
 * Interaction : appui MAINTENU (pas un simple clic) — sous contrainte réelle,
 * un appui accidentel ne doit pas déclencher une fausse alerte, mais aucune
 * boîte de confirmation ne doit non plus ralentir un déclenchement réel.
 */
const SOS = (() => {
  const HOLD_MS = 1500;
  // PG-15 + UI 2.0 : le bouton existe maintenant à deux endroits (topbar,
  // toujours visible ; bannière du tableau de bord, comme le modèle validé)
  // — même déclencheur, câblé sur chaque instance trouvée dans le DOM au
  // lieu d'un id unique. L'état (holding/submitting) reste global : un seul
  // envoi possible à la fois, quel que soit le bouton utilisé, exactement
  // comme avant ce changement.
  let holding = false, submitting = false, raf = null, startedAt = 0;
  let activeBtn = null, activeFill = null;

  function allButtons() { return [...document.querySelectorAll('.sos-trigger')]; }

  function reset() {
    holding = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (activeFill) activeFill.style.transform = 'scaleX(0)';
    if (activeBtn) activeBtn.classList.remove('sos-holding');
    activeBtn = null; activeFill = null;
  }

  function tick() {
    if (!holding) return;
    const elapsed = Date.now() - startedAt;
    const progress = Math.min(elapsed / HOLD_MS, 1);
    if (activeFill) activeFill.style.transform = `scaleX(${progress})`;
    if (progress >= 1) { trigger(); return; }
    raf = requestAnimationFrame(tick);
  }

  function start(btn) {
    if (submitting || holding) return;
    holding = true; startedAt = Date.now();
    activeBtn = btn;
    activeFill = btn.querySelector('.sos-fill');
    btn.classList.add('sos-holding');
    raf = requestAnimationFrame(tick);
  }
  function cancel() { if (holding) reset(); }

  async function trigger() {
    const buttons = allButtons();
    reset();
    if (submitting) return;
    submitting = true;
    buttons.forEach(b => { b.disabled = true; });
    try {
      await API.post('/alerts/sos', {});
      notify('SOS envoyé — le SOC a été alerté', 'danger');
    } catch (e) {
      notify('Échec de l’envoi SOS : ' + (e.message || 'réessayez'), 'danger');
    } finally {
      submitting = false;
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  function wire(b) {
    b.addEventListener('pointerdown', e => { e.preventDefault(); start(b); });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    // Clavier : Entrée/Espace maintenus déclenchent le même appui progressif
    // qu'un pointeur — évite qu'un utilisateur au clavier n'ait aucun moyen
    // d'activer le bouton.
    b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); start(b); } });
    b.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') cancel(); });
  }

  function init() {
    allButtons().forEach(wire);
  }

  return { init };
})();
