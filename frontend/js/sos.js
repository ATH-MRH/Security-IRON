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
  let holding = false, submitting = false, raf = null, startedAt = 0;

  function el() { return document.getElementById('sosButton'); }
  function fill() { return document.getElementById('sosFill'); }

  function reset() {
    holding = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    const f = fill();
    if (f) f.style.transform = 'scaleX(0)';
    const b = el();
    if (b) b.classList.remove('sos-holding');
  }

  function tick() {
    if (!holding) return;
    const elapsed = Date.now() - startedAt;
    const progress = Math.min(elapsed / HOLD_MS, 1);
    const f = fill();
    if (f) f.style.transform = `scaleX(${progress})`;
    if (progress >= 1) { trigger(); return; }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (submitting || holding) return;
    holding = true; startedAt = Date.now();
    const b = el();
    if (b) b.classList.add('sos-holding');
    raf = requestAnimationFrame(tick);
  }
  function cancel() { if (holding) reset(); }

  async function trigger() {
    reset();
    if (submitting) return;
    submitting = true;
    const b = el();
    if (b) b.disabled = true;
    try {
      await API.post('/alerts/sos', {});
      notify('SOS envoyé — le SOC a été alerté', 'danger');
    } catch (e) {
      notify('Échec de l’envoi SOS : ' + (e.message || 'réessayez'), 'danger');
    } finally {
      submitting = false;
      if (b) b.disabled = false;
    }
  }

  function init() {
    const b = el();
    if (!b) return;
    b.addEventListener('pointerdown', e => { e.preventDefault(); start(); });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    // Clavier : Entrée/Espace maintenus déclenchent le même appui progressif
    // qu'un pointeur — évite qu'un utilisateur au clavier n'ait aucun moyen
    // d'activer le bouton.
    b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); start(); } });
    b.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') cancel(); });
  }

  return { init };
})();
