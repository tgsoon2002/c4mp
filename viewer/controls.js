// controls.js: HUD, buttons, input. Filled by P14-G4a, G4b.
(function() {
  const st = () => window.C4PM_STATE;   // created by state.js: { map, data, nodeById, origRects, overlays, requestDraw, draw }; read at CALL time only
  // b644 (SV10): C4PM_LIVE when this page is served by c4mp serve (it has request), else null (the static page).
  const liveApi = () => { const L = window.C4PM_LIVE; return L && typeof L.request === 'function' ? L : null; };

  // VIEW-0 (b337): the renderer of the current view (e.g. the IO view, ioView.js), null when the architecture engine draws it;
  // spec = its C4PM_VIEWS entry (mode.js registerView).
  const renderer = () => window.C4PM_MODE.renderer();
  const viewSpec = () => window.C4PM_VIEWS[window.C4PM_MODE.get()];

  // Update HUD text
  function updateHud() {
    const { map } = st();
    const hudLevel = document.getElementById('hud-level');
    const hudSub = document.getElementById('hud-sub');
    if (!hudLevel || !hudSub) return;
    const R = renderer();
    if (R) {   // a renderer view (IO): its own HUD word (IO: the kind of what fills the view, else the entry kinds present); chip in the view colour, no level lock
      const spec = viewSpec();
      if (!spec.color) throw new Error('C4PM view ' + JSON.stringify(window.C4PM_MODE.get()) + ' has a renderer but no color for the HUD chip');
      hudLevel.textContent = R.hud();
      hudSub.textContent = '';
      hudLevel.style.background = 'var(--' + spec.color + ')';
      hudLevel.style.color = '#fff';
      return;
    }
    const f = window.C4PM_CAM.focusNode();

    // b142: the HUD word comes from the kind table (C4PM_MODE.word, mode.js). Nothing open: the root's kind (C1-CTX: a
    // 'context' root reads System context, a 'system' root System)
    const root = st().data.root;
    const kind = f ? f.kind : (root && root.kind) || 'system';
    const lbl = (window.C4PM_MODE && window.C4PM_MODE.word(kind)) || 'C1 · System';
    hudLevel.textContent = lbl;
    hudSub.textContent = map.autoLevel ? '' : '· level locked';
    if (f) {
      // The HUD chip shows the C1/C2/C3 level colours only; any other colour key (person, file, screen...) keeps the C1 chip.
      const lv = window.C4PM_MODE ? window.C4PM_MODE.color(f.kind) : null;
      const lvl = lv === 'c2' || lv === 'c3' ? lv : 'c1';
      hudLevel.style.background = `var(--${lvl})`;
      hudLevel.style.color = lvl === 'c3' ? 'var(--c3-ink)' : '#fff';
    } else {
      hudLevel.style.background = 'var(--c1)';
      hudLevel.style.color = '#fff';
    }
  }

  // Undo / Redo buttons: disabled when their stack is empty.
  function syncHistoryButtons() {
    const { map } = st();
    const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
    if (u) u.disabled = map.history.undo.length === 0;
    if (r) r.disabled = map.history.redo.length === 0;
  }

  // P20-T5-F (b260): the edit-layout buttons act on the architecture layout, so a renderer view (IO) hides all of them.
  // In arch: btn-edit always shows; reset/arrange/undo/redo/export show only in edit mode (undo/redo's disabled state is
  // syncHistoryButtons', arrange's syncArrangeButton's).
  function syncEditButtons() {
    const { map } = st();
    const own = !!renderer();
    const e = document.getElementById('btn-edit');
    if (e) e.hidden = own;
    ['btn-up', 'btn-auto'].forEach(id => { const b = document.getElementById(id); if (b) b.hidden = own; });   // a renderer view (IO) has no levels
    syncHint();
    ['btn-reset', 'btn-arrange', 'btn-undo', 'btn-redo', 'btn-export'].forEach(id => { const b = document.getElementById(id); if (b) b.hidden = own || !map.edit; });
    syncArrangeButton();
  }

  // SR3 (b693): Auto arrange is enabled in edit mode when a container or a subregion is selected. Runs on every selection
  // (registered on map.listeners in wireButtons) and every edit-mode change (syncEditButtons).
  function syncArrangeButton() {
    const { map, nodeById } = st();
    const b = document.getElementById('btn-arrange');
    if (!b) return;
    const sel = map.selectedId ? nodeById[map.selectedId] : null;
    b.disabled = !(map.edit && sel && (sel.kind === 'container' || sel.kind === 'subregion'));
  }

  // Fill header with data
  function fillHeader() {
    const { data } = st();
    syncEditButtons();
    if (renderer()) {   // P20-T5-F (b260), VIEW-0 (b337): a renderer view (IO) shows its label as title and its chips(C4PM_DATA)
      const spec = viewSpec();
      const ft = document.getElementById('title');
      if (ft) { ft.textContent = spec.label; ft.title = data.subtitle || ''; }
      const fs = document.getElementById('subtitle');
      if (fs) fs.textContent = data.subtitle || '';
      const fsum = document.getElementById('summary');
      if (fsum) fsum.textContent = data.summary || '';
      const fchips = document.getElementById('bar-chips');
      if (fchips) fchips.textContent = withSims(spec.chips ? spec.chips(window.C4PM_DATA) : '');
      return;
    }
    const title = document.getElementById('title');
    const subtitle = document.getElementById('subtitle');
    const summary = document.getElementById('summary');
    const driftSummary = document.getElementById('drift-summary');

    if (title) {
      title.textContent = data.title || 'C4 Map';
      title.title = data.subtitle || '';   // hover shows commit and date
    }
    if (subtitle) subtitle.textContent = data.subtitle || '';
    if (summary) summary.textContent = data.summary || '';
    if (driftSummary && data.drift) {
      driftSummary.textContent = data.drift.summary || '';
    }
    const chips = document.getElementById('bar-chips');
    if (chips) {
      // counts from the tree and data.files (the summary text is not parsed)
      let containers = 0, components = 0;
      (function walk(n) {
        if (!n) return;
        if (n.kind === 'container') containers++;
        else if (n.kind === 'component') components++;
        (n.children || []).forEach(walk);
      })(data.root);
      const files = (data.files || []).filter(f => f.kind === 'source').length;
      chips.textContent = withSims(containers + ' container' + (containers === 1 ? '' : 's') + ' · ' +
        components + ' component' + (components === 1 ? '' : 's') + ' · ' + files + ' file' + (files === 1 ? '' : 's'));
    }
  }
  // UI5 (b755): the header chips end with '· N simulations' when the page has s-items (C4PM_DATA.sims), in every view.
  function withSims(text) {
    const sims = window.C4PM_DATA && window.C4PM_DATA.sims;
    const n = Array.isArray(sims) ? sims.length : 0;
    if (!n) return text;
    const chip = n + ' simulation' + (n === 1 ? '' : 's');
    return text ? text + ' · ' + chip : chip;
  }

  // The (i) and gear buttons each toggle a popover (#details-pop, #settings-pop); Esc and a click outside close it,
  // and opening one closes the other (P20-T11, b232). Every lookup is null-checked (the fake DOM of the tests has none of these ids).
  function wirePopups() {
    const pops = [['btn-details', 'details-pop'], ['btn-gear', 'settings-pop']].map(ids => ({
      btn: document.getElementById(ids[0]), pop: document.getElementById(ids[1]),
    })).filter(p => p.btn && p.pop);
    const set = (p, open) => { p.pop.hidden = !open; p.btn.setAttribute('aria-expanded', String(open)); };
    pops.forEach(p => {
      p.btn.addEventListener('click', e => {
        if (e && e.stopPropagation) e.stopPropagation();
        const open = p.pop.hidden;
        pops.forEach(q => set(q, q === p && open));
      });
    });
    document.addEventListener('keydown', e => { if (e && e.key === 'Escape') pops.forEach(p => { if (!p.pop.hidden) set(p, false); }); });
    document.addEventListener('click', e => {
      const t = e && e.target;
      pops.forEach(p => {
        if (p.pop.hidden) return;
        if (t && typeof p.pop.contains === 'function' && (p.pop.contains(t) || p.btn.contains(t))) return;
        set(p, false);
      });
    });
  }

  // Settings popup body, built from the C4PM_SETTINGS.DEF table (one row per key, one button per allowed value).
  // The pressed button follows C4PM_SETTINGS.get, also when another script (the search switch) changes a value.
  function buildSettings() {
    const pop = document.getElementById('settings-pop');
    if (!pop) return;
    const S = window.C4PM_SETTINGS;
    const title = document.createElement('div');
    title.className = 'set-title';
    title.textContent = 'Settings';
    // P33: the build that made the page (C4PM_DATA.toolVersion 'c4pm@0.8.2' shown as 'c4pm 0.8.2'), top-right; none on an old page.
    const D = window.C4PM_DATA;
    if (D && typeof D.toolVersion === 'string' && D.toolVersion) {
      const ver = document.createElement('span');
      ver.className = 'set-version';
      ver.textContent = D.toolVersion.replace('@', ' ');
      title.appendChild(ver);
    }
    pop.appendChild(title);
    const segs = {};
    Object.keys(S.DEF).forEach(key => {
      const d = S.DEF[key];
      const row = document.createElement('div');
      row.className = 'set-row';
      const lab = document.createElement('div');
      lab.className = 'set-l';
      lab.textContent = d.label;
      row.appendChild(lab);
      const seg = document.createElement('span');
      seg.className = 'seg';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', d.label);
      segs[key] = [];
      d.opts.forEach(o => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = o[1];
        b.addEventListener('click', () => S.set(key, o[0]));
        seg.appendChild(b);
        segs[key].push([o[0], b]);
      });
      row.appendChild(seg);
      pop.appendChild(row);
      // P20-T5-0 (b254): a DEF entry with status() gets a line under its row, re-read each time the popup opens.
      if (d.status) {
        const line = document.createElement('div');
        line.className = 'set-status';
        line.textContent = d.status();
        pop.appendChild(line);
        const gear = document.getElementById('btn-gear');
        if (gear) gear.addEventListener('click', () => { line.textContent = d.status(); });
      }
    });
    const note = document.createElement('div');
    note.className = 'set-status';
    note.textContent = window.C4PM_LIVE
      ? 'Kept in your c4mp settings file (~/.c4pm/settings.json, through c4mp serve) and in this browser; never written to the plan or the repo.'
      : 'Kept in this browser only (localStorage c4mp.settings); never written to the plan or the repo.';
    pop.appendChild(note);
    const sync = () => Object.keys(segs).forEach(key => segs[key].forEach(p => p[1].setAttribute('aria-pressed', String(p[0] === S.get(key)))));
    S.onChange(sync);
    sync();
  }

  // LAY-12b (b382): map.js registers its select (setSelect) before any handler is wired; this file names no later script.
  let doSelect = null;
  function selectNode(id) {
    if (!doSelect) throw new Error('C4PM_CONTROLS: no select registered (setSelect)');
    doSelect(id);
  }
  function setSelect(fn) {
    if (typeof fn !== 'function') throw new Error('C4PM_CONTROLS.setSelect: fn must be a function');
    doSelect = fn;
  }

  // Auto level on: zoom decides openness. Off: freeze the level you are on now (focusNode's depth,
  // -1 when the root is closed) so zooming out keeps every node down to it open. Mirrors the demo's setAutoLevel.
  function setAutoLevel(on) {
    const { map } = st();
    on = !!on;
    if (!on && map.autoLevel) { const f = window.C4PM_CAM.focusNode(); map.lockDepth = f ? f.depth : -1; }
    map.autoLevel = on;
    const b = document.getElementById('btn-auto');
    if (b) b.setAttribute('aria-pressed', String(on));
    st().requestDraw();
  }

  // Edit layout mode: drags move/resize shapes (in memory only). Hint text follows the mode.
  // The help text under the map follows the mode, the way the Up button is hidden in io: the IO view has no levels (demo 7 wording).
  const IO_HINT = 'Scroll or pinch: zoom · Drag: pan · Click: select\nDouble-click: zoom into a box · Fit: back out\nCmd/Ctrl+click: select and open the right panel\nEsc: clear the selection';
  let hintArch = null;   // the architecture hint text (the html's own), kept while the io text or the edit message replaces it
  // UI5 (b755): setHintTail's text: it replaces the last line of the arch and IO hints (null = none). tailed() is idempotent.
  let hintTail = null;
  const tailed = t => (hintTail === null || t.endsWith(hintTail) ? t : t.replace(/[^\n]*$/, () => hintTail));
  function syncHint() {
    const hint = document.getElementById('hud-bl');
    if (!hint || hint.classList.contains('hint-msg')) return;
    const io = tailed(IO_HINT);
    if (hint.textContent !== io && hint.textContent !== IO_HINT) hintArch = hint.textContent;
    if (renderer()) hint.textContent = io;   // a renderer view (IO) has no levels
    else if (hintArch !== null) hint.textContent = tailed(hintArch);
  }
  // UI5 (b755): `text` (one or more lines) replaces the last line of the architecture and IO hints from now on; null = back to
  // the plain hints. sim-list.js sets it when the page has s-items.
  function setHintTail(text) {
    hintTail = typeof text === 'string' && text ? text : null;
    syncHint();
  }
  function setEdit(on) {
    const { map } = st();
    on = !!on;
    if (on !== map.edit) map.drag = null;
    map.edit = on;
    const b = document.getElementById('btn-edit');
    if (b) b.setAttribute('aria-pressed', String(on));
    syncEditButtons();   // P20-T5-F (b260): reset/undo/redo/export follow edit mode, and stay hidden in the IO view
    const hint = document.getElementById('hud-bl');
    if (hint) {
      hint.classList.toggle('hint-msg', on);   // P20-T11: the edit hint is a message, it shows even when Help text is hidden
      if (on) hint.textContent = 'Edit: drag a shape to move it · drag a blueprint header to move it · drag a subregion\'s label to move it · drag its right/bottom edge to resize · drag empty space to pan';   // (syncEditButtons above already kept the normal text in hintArch)
      else { if (hintArch !== null) hint.textContent = hintArch; syncHint(); }
    }
    if (!on && map.canvas) map.canvas.style.cursor = '';
    st().requestDraw();
  }

  // Wire the top buttons. handlers = { resetLayout, downloadLayout, undoEdit, redoEdit, autoArrange } (map.js passes them).
  function wireButtons(handlers) {
    const { map } = st();   // the tree root is read at click time (st().data.root): a mode switch swaps it
    const btnFit = document.getElementById('btn-fit');
    const btnUp = document.getElementById('btn-up');
    const btnIn = document.getElementById('btn-in');
    const btnOut = document.getElementById('btn-out');

    if (btnFit) btnFit.onclick = () => {
      const r = st().data.root;
      if (r && r.w > 0 && r.h > 0) window.C4PM_CAM.flyTo(window.C4PM_CAM.fitCam(r, 0.85));
    };

    if (btnUp) btnUp.onclick = () => {
      const f = window.C4PM_CAM.focusNode();
      // Climb to the nearest ancestor whose fit actually moves the camera: when one child fills the
      // parent's fit, fitCam(parent) is where we already are and Up would stall there.
      let up = f && f.parent, tgt = up && window.C4PM_CAM.fitCam(up);
      while (up && Math.abs(tgt.s / map.cam.s - 1) < 0.02) { up = up.parent; tgt = up && window.C4PM_CAM.fitCam(up); }
      if (up) {
        if (!map.autoLevel) map.lockDepth = up.depth;
        window.C4PM_CAM.flyTo(tgt);
      } else {
        if (!map.autoLevel) map.lockDepth = -1;
        // At the top level: zoom out until the root closes into one bubble (C1), like the demo's viewC1.
        const r = st().data.root;
        if (r && r.w > 0 && r.h > 0) window.C4PM_CAM.flyTo(window.C4PM_CAM.fitCam(r, 0.3));
      }
    };

    const btnAuto = document.getElementById('btn-auto');
    if (btnAuto) btnAuto.onclick = () => setAutoLevel(!map.autoLevel);
    const btnEdit = document.getElementById('btn-edit');
    if (btnEdit) btnEdit.onclick = () => setEdit(!map.edit);
    const btnReset = document.getElementById('btn-reset');
    if (btnReset) btnReset.onclick = handlers.resetLayout;
    const btnArrange = document.getElementById('btn-arrange');
    if (btnArrange) btnArrange.onclick = handlers.autoArrange;
    map.listeners.push(syncArrangeButton);   // SR3 (b693): the selection enables it (state.js created map.listeners)
    syncArrangeButton();
    const btnUndo = document.getElementById('btn-undo');
    if (btnUndo) btnUndo.onclick = handlers.undoEdit;
    const btnRedo = document.getElementById('btn-redo');
    if (btnRedo) btnRedo.onclick = handlers.redoEdit;
    const btnExport = document.getElementById('btn-export');
    if (btnExport) btnExport.onclick = handlers.downloadLayout;
    if (btnExport && liveApi()) { btnExport.textContent = 'Save layout'; btnExport.title = 'Save the edited layout to the plan (c4mp serve; checked like c4mp plan set)'; }
    syncHistoryButtons();
    wirePopups();
    buildSettings();

    if (btnIn) btnIn.onclick = () => window.C4PM_CAM.zoomAt(map.cw / 2, map.ch / 2, 1.6, true);
    if (btnOut) btnOut.onclick = () => window.C4PM_CAM.zoomAt(map.cw / 2, map.ch / 2, 1 / 1.6, true);
  }

  // What an edit-mode drag starting at screen point p would do (resize / move / null -> pan).
  function editTargetAt(p) {
    const { map } = st();
    return window.C4PM_EDIT.editTarget(p, map.opens, window.C4PM_CAM.hitTest(p.x, p.y), map.cam);
  }

  // Finish an edit drag: record before/after as one history entry (skipped when nothing changed).
  function recordEdit(drag) {
    const { map } = st();
    const E = window.C4PM_EDIT;
    const after = E.snapshotRects(E.editNodes(drag.n));
    if (JSON.stringify(after) === JSON.stringify(drag.before)) return;
    E.pushEdit(map.history, drag.before, after);
    syncHistoryButtons();
  }

  function undoEdit() {
    const { map, nodeById } = st();
    const ok = window.C4PM_EDIT.undo(map.history, nodeById);
    syncHistoryButtons(); st().requestDraw();
    return ok;
  }
  function redoEdit() {
    const { map, nodeById } = st();
    const ok = window.C4PM_EDIT.redo(map.history, nodeById);
    syncHistoryButtons(); st().requestDraw();
    return ok;
  }

  // SR3 (b693): Auto arrange button: put the selected container or subregion back to the automatic layout
  // (C4PM_EDIT.autoArrange) as one undo entry (skipped when nothing changed). false when edit mode is off or the
  // selection is not a container or subregion (nothing done).
  function autoArrangeSelected() {
    const { map, nodeById, origRects } = st();
    const n = map.selectedId ? nodeById[map.selectedId] : null;
    if (!map.edit || !n || (n.kind !== 'container' && n.kind !== 'subregion')) return false;
    const E = window.C4PM_EDIT;
    const nodes = E.editNodes(n);
    const before = E.snapshotRects(nodes);
    E.autoArrange(n, origRects);
    const after = E.snapshotRects(nodes);
    if (JSON.stringify(after) !== JSON.stringify(before)) E.pushEdit(map.history, before, after);
    syncHistoryButtons();
    st().requestDraw();
    return true;
  }

  // Esc = clear the selection (IO view). Ctrl/Cmd+Z = undo, Shift+Ctrl/Cmd+Z or Ctrl+Y = redo; only in edit mode, never while typing.
  function onKeydown(e) {
    const { map } = st();
    const t = e.target, tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
    // Esc (not while typing), IO view only (demo 7): clear the selection; the panel goes back to its summary. The arch view keeps the
    // board rule (P16-B22, board.js): Esc clears a selected b-item and leaves a selected c-item alone.
    if (e.key === 'Escape') { if (!typing && map.selectedId && renderer()) selectNode(null); return; }
    if (!map.edit || !(e.ctrlKey || e.metaKey)) return;
    if (typing) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'z') { if (e.shiftKey) redoEdit(); else undoEdit(); }
    else if (k === 'y' && e.ctrlKey) redoEdit();
    else return;
    if (e.preventDefault) e.preventDefault();
  }

  // Wire up pointer events
  function wirePointers() {
    const { map } = st();
    const cv = map.canvas;
    const pts = new Map();
    let moved = 0;
    let lastTap = { t: 0, x: 0, y: 0 };

    const pos = e => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const p = pos(e);
      window.C4PM_CAM.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });

    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      const p0 = pos(e);
      if (map.edit && pts.size === 0) {
        const op = editTargetAt(p0);
        map.drag = op ? { ...op, start: p0, r0: { x: op.n.x, y: op.n.y, w: op.n.w, h: op.n.h },
          before: window.C4PM_EDIT.snapshotRects(window.C4PM_EDIT.editNodes(op.n)) } : null;
      }
      pts.set(e.pointerId, p0);
      if (pts.size === 1) moved = 0;
      cancelAnimationFrame(map.anim);
      cv.classList.add('drag');
    });

    cv.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) {
        // b908: the node under the pointer; a redraw only when the foundation box under it changes (its incoming arrows)
        const hn = window.C4PM_CAM.hitTest(pos(e).x, pos(e).y), hid = hn ? hn.id : null;
        if (hid !== map.hoverId) {
          const F = window.C4PM_RENDER.beans.foundationOf;
          const redraw = F(map.hoverId) !== F(hid);
          map.hoverId = hid;
          if (redraw) st().requestDraw();
        }
        if (map.implN) { // b130: tooltip of the 'Light implemented components' ring (native title of the canvas)
          const k = hn && map.implN[hn.id];
          cv.title = k ? 'Implements ' + k + ' screen call' + (k === 1 ? '' : 's') : '';
        }
        // an edge label cut with an ellipsis: its full text is the hover title
        const q = pos(e), lab = (map.edgeLabels || []).find(l => q.x >= l.x && q.x <= l.x + l.w && q.y >= l.y && q.y <= l.y + l.h);
        if (lab) cv.title = lab.full; else if (!map.implN) cv.title = '';
        if (map.edit) { // hover feedback
          const op = editTargetAt(pos(e));
          cv.style.cursor = !op ? '' : op.type === 'move' ? 'move' : (op.rx || op.lx) && (op.ry || op.ty) ? (!op.rx === !op.ry ? 'nwse-resize' : 'nesw-resize') : op.rx || op.lx ? 'ew-resize' : 'ns-resize';
        }
        return;
      }
      const prev = pts.get(e.pointerId);
      const cur = pos(e);
      if (map.drag && pts.size === 1) {
        moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
        if (moved > 3) window.C4PM_EDIT.applyDrag(map.drag, cur, map.cam);
      } else if (pts.size === 1) {
        map.cam.tx += cur.x - prev.x;
        map.cam.ty += cur.y - prev.y;
        moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
      } else if (pts.size === 2) {
        const other = [...pts.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
        const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
        const m1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
        map.cam.tx += m1.x - m0.x;
        map.cam.ty += m1.y - m0.y;
        if (d0 > 0) window.C4PM_CAM.zoomAt(m1.x, m1.y, d1 / d0);
        moved += 100;
      }
      pts.set(e.pointerId, cur);
      st().requestDraw();
    });
    // b908: the pointer left the canvas: no hovered node; a redraw only when it was over a foundation box
    cv.addEventListener('pointerleave', () => {
      const F = window.C4PM_RENDER.beans.foundationOf, was = F(map.hoverId);
      map.hoverId = null;
      if (was) st().requestDraw();
    });

    const up = e => {
      if (!pts.has(e.pointerId)) return;
      const p = pos(e);
      pts.delete(e.pointerId);
      if (!pts.size) cv.classList.remove('drag');
      const wasDrag = map.drag;
      map.drag = null;
      if (wasDrag && moved > 3) { recordEdit(wasDrag); st().requestDraw(); return; } // an edit drag: never also a click
      if (pts.size || moved > 6) return;

      const n = window.C4PM_CAM.hitTest(p.x, p.y);
      const now = performance.now();
      const dbl = now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 20;
      lastTap = { t: dbl ? 0 : now, x: p.x, y: p.y };

      if (dbl && n) {
        const R = renderer();
        if (R) {   // a renderer view (IO): fly to fit the hit item (a part, a box, an entry or a frame), no level lock
          const h = R.hit(p.x, p.y), r = (h && R.rect(h.id)) || n;
          window.C4PM_CAM.flyTo(window.C4PM_CAM.fitCam(r, 0.75));
          return;
        }
        // Locked: the dived node's level becomes the lock (its parent if it is a leaf, as the demo does).
        if (!map.autoLevel) {
          const t = n.children && n.children.length ? n : n.parent;
          if (t) map.lockDepth = t.depth;
        }
        // b858 S3: fly to where the box is drawn (inside a fill)
        window.C4PM_CAM.flyTo(window.C4PM_CAM.fitCam(window.C4PM_CAM.worldOf(n)));
        return;
      }
      if (n) {
        selectNode(n.id);
        if (window.C4PM_SIDE) window.C4PM_SIDE.reveal(e);   // Cmd/Ctrl+click also opens the right panel
      }
    };

    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', e => {
      pts.delete(e.pointerId);
      if (map.drag && moved > 3) recordEdit(map.drag);
      map.drag = null;
      cv.classList.remove('drag');
    });
  }

  // The edited layout as the layout.json object (see C4PM_EDIT.exportLayout).
  function exportLayout() {
    const { nodeById, origRects } = st();
    return window.C4PM_EDIT.exportLayout(Object.keys(nodeById).map(id => nodeById[id]), origRects);
  }

  // b914: the one browser download: Blob + a temporary <a download> (works from file:// and from c4mp serve). Throws when the browser refuses.
  function downloadText(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Export button: download c4mp-layout.json (Blob + temporary <a download>, works from file://),
  // or say so in the hint line when nothing changed.
  function downloadLayout() {
    const hint = document.getElementById('hud-bl');
    const say = msg => { if (hint) { hint.classList.add('hint-msg'); hint.textContent = msg; } };
    const out = exportLayout();
    const ids = Object.keys(out.nodes), dropped = ids.filter(id => out.nodes[id] === null).length;   // SR3 (b693): null = back to auto
    if (ids.length === 0) { say(liveApi() ? 'Nothing to save: no shape has been moved or resized.' : 'Nothing to export: no shape has been moved or resized.'); return; }
    if (liveApi()) { saveLayout(out, say); return; }   // b644 (SV10): a served page saves; the static page downloads
    try {
      downloadText('c4mp-layout.json', JSON.stringify(out, null, 2) + '\n', 'application/json');
      say('Exported ' + (ids.length - dropped) + ' shape(s)' + (dropped ? ' and ' + dropped + ' dropped (back to auto)' : '') + ' to c4mp-layout.json. Apply with: c4mp plan apply-layout --repo <path> --file c4mp-layout.json');
    } catch (e) {
      say('Export failed: ' + (e && e.message ? e.message : e));
    }
  }

  // b644 (SV10): Save layout of a served page: POST api/layout with the stamp of the plan this page shows (C4PM_LIVE.stamps.plan).
  // saveLayout(out, say): out = the layout object, say = the hint writer. Without `out` it reads the edited layout itself.
  function saveLayout(out, say) {
    const L = liveApi();
    const hint = document.getElementById('hud-bl');
    const sayIt = say || (msg => { if (hint) { hint.classList.add('hint-msg'); hint.textContent = msg; } });
    const layout = out || exportLayout();
    if (!L) { sayIt('Save failed: this page is not served by c4mp serve.'); return; }
    sayIt('Saving the layout ...');
    L.request('POST', 'api/layout', { expect: (L.stamps && L.stamps.plan) || '', layout: layout })
      .then(ans => onLayoutSaved(ans, layout, sayIt), () => offerLayoutDownload(sayIt, 'Save failed: c4mp serve is not running. Your edits are kept.', layout));
  }

  // The answer of POST api/layout: { status, json } (live.js request). 200 ok = written; 409 / 401 / other = edits kept + download.
  function onLayoutSaved(ans, out, say) {
    const status = ans && ans.status, json = (ans && ans.json) || {};
    if (status === 200 && json.ok) {
      const { map } = st(), L = liveApi();
      map.history.undo.length = 0; map.history.redo.length = 0;
      syncHistoryButtons();
      if (L && L.stamps && typeof json.stamp === 'string') L.stamps.plan = json.stamp;
      const rep = json.report || {}, files = (rep.files || []).map(f => f.file);
      let msg = files.length === 0 ? 'Nothing changed: the plan already has this layout.'
        : 'Saved ' + (rep.applied || 0) + ' shape(s) to ' + files.join(', ') + '. The map reloads with the plan.';
      const failed = rep.failed || [];
      if (failed.length > 0) msg += ' ' + failed.length + ' shape(s) failed: ' + (failed[0].reason || failed[0]) + '.';
      say(msg);
      return;
    }
    if (status === 409) { offerLayoutDownload(say, 'The plan changed since this page loaded. Your edits are kept: download them, then reload.', out); return; }
    if (status === 401) { offerLayoutDownload(say, 'Save failed: the key is from an earlier c4mp serve run. Your edits are kept.', out); return; }
    const why = (json.write && json.write.error && json.write.error.message) || json.message || ('c4mp serve answered ' + status);
    offerLayoutDownload(say, 'Save refused: ' + why + '. Your edits are kept.', out);
  }

  // Say text, then a Download c4mp-layout.json button in the hint line (the same bytes as the static download).
  function offerLayoutDownload(say, text, out) {
    say(text);
    const hint = document.getElementById('hud-bl');
    if (!hint) return;
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Download c4mp-layout.json';
    b.onclick = () => {
      try { downloadText('c4mp-layout.json', JSON.stringify(out, null, 2) + '\n', 'application/json'); }
      catch (e) { say('Download failed: ' + (e && e.message ? e.message : e)); }
    };
    hint.appendChild(b);
  }

  // Put every node back to the rect it had at load.
  function resetLayout() {
    const { map, nodeById, origRects } = st();
    const E = window.C4PM_EDIT;
    Object.keys(origRects).forEach(id => E.setRect(nodeById[id], origRects[id]));   // SR2 (R5): restores placed too
    map.history.undo.length = 0; map.history.redo.length = 0;
    syncHistoryButtons();
    st().requestDraw();
  }

  // P20-T5-F (b260): the header follows the view. onChange runs after the tree is loaded; edit mode goes off BEFORE the
  // header is filled, so syncEditButtons sees map.edit false. At load (a page opened at #io) map.edit is false: no setEdit.
  window.C4PM_MODE.onChange(() => {
    if (renderer() && st().map.edit) setEdit(false);
    fillHeader();
  });

  // SV8 (b795): moved / resized shapes not saved yet keep the live page from reloading. Not `map.edit &&`: leaving
  // edit mode keeps the moved shapes.
  if (window.C4PM_LIVE && typeof window.C4PM_LIVE.dirty === 'function') window.C4PM_LIVE.dirty(() => { const s = st(); return !!(s && s.map && s.map.history && s.map.history.undo.length > 0); });

  window.C4PM_CONTROLS = { updateHud, fillHeader, setAutoLevel, setSelect, setEdit, syncHistoryButtons, wireButtons,
    editTargetAt, recordEdit, undoEdit, redoEdit, autoArrangeSelected, onKeydown, wirePointers, exportLayout, downloadLayout, downloadText, saveLayout, resetLayout,
    setHintTail };
})();
