// drawer-resize.js: the height drag of a drawer under the map (Phase 25 UI13, b763). Moved out of board-drawer.js (P16-B28b)
// so the board drawer and the sequence drawer (sim-sequence.js) share one copy. No DOM of its own; loaded before board.js.
//
// CONTRACT  window.C4PM_DRAWER = { drawerResize }
//   drawerResize({ drawer, edge, key, cssVar, min, maxFrac, container, enabled? }) -> { set(px), height() }
//     drawer     the drawer element; its height is the CSS variable `cssVar` on it (e.g. '--board-h'; the sheet reads
//                var(cssVar, <default>)), set through style.setProperty, never a style property.
//     edge       the grab strip at its top (null: no drag, set() still works). Dragging it up grows the drawer.
//     key        localStorage key of the height in px (read once here, written after a drag and by set(); every access
//                in try/catch, storage blocked = nothing kept).
//     min, maxFrac  clamp: min px .. maxFrac of container().clientHeight (no max while the container is not measured).
//     enabled    optional: false = a pointerdown on the edge does nothing (a minimized board drawer).
//   set(px)      clamp, apply and store; a non-number or NaN changes nothing. Returns the height in px (null before any).
//   height()     the applied height in px, or null while the sheet's default holds.
(function () {
  'use strict';

  // Phase 35 C (b945): through C4PM_STORE (store.js): the new c4mp.* key, else the old c4pm.* one; writes the new key only.
  function readStore(key) { return window.C4PM_STORE.get(key); }
  function writeStore(key, v) { window.C4PM_STORE.set(key, v); }

  function drawerResize(opts) {
    const drawer = opts.drawer, edge = opts.edge, key = opts.key, cssVar = opts.cssVar;
    const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
    function limits() {
      const c = (opts.container && opts.container()) || drawer.parentNode;
      const h = c && c.clientHeight ? c.clientHeight : 0;
      return { min: opts.min, max: h ? Math.max(opts.min, Math.round(h * opts.maxFrac)) : Infinity };
    }
    const clampH = px => { const l = limits(); return Math.max(l.min, Math.min(l.max, Math.round(px))); };
    let curH = null;
    function applyH(px) {
      curH = clampH(px);
      drawer.style.setProperty(cssVar, curH + 'px');
      return curH;
    }
    function set(px) {
      if (typeof px !== 'number' || !isFinite(px)) return curH;
      const v = applyH(px);
      writeStore(key, String(v));
      return v;
    }
    const stored = Number(readStore(key));
    if (stored > 0 && isFinite(stored)) applyH(stored);

    if (edge) {
      edge.addEventListener('pointerdown', e => {
        if (!enabled()) return;
        if (edge.setPointerCapture && e.pointerId !== undefined) { try { edge.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } }
        if (e.preventDefault) e.preventDefault();
        const y0 = e.clientY;
        const h0 = drawer.getBoundingClientRect().height;
        const move = ev => { applyH(h0 + (y0 - ev.clientY)); };
        const up = ev => {
          edge.removeEventListener('pointermove', move);
          edge.removeEventListener('pointerup', up);
          edge.removeEventListener('pointercancel', up);
          if (edge.releasePointerCapture && ev && ev.pointerId !== undefined) { try { edge.releasePointerCapture(ev.pointerId); } catch (x) { /* ignore */ } }
          if (curH !== null) writeStore(key, String(curH));
        };
        edge.addEventListener('pointermove', move);
        edge.addEventListener('pointerup', up);
        edge.addEventListener('pointercancel', up);
      });
    }
    return { set, height: () => curH };
  }

  window.C4PM_DRAWER = { drawerResize };
})();
