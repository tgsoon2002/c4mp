// viewState.js: the view state kept across reloads of the same tab (Phase 30 SV9a, b642 part 1). Works in the static page
// too (a reload of c4mpView.html keeps the view); does not need c4pm serve.
// Spec: Document/Roadmap/Phase30/PHASE_30_PLAN.md section 5 SV9a. Loaded after sim-panel.js (src/page/html.ts VIEWER_SCRIPTS);
// later scripts add their own parts through C4PM_VIEWSTATE.part (SV9b) without editing this file.
//
// Where it is kept
//   sessionStorage['c4pm.view:' + C4PM_DATA.repoPath]: one JSON object { v: 1, <part name>: <value>, ... } per tab, read
//   and written in try/catch (storage blocked = nothing is kept; the page renders as without this file). Values of a part
//   not registered on this page (its owner is absent) are kept as they were.
//   The hash (shareable): the view stays the first part (mode.js); this file adds 'sel=<id>' (URI-encoded) after the other
//   extras ('&bare', sim.js 'sim', 'step', 'seqonly', ...), written with history.replaceState (no history entry, no
//   hashchange; else location.hash). A hash sel wins over the stored one; a hashchange that brings a new sel selects it.
// Parts (in restore order): view (C4PM_MODE.get(); a view named by the hash wins), overlays (C4PM_MAP.overlays booleans),
//   sel (the selected c-item id), sim ({ id, step } of C4PM_SIM), cam, search ({ q, mode }: the typed text and Names /
//   Content), then the parts other scripts add. SV9b: tree (tree.js), panel (panel.js), board (board-drawer.js), timeline
//   (board-timeline.js), io (ioView.js), storage (storageView.js); they load before this file and add their part at
//   DOMContentLoaded (tree.js on a 0 ms timer from its build), always before the restore and after the parts above.
//   cam = { view, id, z, ox, oy, px }: id = the deepest node of the current tree whose region holds the screen centre (the
//   root when none), z = map.cam.s / fitCam(node).s, ox / oy = the centre's offset from the node's centre in node widths /
//   heights, px = the raw { s, tx, ty }, used only when the node is gone. A camera of another view, or one that cannot be
//   rebuilt, is skipped: the Fit camera stays.
// When
//   Saved on pagehide, C4PM_MODE.onChange, C4PM_MAP.onSelect, C4PM_SIM.onChange, 300 ms after the camera stops moving
//   (a post-draw function: C4PM_STATE.post, so flyTo frames count too) and by save(). Nothing is saved before the restore
//   ran (the first fit would overwrite the kept state).
//   Restored once, 120 ms after DOMContentLoaded (after the first fit; sim.js applyHash timing). When a part of the
//   restore changes the map's size (#map-wrap; the board drawer opens), the camera is applied again when the map takes
//   the new size (the zoom ratio is relative to the map's size). An id that no longer
//   exists is skipped. No restore while the hash gives a simulation ('sim='): sim.js applies it. A hash sel that differs
//   from the stored one flies to that node instead of restoring the stored camera.
//
// CONTRACT  window.C4PM_VIEWSTATE = { save, restore, part }
//   save()          write every part to sessionStorage (a no-op before the restore ran).
//   restore()       read sessionStorage and the hash, set every part in order (each in try/catch: one bad part never stops
//                   the others), then write the hash sel. Saves made by the parts' own changes are held until it ends.
//   part(name, { get, set })  add a part: get() -> a JSON value (undefined = not kept), set(value) applies a kept value.
//                   A part added after the restore ran gets its kept value at once. A bad name or spec throws; a name
//                   already taken throws.
// A page without a map (no C4PM_DATA.root): this file returns at once and C4PM_VIEWSTATE stays undefined.
(function () {
  'use strict';
  const data = window.C4PM_DATA;
  const ST = window.C4PM_STATE, MAP = window.C4PM_MAP, MODE = window.C4PM_MODE, CAM = window.C4PM_CAM;
  if (!data || !data.root || !ST || !MAP || !MODE || !CAM) return;

  const KEY = 'c4pm.view:' + (data.repoPath || data.title || '');   // b914: a source-less page has repoPath '' -> its title
  const parts = new Map();   // name -> { get, set }, in restore order
  let ready = false;         // the restore ran (or was skipped): saves may write
  let busy = false;          // inside restore(): the parts' own change events do not save
  let kept = {};             // the object last read or written (a part added after the restore gets its value from it)
  let pendingCam = null;     // a camera restored before the map had a size: applied on the first draw
  let camTimer = null, lastCam = '';

  const fin = v => typeof v === 'number' && isFinite(v);
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

  function readStore() {
    try {
      const raw = window.sessionStorage.getItem(KEY);
      const o = raw ? JSON.parse(raw) : null;
      return isObj(o) ? o : {};
    } catch (err) { return {}; }   // storage blocked or a bad value: nothing kept
  }
  function writeStore(o) {
    try { window.sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (err) { /* storage blocked: nothing kept */ }
  }

  // ----- hash -----
  const hashParts = () => ((window.location && window.location.hash) || '').replace(/^#/, '').split('&');
  function hashValue(key) {
    let v = null;
    hashParts().slice(1).forEach(x => {
      if (x.indexOf(key + '=') !== 0) return;
      try { v = decodeURIComponent(x.slice(key.length + 1)); } catch (err) { /* a bad escape: the part is ignored */ }
    });
    return v || null;
  }
  const hashView = () => { const h = hashParts()[0]; return h && MODE.has(h) ? h : null; };
  // Replace the hash without a history entry: replaceState when the page may use it, else location.hash.
  function setHash(h) {
    const L = window.location;
    if (!L) return;
    const H = window.history;
    try {
      if (H && typeof H.replaceState === 'function') { H.replaceState(H.state, '', String(L.href || '').split('#')[0] + h); return; }
    } catch (err) { /* e.g. a file: page that may not replace its URL: fall back */ }
    try { L.hash = h; } catch (err) { /* no hash: nothing shared */ }
  }
  // The hash with `head` as the view part and sel=<id> (none when id is null) after the other extras.
  function hashWith(head, id) {
    const rest = hashParts().slice(1).filter(x => x && x.indexOf('sel=') !== 0);
    if (id) rest.push('sel=' + encodeURIComponent(id));
    return '#' + [head].concat(rest).join('&');
  }
  function writeHashSel() {
    const id = MAP.selectedId() || null;
    if (hashValue('sel') === id) return;
    setHash(hashWith(hashParts()[0] || MODE.get(), id));
  }

  // ----- camera -----
  function nodeAt(wx, wy) {
    let f = ST.data.root;
    for (;;) {
      const hit = (f.children || []).find(c => c.w > 0 && c.h > 0 && wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h);
      if (!hit) return f;
      f = hit;
    }
  }
  function camOf() {
    const m = ST.map, c = m.cam;
    if (!c || !(m.cw > 0) || !(m.ch > 0) || !(c.s > 0)) return undefined;
    const out = { view: MODE.get(), px: { s: c.s, tx: c.tx, ty: c.ty } };
    const wx = (m.cw / 2 - c.tx) / c.s, wy = (m.ch / 2 - c.ty) / c.s;
    const n = nodeAt(wx, wy);
    if (n && n.w > 0 && n.h > 0) {
      const z = c.s / CAM.fitCam(n).s, ox = (wx - (n.x + n.w / 2)) / n.w, oy = (wy - (n.y + n.h / 2)) / n.h;
      if (fin(z) && fin(ox) && fin(oy)) Object.assign(out, { id: n.id, z, ox, oy });
    }
    return out;
  }
  // The camera of a kept value, or null (another view, the node gone and no usable px, a bad number).
  function camFor(v) {
    if (!isObj(v) || (v.view && v.view !== MODE.get())) return null;
    const m = ST.map;
    const n = typeof v.id === 'string' ? ST.nodeById[v.id] : null;
    let cam = null;
    if (n && n.w > 0 && n.h > 0 && fin(v.z) && v.z > 0 && fin(v.ox) && fin(v.oy)) {
      const s = CAM.fitCam(n).s * v.z;
      const cx = n.x + n.w / 2 + v.ox * n.w, cy = n.y + n.h / 2 + v.oy * n.h;
      cam = { s, tx: m.cw / 2 - cx * s, ty: m.ch / 2 - cy * s };
    } else if (isObj(v.px)) {
      cam = { s: v.px.s, tx: v.px.tx, ty: v.px.ty };
    }
    return cam && fin(cam.s) && cam.s > 0 && fin(cam.tx) && fin(cam.ty) ? cam : null;
  }
  function applyCam(v) {
    const m = ST.map;
    if (!(m.cw > 0) || !(m.ch > 0)) { pendingCam = v; return; }   // not sized yet: the first draw applies it
    const cam = camFor(v);
    if (!cam) return;   // the Fit camera stays
    cancelAnimationFrame(m.anim);
    m.cam = cam;
    if (ST.requestDraw) ST.requestDraw();
  }
  // The kept camera is relative to the map's size. A part restored after it that changes that size (SV9b: the board drawer
  // opens) makes the map resize later (map.js's ResizeObserver keeps the centre and the scale, so the zoom ratio would be off):
  // the camera is applied again at the new size, by an observer of #map-wrap made after map.js's (so called after it) and
  // dropped on its first call.
  function camAfterResize(v) {
    const wrap = document.getElementById('map-wrap'), m = ST.map;
    if (pendingCam || !wrap || typeof ResizeObserver !== 'function' || !(m.cw > 0) || !(m.ch > 0)) return;
    if (wrap.clientWidth === m.cw && wrap.clientHeight === m.ch) return;   // the size did not change
    const cw = m.cw, ch = m.ch;
    const ro = new ResizeObserver(() => {
      ro.disconnect();
      if (m.cw === cw && m.ch === ch) return;   // map.js has not taken a new size: nothing to correct
      try { applyCam(v); } catch (err) { /* the camera stays as the resize left it */ }
    });
    ro.observe(wrap);
  }
  // Post-draw: a pending camera, then the debounced save after a camera move.
  ST.post.push(m => {
    if (pendingCam && m.cw > 0 && m.ch > 0) {
      const v = pendingCam;
      pendingCam = null;
      try { applyCam(v); } catch (err) { /* the Fit camera stays */ }
      return;
    }
    const c = m.cam;
    const sig = c ? c.s + ',' + c.tx + ',' + c.ty : '';
    if (sig === lastCam) return;
    lastCam = sig;
    if (!ready || busy) return;
    if (camTimer !== null) clearTimeout(camTimer);
    camTimer = ST.later(() => { camTimer = null; save(); }, 300);
  });

  // ----- save / restore -----
  function save() {
    if (!ready || busy) return;
    const o = Object.assign({}, kept, { v: 1 });
    parts.forEach((p, name) => {
      try {
        const v = p.get();
        if (v === undefined) delete o[name];
        else o[name] = v;
      } catch (err) { /* this part is not kept this time */ }
    });
    kept = o;
    writeStore(o);
  }

  function restore() {
    const st = readStore();
    const hsel = hashValue('sel');
    const vals = Object.assign({}, st);
    if (hsel) vals.sel = hsel;
    const fly = hsel && hsel !== st.sel;   // a shared link: show that node, not this tab's old camera
    if (fly) delete vals.cam;
    busy = true;
    try {
      parts.forEach((p, name) => {
        if (!Object.prototype.hasOwnProperty.call(vals, name)) return;
        try { p.set(vals[name]); } catch (err) { console.debug('[C4PM_VIEWSTATE] restore: part ' + name + ' skipped', err); }
      });
      if (vals.cam !== undefined) camAfterResize(vals.cam);
      if (fly && MAP.nodeById(hsel)) MAP.flyTo(hsel);
    } finally {
      busy = false;
    }
    kept = st;
    ready = true;
    writeHashSel();
    save();
  }

  function part(name, spec) {
    if (typeof name !== 'string' || !name || name === 'v') throw new Error('C4PM_VIEWSTATE.part: the name must be a non-empty string other than "v"');
    if (parts.has(name)) throw new Error('C4PM_VIEWSTATE.part: a part named ' + JSON.stringify(name) + ' is already added');
    if (!spec || typeof spec.get !== 'function' || typeof spec.set !== 'function') throw new Error('C4PM_VIEWSTATE.part(' + JSON.stringify(name) + '): spec needs get() and set() functions');
    parts.set(name, { get: spec.get, set: spec.set });
    if (ready && Object.prototype.hasOwnProperty.call(kept, name)) {
      try { spec.set(kept[name]); } catch (err) { console.debug('[C4PM_VIEWSTATE] part ' + name + ': kept value skipped', err); }
    }
  }

  // ----- the parts of this file -----
  part('view', {
    get: () => MODE.get(),
    set: v => {
      if (hashView() || typeof v !== 'string' || v === MODE.get() || !MODE.has(v)) return;   // a view in the hash wins
      setHash(hashWith(v, null));
      MODE.set(v);   // replaceState fires no hashchange (a location.hash fallback does: mode.js then finds the mode set)
    },
  });
  part('overlays', {
    get: () => {
      const o = {};
      Object.keys(MAP.overlays).forEach(k => { if (typeof MAP.overlays[k] === 'boolean') o[k] = MAP.overlays[k]; });
      return o;
    },
    set: v => {
      if (!isObj(v)) return;
      let changed = false;
      Object.keys(MAP.overlays).forEach(k => {
        if (typeof v[k] === 'boolean' && v[k] !== MAP.overlays[k]) { MAP.setOverlay(k, v[k]); changed = true; }
      });
      const P = window.C4PM_PANEL_PARTS;   // the legend's checkboxes follow (panel.js redraws it the same way on a mode change)
      if (changed && P && P.legend && typeof P.legend.setup === 'function') P.legend.setup();
    },
  });
  part('sel', {
    get: () => MAP.selectedId() || null,
    set: id => { if (typeof id === 'string' && MAP.nodeById(id)) MAP.select(id); },
  });
  part('sim', {
    get: () => {
      const S = window.C4PM_SIM;
      return S ? { id: S.selected(), step: S.step() } : undefined;
    },
    set: v => {
      const S = window.C4PM_SIM;
      if (!S || !isObj(v) || typeof v.id !== 'string' || !S.byId(v.id)) return;
      if (S.selected() !== v.id) S.select(v.id, { fit: false });   // the kept camera follows (part cam)
      if (Number.isInteger(v.step)) S.go(v.step);
    },
  });
  part('cam', { get: camOf, set: applyCam });
  part('search', {
    get: () => {
      const input = document.getElementById('search');
      const SE = window.C4PM_SEARCH;
      if (!input) return undefined;
      return { q: String(input.value || ''), mode: SE && typeof SE.mode === 'function' ? SE.mode() : null };
    },
    set: v => {
      const input = document.getElementById('search');
      if (!isObj(v) || !input) return;
      const SE = window.C4PM_SEARCH, SET = window.C4PM_SETTINGS;
      // The Names / Content switch writes the 'search' setting; the kept mode goes back through it.
      if (SE && SET && typeof v.mode === 'string' && SE.mode() !== v.mode && SET.DEF.search.opts.some(o => o[0] === v.mode)) SET.set('search', v.mode);
      if (typeof v.q !== 'string' || !v.q || input.value === v.q) return;
      input.value = v.q;
      if (typeof input.dispatchEvent === 'function' && typeof Event === 'function') input.dispatchEvent(new Event('input'));
    },
  });

  // ----- when -----
  MODE.onChange(() => save());
  MAP.onSelect(() => {
    if (!ready || busy) return;
    save();
    ST.later(writeHashSel, 0);   // after this event: a hashchange that changed the view and brings a sel selects it first
  });
  if (window.C4PM_SIM) window.C4PM_SIM.onChange(() => save());
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => save());
    window.addEventListener('hashchange', () => {
      const id = hashValue('sel');
      if (ready && id && id !== MAP.selectedId() && MAP.nodeById(id)) MAP.select(id);
    });
  }

  // ST.later (state.js): a page without timers (a vm test page) restores at once.
  const start = () => ST.later(() => {
    if (hashValue('sim')) { kept = readStore(); ready = true; return; }   // sim.js applies the simulation hash
    restore();
  }, 120);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.C4PM_VIEWSTATE = { save, restore, part };
})();
