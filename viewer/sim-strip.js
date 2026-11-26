// sim-strip.js: the path strip on the map and the camera of the simulations (Phase 25 UI7, b757; feature inventory A3).
// Spec: Document/Roadmap/Phase25/UI_TASKS.md section C UI7. Loaded after sim.js (src/page/html.ts VIEWER_SCRIPTS); reads
// C4PM_SIM and does nothing on a page without s-items (C4PM_SIM undefined).
//
// CONTRACT  window.C4PM_SIMSTRIP = { render, stepRect, barBottom, fitPath, flyStep }
//   render()        renderSimStrip: fills #simbar (index.html, in #map-wrap) for the selected s-item: kind icon, id, title, one
//                   chip per flow step at the depth (C4PM_SIM.flow(), b853; at code one per step): text = its number n, class
//                   v-io | v-arch | v-storage | v-out by its (first member's) view; here = one of its member views is the current
//                   view (an outside step never); cur = it holds the cursor (C4PM_SIM.flowIndex(step())); unver = a member is
//                   unverified; title 'Step n · <view> view · <targets>' (+ ' · unverified', + ' · steps a–b' when it merges
//                   several steps); click = C4PM_SIM.go(first member, { go: true }); a separator between journey stages. Then
//                   the depth switch (b872: a dropdown, the strip fits one line): label.sb-depth with the text "Depth" and a
//                   select.sb-depth-sel (aria-label 'Flow depth') of four options Context · Container · Component · Code (value =
//                   the depth; select value = C4PM_SIM.depth(); option title with the kind-table word C1 / C2 / C3 / Code;
//                   change = C4PM_SIM.setDepth(value), whose 'depth' change re-renders the strip; no sb-btn class). Then the
//                   buttons ‹ › All (only with a cursor) ▶ Present, ≡ Sequence (✓ while #seq-drawer is shown) and ✕, each calling
//                   C4PM_SIM.act(...), and the key (IO / Arch / Storage, plus outside / unverified when a step is). Hidden with
//                   no s-item and while presenting (#root.presenting or C4PM_SIM.hooks.presenting()). Runs on every
//                   C4PM_SIM.onChange (a mode change while selected arrives there as what 'view').
//   stepRect(step, opts?)  world rect { x, y, w, h } of what the CURRENT view draws for a step; null when it draws nothing
//                   there. io: union of C4PM_IOVIEW.rect(entryId) of the io targets (their screens); storage: union of
//                   C4PM_STORAGEVIEW.rect of the storage targets and the records of the step's rows, grown by 30 each side;
//                   arch (and any other tree view): union of C4PM_STATE.nodeById rects of the targets of this view and the
//                   two ends of the step's call (a function / method counts as its parent box); a flow step (b853, it has
//                   archIds) uses its archIds (its arch boxes at the depth) and both ends of every one of its arrows instead;
//                   opts.targetsOnly (b786) leaves the call / arrow ends out.
//   barBottom()     px from the map top under which a fit starts: #simbar offsetTop + offsetHeight + 6; 50 when the strip is
//                   hidden, not measured, or on a phone (<= 700 px: the strip sits at the bottom).
//   fitPath()       C4PM_SIM.hooks.fitPath (pad 0.85): the arch view flies to the union of the boxes of every lit id,
//                   C4PM_STATE.map.sim.ids (step targets and call ends of all steps; a function / method counts as its
//                   parent box; b786-8 K 2026-11-17, like demo picture 03) plus, for each lit box, the title band of the drawn
//                   region that holds it (b872: from the region's left edge to the box's right edge, headerH high; never the
//                   tree root (no parent) or a C1 holder (holder: true)); other views (or nothing lit drawn) fly to the
//                   union of stepRect(step, { targetsOnly: true }) of every flow step at the depth (C4PM_SIM.flow(), b786,
//                   b853); with none, the union of stepRect(step) (the fly never does nothing).
//   flyStep(step)   C4PM_SIM.hooks.fly: an outside step shows the toast "Step N happens outside the system (sender): text"
//                   (C4PM_OPEN.toast, #view-toast; N = step.n, a flow step's number); else C4PM_SIM.goView(view) and fly to
//                   stepRect (pad 0.8); view = the current view when step.views (a flow step, b853) holds it, else step.view.
//   Fits go into the band between barBottom() and 10 px above the map bottom (60 on a phone, over the strip):
//   C4PM_CAM.fitCamIn(rect, pad, barBottom(), bottom). Each fit sets C4PM_STATE.map.openBand = { top, bottom } (b786: early
//   ids open against the visible band, camera.js openness).
(function () {
  'use strict';
  const SIM = window.C4PM_SIM;
  if (!SIM) return;   // no s-items on this page

  const $ = id => document.getElementById(id);
  const isPhone = () => !!(window.matchMedia && window.matchMedia('(max-width: 700px)').matches);
  const vcls = st => (st.view === 'outside' ? 'out' : st.view);
  const viewsOf = st => st.views || [st.view];   // a flow step's member views (b853); an original step has its own view only
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function presenting() {
    const root = $('root');
    return !!((root && root.classList.contains('presenting')) || (SIM.hooks.presenting && SIM.hooks.presenting()));
  }
  function seqOpen() {
    const d = $('seq-drawer');
    return !!d && !d.hidden;
  }

  // b853 S4, b872: the flow depth switch after the chips, one "Depth" dropdown (K 2026-11-17: the strip fits one line). K's
  // labels; an option's title adds the kind-table word of the level (C1 / C2 / C3, the 'Code' hud word). No sb-btn class
  // (the strip's act buttons are .sb-btn).
  const DEPTH_LABEL = { context: 'Context', container: 'Container', component: 'Component', code: 'Code' };
  function depthWord(d) {
    const MODE = window.C4PM_MODE;
    return d === 'code' ? MODE.word('function', 'arch') : MODE.tag(d === 'context' ? 'system' : d, 'arch');
  }
  function depthSwitch() {
    const sw = el('label', 'sb-depth');
    sw.appendChild(document.createTextNode('Depth'));
    const sel = el('select', 'sb-depth-sel');
    sel.setAttribute('aria-label', 'Flow depth');
    SIM.DEPTHS.forEach(d => {
      const label = DEPTH_LABEL[d] || d, w = depthWord(d);
      const o = el('option', '', label);
      o.value = d;
      o.title = 'Flow depth ' + label + (w && w !== label ? ' (' + w + ')' : '') + (d === 'code' ? ': every step on its own' : ': consecutive steps in one box merge');
      sel.appendChild(o);
    });
    sel.value = SIM.depth();
    sel.addEventListener('change', () => SIM.setDepth(sel.value));   // sim.js re-renders the strip through onChange (what 'depth')
    sw.appendChild(sel);
    return sw;
  }

  function renderSimStrip() {
    const b = $('simbar');
    if (!b) return;
    const id = SIM.selected(), sim = id ? SIM.byId(id) : null;
    b.textContent = '';
    if (!sim || presenting()) { b.hidden = true; return; }
    b.hidden = false;
    const steps = sim.steps, cur = SIM.step(), mode = window.C4PM_MODE.get();
    const flow = SIM.flow(), curK = SIM.flowIndex(cur);   // b853: the chips are the flow steps at the depth
    const ic = el('span', 'sim-ico');
    ic.innerHTML = SIM.icon(sim.kind) || SIM.icon('flow');   // a constant of sim.js, no data
    ic.title = sim.kind;
    b.appendChild(ic);
    b.appendChild(el('span', 'sb-id', sim.id));
    b.appendChild(el('span', 'sb-title', sim.title));
    const wrap = el('span', 'sb-steps');
    flow.forEach((st, k) => {
      if (k && st.stage !== flow[k - 1].stage) wrap.appendChild(el('span', 'sb-sep'));
      const out = st.view === 'outside';
      const here = !out && viewsOf(st).indexOf(mode) >= 0;
      const c = el('button', 'sb-step v-' + vcls(st) + (here ? ' here' : '') + (curK === st.i ? ' cur' : '') + (st.unverified ? ' unver' : ''), String(st.n));
      c.setAttribute('type', 'button');
      const range = st.members.length > 1 ? ' · steps ' + (st.first + 1) + '–' + (st.last + 1) : '';
      c.title = 'Step ' + st.n + ' · ' + (out ? 'outside the system' : SIM.viewWord(st.view) + ' view') + ' · ' + SIM.stepTarget(st) + (st.unverified ? ' · unverified' : '') + range;
      c.addEventListener('click', () => SIM.go(st.first, { go: true }));
      wrap.appendChild(c);
    });
    b.appendChild(wrap);
    b.appendChild(depthSwitch());
    const btn = (text, title, act, cls) => {
      const x = el('button', 'tbb sb-btn' + (cls ? ' ' + cls : ''), text);
      x.setAttribute('type', 'button');
      x.title = title;
      x.addEventListener('click', () => { window.C4PM_SIM.act(act); if (act === 'seq') renderSimStrip(); });
      b.appendChild(x);
    };
    btn('‹', 'Previous step (←)', 'prev');
    btn('›', 'Next step (→)', 'next');
    if (cur !== null) btn('All', 'Show the whole path again (no step cursor)', 'whole');
    btn('▶ Present', 'Present: fly through the steps across the views', 'present', 'play');
    btn(seqOpen() ? '≡ Sequence ✓' : '≡ Sequence', 'Open / close the sequence under the map', 'seq');
    btn('✕', 'Clear the simulation (Esc)', 'clear');
    const key = el('span', 'sb-key');
    const item = (cls, text) => {
      const s = el('span', 'sb-key-item');
      s.appendChild(el('i', cls));
      s.appendChild(document.createTextNode(text));
      key.appendChild(s);
    };
    item('k-io', 'IO');
    item('k-arch', 'Arch');
    item('k-storage', 'Storage');
    if (steps.some(x => x.view === 'outside')) item('k-out', 'outside');
    if (steps.some(x => x.unverified)) item('k-unver', 'unverified');
    b.appendChild(key);
  }

  function union(rs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    rs.forEach(r => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const drawn = r => !!r && r.w > 0 && r.h > 0;
  // The arch box drawn for an id: a function / method counts as its parent box (b786-8: one place for stepRect and fitPath).
  function archBox(id) {
    const n = window.C4PM_STATE.nodeById[id];
    return n && (n.kind === 'function' || n.kind === 'method') && n.parent ? n.parent : n;
  }

  // opts.targetsOnly (b786): arch leaves out the two call ends (io / storage use none); stepRect(step) is unchanged.
  function stepRect(step, opts) {
    if (!step || step.view === 'outside') return null;
    const targetsOnly = !!(opts && opts.targetsOnly);
    const mode = window.C4PM_MODE.get();
    const mine = (step.targets || []).filter(t => t.view === mode && t.nodeId);
    let rs;
    if (mode === 'io') {
      const IOV = window.C4PM_IOVIEW;
      rs = mine.map(t => IOV.rect(t.entryId || t.nodeId));
    } else if (mode === 'storage') {
      const SV = window.C4PM_STORAGEVIEW;
      const ids = mine.map(t => t.nodeId).concat((step.rows || []).map(r => r.recordId).filter(Boolean));
      rs = ids.map(id => SV.rect(id)).filter(drawn);
      if (!rs.length) return null;
      const u = union(rs);
      return { x: u.x - 30, y: u.y - 30, w: u.w + 60, h: u.h + 60 };
    } else {
      // b853: a flow step rings its archIds (its boxes at the depth) and every arrow end; an original step: today's
      const ids = step.archIds ? step.archIds.slice() : mine.map(t => t.nodeId);
      if (!targetsOnly) {
        if (step.arrows) step.arrows.forEach(a => ids.push(a.from, a.to));
        else if (step.call) ids.push(step.call.from, step.call.to);
      }
      rs = ids.map(archBox);
    }
    rs = rs.filter(drawn);
    return rs.length ? union(rs) : null;
  }

  function barBottom() {
    const b = $('simbar');
    return b && !b.hidden && !isPhone() && b.offsetHeight > 0 ? b.offsetTop + b.offsetHeight + 6 : 50;
  }

  // Fly the current view to world rect r into the band under the strip.
  function flyRect(r, pad) {
    const CAM = window.C4PM_CAM;
    if (!r || !window.C4PM_STATE.map.cw) return;
    const top = barBottom(), bottom = isPhone() ? 60 : 10;
    window.C4PM_STATE.map.openBand = { top, bottom };   // b786: early ids open against this band (camera.js openness)
    CAM.flyTo(CAM.fitCamIn(r, pad, top, bottom));
  }

  // b786-8 (K 2026-11-17): in the arch view the whole path frames every lit box (targets and call ends of all steps,
  // map.sim.ids), like demo picture 03, and (b872) the title band of the region around each lit box; other views frame their
  // step targets (b786), and with none, every stepRect (the fly never does nothing).
  function fitPath() {
    const sim = window.C4PM_STATE.map.sim;
    if (window.C4PM_MODE.get() === 'arch' && sim && sim.ids && sim.ids.size) {
      const lit = [...sim.ids.keys()].map(archBox).filter(drawn);
      if (lit.length) {
        // b872: keep the title of the region that holds a lit box (not the tree root or a C1 holder)
        const bands = lit.map(b => {
          const p = b.parent;
          return p && p.parent && !p.holder && drawn(p) ? { x: p.x, y: p.y, w: Math.min(p.w, b.x + b.w - p.x), h: p.headerH || 0 } : null;
        }).filter(Boolean);
        flyRect(union(lit.concat(bands)), 0.85);
        return;
      }
    }
    const steps = SIM.flow();   // b853: the flow steps at the depth (at code one per step, as before)
    let rs = steps.map(s => stepRect(s, { targetsOnly: true })).filter(Boolean);
    if (!rs.length) rs = steps.map(s => stepRect(s)).filter(Boolean);
    if (rs.length) flyRect(union(rs), 0.85);
  }

  function flyStep(step) {
    if (!step) return;
    if (step.view === 'outside') {
      const o = step.outside || {};
      const msg = 'Step ' + step.n + ' happens outside the system' + (o.from ? ' (' + o.from + ')' : '') + ': ' + (o.text || '');
      if (window.C4PM_OPEN && window.C4PM_OPEN.toast) window.C4PM_OPEN.toast(msg);
      return;
    }
    // b853: a flow step of several views stays in the current view when one of its members is there
    const mode = window.C4PM_MODE.get();
    SIM.goView(viewsOf(step).indexOf(mode) >= 0 ? mode : step.view, () => flyRect(stepRect(step), 0.8));
  }

  SIM.hooks.fly = flyStep;
  SIM.hooks.fitPath = fitPath;
  SIM.onChange(renderSimStrip);
  renderSimStrip();

  window.C4PM_SIMSTRIP = { render: renderSimStrip, stepRect, barBottom, fitPath, flyStep };
})();
