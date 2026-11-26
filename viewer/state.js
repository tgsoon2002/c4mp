// state.js: the shared viewer state (LAY-12a, b377). Created here, before every script that reads it
// (camera.js, render.js, controls.js, ioView.js, storageView.js, map.js), so nobody reads a global that a later script defines.
(function() {
  const data = window.C4PM_DATA;
  if (!data || !data.root) return;   // no data: C4PM_STATE stays undefined (map.js shows the "No data" message)

  const map = { cam: null, cw: 0, ch: 0, canvas: null, ctx: null, alpha: {}, raf: 0, anim: 0, pulse: 0, ro: null, selectedId: null, listeners: [],
    // The flag below is true while any node's displayed openness is still easing toward its target;
    // draw() resets it each frame and keeps requesting frames while it is set.
    autoLevel: true, lockDepth: -1, animating: false,
    edit: false, drag: null, opens: [], history: { undo: [], redo: [] },
    hoverId: null,   // b908: the node under the pointer (controls.js), null when none; foundation boxes show their incoming arrows
    hi: null,     // P16-B30b: Set of lit c-item node ids while a board item is selected, else null
    impl: null, implN: null,     // b130: Set of arch node ids ringed by 'Light implemented components' + {id: screen calls incl. descendants}, else null
    // Phase 25 (UI4, b754): the lit state of the selected s-item for the current view, set by sim.js (UI3), read by the
    // post-draw overlays; null while no s-item is selected (then nothing is drawn and the page looks as before).
    sim: null,
    openEarly: null,             // Phase 25 (UI8): Set of arch node ids that open at 20% (of the visible band, openBand) instead of 45% (camera.js openness); a lit code box inside a lit component follows it (camera.js follows); else null
    openBand: null };            // Phase 25 (b786): { top, bottom } px of the map the sim camera fitted into (set by sim-strip.js / sim-present.js); camera.js measures early ids against it; null = the whole map

  // Filled by map.js (loadTree indexes the nodes of the current tree).
  const nodeById = {};
  // Original rects taken when a tree is first loaded, so Reset layout can restore them (edits are in memory only).
  const origRects = {};

  // Overlay switches (the legend checkboxes); render.js reads them at draw time, map.js setOverlay writes them.
  const overlays = {
    drift: true,
    findings: true,
    stubs: true,
    impl: true,    // b130: ring on components screens call (nothing is drawn unless setting lightImpl is on)
    board: true,   // P16-B29: count badge on boxes that board items link to (nothing is drawn when no node has boardCount)
    tests: true,   // Phase 26 (T26-10): test count pill on boxes with tests (nothing is drawn when no node has tests)
  };

  // Post-draw functions (Phase 25 UI4, b754): map.js draw calls each one as fn(map, C, now) every frame, after the view
  // has drawn (arch passes or a view renderer) and before the HUD update; overlays (sim-map.js) push themselves here.
  const post = [];

  // Timing helpers (Phase 30, SV9b fix). The viewer must not assume timers exist (the vm test pages have none).
  //   later(fn, ms)   setTimeout(fn, ms) when the page has setTimeout (returns its id), else fn() at once (returns null).
  //   whenReady(fn)   run fn after the page loaded: at DOMContentLoaded while the document is loading, else on the next
  //                   timer (later(fn, 0)). Here, not in viewState.js, because the scripts that use it load before
  //                   viewState.js and call it at their load; every one of them loads after this file.
  function later(fn, ms) {
    if (typeof setTimeout === 'function') return setTimeout(fn, ms || 0);
    fn();
    return null;
  }
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else later(fn, 0);
  }

  window.C4PM_STATE = { map, data, nodeById, origRects, overlays, post, requestDraw: null, draw: null, later, whenReady };
})();
