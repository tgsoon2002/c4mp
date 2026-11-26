// sim-present.js: present mode of an s-item (Phase 25 UI12, b762; feature inventory A6): the chrome hides, the map flies
// from step to step across the views, a caption card tells each step, auto-play, keys, full screen; Exit puts everything
// back. Spec: Document/Roadmap/Phase25/UI_TASKS.md section C UI12 (demo 1248-1367, CSS 240-271). Loaded after
// sim-panel.js (src/page/html.ts VIEWER_SCRIPTS). A page without s-items (window.C4PM_SIM undefined): nothing happens.
//
// CONTRACT (C4PM_SIM.hooks: present, presentGo, presentEnd, presenting, presentKey, presentState, presentRemote; nothing
// else exported)
//   startPresent(id, at)  hooks.present: remembers { view, sim, step, sel (C4PM_MAP.selectedId()), seq (#seq-drawer shown),
//                   cam } (only when not presenting already), selects s-item `id` (fromPres, no fit), clears the c-item,
//                   puts class `presenting` on #root (sim.css hides the chrome) and shows #pres; then presGo(at || 0).
//   presGo(i, opts) hooks.presentGo (opts: C4PM_SIM.go's, not used yet): the cursor on step i (clamped); P.owner =
//                   ownerOf(step) (UI17-3, below); C4PM_SIM.go fromPres, so the window link follows and its post carries
//                   the owner; renderPres(). Another window owns the step: no view switch, no fly (the away look).
//                   This window owns it (playHere): a drawn step switches to its view (C4PM_SIM.goView) and flies so
//                   the step sits between 50 px from the top and the caption card (C4PM_CAM.fitCamIn(
//                   C4PM_SIMSTRIP.stepRect(step), 0.85, 50, card height + 34)); an outside step does not fly
//                   (#pres.outside dims the map, the card is centred).
//                   The fly sets C4PM_STATE.map.openBand = { top: 50, bottom: card height + 34 } (b786: early ids open
//                   against that band, camera.js); an outside step leaves it; endPresent sets it to null.
//                   While playing, schedules the next step after durationSec (default 4 s); the last step stops the play.
//   presPlay(on)    play / pause; Play on the last step starts again at step 1.
//   endPresent(keep)  hooks.presentEnd (with keep: C4PM_SIM.select ends present mode for a new selection): leaves present
//                   mode, leaves full screen; without keep restores the remembered view (goView), then the camera, the
//                   s-item and its cursor, the c-item (C4PM_MAP.select) and the sequence (hooks.seq, UI13). UI17-5: the
//                   leader posts the end message first; the helper's restore selects and goes with remote (no post).
//   presKey(e)      hooks.presentKey (sim.js runs it first in its capture keydown listener, so it beats every other key
//                   handler): → / PageDown next, ← / PageUp back, Space play / pause, F full screen, Esc exit; true when
//                   used (preventDefault). Not presenting: false. With Alt / Meta / Ctrl / Shift held only Esc acts; the
//                   other keys return false untouched, so browser shortcuts (Cmd+← Back, Cmd+F find) keep working.
//   presFull()      full screen on / off (document.documentElement.requestFullscreen, guarded: no API = nothing).
//   renderPres()    fills #pres: head pill (icon, "s-1 · title", "5/9", view chip) and the caption card: "Step 5/9" (+ the
//                   journey's "Stage 2 · Buy · flow s-1 step 4"), view chip, "? unverified" chip; the target line (names +
//                   "   ·   A → B (label)") or, outside, the channel icon, the outside text and "from X to person · not drawn
//                   in any view"; caption; the unverified box; "goal: …"; "state: <b>…"; the rows tables of every record
//                   known at this step (C4PM_SIM.rowsTableHtml, escaped there); the progress bar (shown while playing:
//                   class run, its length in the --pres-sec property); the dots, ‹ Back, ▶ Play / ❚❚ Pause, Next ›,
//                   ⛶ Full screen, ⧉ Two windows (opens the second window, UI17-5 below), Exit ✕; the keys line.
// UI17-3 (b849), the leader side of present across two windows (this window presents = the leader):
//   owner rule      ownerOf(step): an outside step plays here; a drawn step plays in the lowest-id other linked window
//                   that shows a map (C4PM_LINK.peers() entry with map true) in the step's view, else here. P.owner = that
//                   window's link id, null = this window. endPresent resets it.
//   presentState    hooks.presentState() -> { pres: { lead: true, owner: link id (this window's C4PM_LINK.id() when it
//                   owns the step; left out without C4PM_LINK.id), playing, sec: the step's seconds, since (UI17-4c),
//                   depth (b853 S6b) } }
//                   while presenting,
//                   else null; sim.js merges it into every 'sim' post. Play / Pause re-posts the step (UI17-4c).
//   onPeers         C4PM_LINK.onPeers(peersChanged), registered once at load: while presenting, a new owner of the current
//                   step re-renders, plays the step here when it comes back (null), and re-posts it (C4PM_SIM.go fromPres);
//                   the step and the play timer stay.
//   away look       #pres.away (sim.css) while P.owner is another window: the head pill, the line "Step n plays in the
//                   <View> window" (.pres-away, under the pill) and the controls in .pres-ctl at the bottom (the progress
//                   bar, dots, Back / Play / Next / Full screen / ⧉ / Exit, the note, the keys line: presControls, the same
//                   nodes the card ends with). No caption card is built, no view switch, no fly, no dimming. The leader's
//                   timer keeps running.
// UI17-4a (b850), the helper side (a window that did not start present follows the leader):
//   follow(d)       hooks.presentRemote (sim.js: every received 'sim' message, after its remote select / go). Only a
//                   message with pres.lead counts here (else: nothing; requests: UI17-4b below; the end message: UI17-5). Never in the leader, the
//                   sequence-only window (C4PM_SIM.hash().seqonly) or a page without #pres. Entering: remember() the
//                   view, s-item, step, c-item, sequence and camera (as startPresent), the present look (showPresent);
//                   P.follow = true. Every leader message: P.lead = from, the leader's s-item, step and playing; P.owner =
//                   null when pres.owner is this window's link id, else that id; renderPres (the card or the away look).
//                   Owning a drawn step: a fly in THIS window's view (flyToStep after whenSized; never goView), once per
//                   step and owner (P.lastFlown); while playing the bar runs over pres.sec (startBar, as schedule();
//                   UI17-4c: whoever owns the step).
//   no timers       the helper never runs a step: presGo, presPlay and schedule return at once in it (peersChanged
//                   only checks that its leader is still there, UI17-5);
//                   presentState is null (only the leader posts pres). endPresent resets follow, lead and lastFlown.
// UI17-4b (b860), the helper's input goes to the leader:
//   stepTo(i)       the dots, ‹ Back, Next › and ← → / PageUp PageDown (presControls, presKey): clamped; the leader runs
//                   presGo; the helper runs C4PM_SIM.go fromPres, a plain 'sim' post { sim, step } (no pres); the leader's
//                   sim.js takes it as a remote go -> presentGo -> presGo decides the owner and posts the step with pres,
//                   and the helper follows that post.
//   playTo(on)      ▶ Play / ❚❚ Pause and Space: the leader runs presPlay; the helper posts a request
//                   'sim' { sim, step, pres: { req: 'play' | 'pause' } } (not replayed).
//   req message     follow(d) in the leader (presenting, not following) runs pres.req 'play' / 'pause' as presPlay(true /
//                   false) and stops there ('exit': endPresent, UI17-5); a helper ignores every request.
//   presentEnd      hooks.presentEnd does nothing in the helper: the leader's new s-item comes as a remote select
//                   (sim.js select ends present), and the helper keeps following with its remembered view for Exit.
// UI17-4c (b861), the leader fixes:
//   play / pause    presPlay re-posts the step (C4PM_SIM.go fromPres): pres.playing reaches the helper at once (its Play /
//                   Pause label, its next request, its bar). Play on the last step goes through presGo(0), which posts.
//   first post      startPresent sets the cursor (clamped) and P.owner before C4PM_SIM.select, so the select post of a new
//                   present already names the window that plays the step.
//   since           startPresent sets P.since = Date.now(); presentState adds pres.since. Two leaders (both started
//                   before either heard the other): in follow(d), a leader that gets another window's pres.lead with a
//                   later since (equal: the lower link id `from`) yields: it stops leading (UI17-5: no endPresent, no end
//                   message; its timer stops, P.prev stays), then it follows from that message on. The newer leader
//                   ignores the older one's message (the older one yields when it gets the newer one's). A message
//                   without since never wins.
//   bar rule        the progress bar runs the same in every window while playing: the leader's schedule(), and the
//                   helper's follow() whoever owns the step (pres.sec); paused, renderPres builds the bar without `run`.
//                   peersChanged restarts the leader's bar after its re-render (visual only: P.timer keeps its time).
// UI17-5 (b851), ending present everywhere and the ⧉ button:
//   end message     the leader's endPresent (not a helper's) first posts 'sim' { sim, step, pres: { end: true } } with
//                   replay (a window that joins later is not drawn into a finished present), then restores as before (its
//                   select / go post, so the other windows follow its s-item). follow(d): an end message from P.lead ends
//                   the helper: endPresent() restores the helper's own view, camera, c-item and sequence, its select / go
//                   with remote: true (it posts nothing). An end message from any other window is ignored.
//   exitTo()        Exit ✕ and Esc: the leader runs endPresent (ending every window); the helper only posts the request
//                   'sim' { sim, step, pres: { req: 'exit' } } (not replayed); the leader's follow(d) runs it as endPresent.
//   leaving         peersChanged in the helper: P.lead no longer in C4PM_LINK.peers() (its window closed, its link or
//                   this window's link went off) -> endPresent() (the helper's restore).
//   helper start    startPresent in a helper (hooks.present, &present=, the strip): ends following without a restore
//                   (follow / lead / lastFlown reset, P.prev kept), then leads; its later since makes the old leader
//                   yield. remember() never overwrites a prev while presenting, and the yield keeps it, so Exit restores
//                   the view from before the window's FIRST present.
//   ⧉ Two windows   twoWindows(): the window link off or 'not available' -> the note "Two windows need the window link
//                   (gear: Window link On)."; else C4PM_OPEN(v) (openView.js): v = 'io' when the s-item has io steps and
//                   present started in another view (P.prev.view), else the first of sim.views that is not P.prev.view
//                   (none: the note "This s-item has no other view to open."); opened: the explanation note. The note
//                   line shows the outcome (P.twoNote) until the next present.
// b853 S6 (b867), present over flow steps: steps() is C4PM_SIM.flow(P.sim), the flow steps of this window's depth (at code
// one per step, first = last = i, so nothing changes there); dots, "Step n/N", Back / Next, the play timer and pres.sec
// (a merged step's durationSec is the sum of its members' seconds, sim-flow.js) all count flow steps.
//   index rule      P.i is a FLOW index inside this file only. Every index that crosses a file or window boundary is an
//                   ORIGINAL step index: in through flowIdx(i) (C4PM_SIM.flowIndex, clamped; none: 0) from
//                   hooks.present(id, at), hooks.presentGo(i, opts) and a leader's message step (follow); out as the
//                   flow step's first original index (curFirst(), list[j].first) in C4PM_SIM.go (presGo, peersChanged,
//                   presPlay, the helper's stepTo) and the end message. The helper's follow keeps the leader's own
//                   original step as its cursor (SIM.go(d.step)), and its play / pause / exit requests post that
//                   cursor (SIM.step()), so a request never moves the leader when the two windows show other depths.
//   renderPres      one .pres-cap per caption of the members (captions); tables at the flow step's last member.
// b853 S6b (b869), one depth per present: the leader's. A helper at a finer depth than the leader got stuck on Next (its
// next original step fell inside the leader's merged flow step, so the leader re-posted the same step).
//   leader depth    presentState adds pres.depth = the leader's C4PM_SIM.depth(). Every leader message sets the helper's
//                   P.depth (a known depth, else this window's); while P.follow, steps() is C4PM_SIM.flow(P.sim, P.depth)
//                   and flowIdx() maps into that list (presDepth()); the leader uses its own depth. The helper's own
//                   depth() (strip, map, sequence) never changes and is in force again after present (endPresent clears
//                   P.depth).
//   depth change    C4PM_SIM.onChange what 'depth' while presenting. The leader: P.i = flowIdx(SIM.step()), P.owner =
//                   ownerOf(that flow step), renderPres, playHere when it owns the step, then a re-post (C4PM_SIM.go(
//                   SIM.step(), fromPres): the cursor stays, no timer change) so the helper gets the new depth and owner.
//                   A helper: renderPres only (its list follows the leader's depth).
// Text: every name, caption, state and message goes in through textContent; the icon SVG is a constant of sim.js.
(function () {
  'use strict';
  const SIM = window.C4PM_SIM;
  if (!SIM) return;   // no s-items on this page

  const DEFAULT_SEC = 4;
  const TOP = 50;            // px kept free above a fitted step (the head pill)
  const CARD_GAP = 34;       // px between a fitted step and the caption card
  const CHANNEL_ICON = { email: '✉', phone: '☎', letter: '✉', chat: '✎' };
  // UI17-5: the ⧉ note lines (twoWindows): opened, the window link off / not available, no other view to open
  const TWO_NOTE = 'Two windows: through the window link both windows follow the same step; each step plays in the window that shows its view, and the caption card shows in the window that owns the step.';
  const LINK_NOTE = 'Two windows need the window link (gear: Window link On).';
  const NONE_NOTE = 'This s-item has no other view to open.';
  // owner (UI17-3): the link id of the window that plays the current step; null = this window
  // follow / lead / lastFlown (UI17-4a): this window follows another window's present (the helper); the leader's link id;
  // '<step>:<owner>' of the last helper fly (no second fly for the same step and owner)
  // since (UI17-4c): Date.now() when this window started present (the last start leads)
  // twoNote (UI17-5): the ⧉ note line shown ('' = hidden)
  // depth (b853 S6b): the leader's depth (pres.depth) while this window follows; null otherwise
  const P = {
    on: false, sim: null, i: 0, playing: false, timer: 0, prev: null, twoNote: '', owner: null,
    follow: false, lead: null, lastFlown: null, since: 0, depth: null,
  };

  const $ = id => document.getElementById(id);
  const MODE = () => window.C4PM_MODE;
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // b853 S6b: the depth of the present list: the leader's while this window follows, else this window's own
  const presDepth = () => (P.follow && P.depth ? P.depth : SIM.depth());
  const steps = () => SIM.flow(P.sim, presDepth());   // b853 S6: the flow steps at that depth (at code one per step)
  // b853 S6: an original step index (sim.js, a leader's message, &present=) -> its flow index in steps(); clamped to the
  // steps like the cursor; no steps, not an integer or in no flow step: 0. S6b: looked up in steps() (presDepth), as
  // C4PM_SIM.flowIndex takes no depth.
  function flowIdx(i) {
    const n = SIM.steps(P.sim).length;
    if (!Number.isInteger(i) || !n) return 0;
    const k = clamp(i, 0, n - 1), j = steps().findIndex(s => s.members.indexOf(k) >= 0);
    return j < 0 ? 0 : j;
  }
  // b853 S6: the original index of the current flow step (its first member) for SIM.go and the posts; no steps: P.i.
  const curFirst = () => { const st = steps()[P.i]; return st ? st.first : P.i; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const secOf = st => (st && st.durationSec > 0 ? st.durationSec : DEFAULT_SEC);
  const vcls = st => (st.view === 'outside' ? 'out' : st.view);
  function seqOpen() {
    const d = $('seq-drawer');   // UI13 (sim-sequence.js); absent before it
    return !!(d && !d.hidden);
  }

  // Run fn once the map has its new size (hiding or showing the chrome resizes #map-wrap; map.js's ResizeObserver takes the
  // size before the next paint), so a fit is computed for the size it is shown at.
  function whenSized(fn, tries) {
    const map = window.C4PM_STATE && window.C4PM_STATE.map, w = $('map-wrap');
    const sized = !map || !w || !w.clientWidth || (w.clientWidth === map.cw && w.clientHeight === map.ch);
    if (sized || !(tries > 0) || typeof requestAnimationFrame !== 'function') fn();
    else requestAnimationFrame(() => whenSized(fn, tries - 1));
  }

  // Fly the current view so step st sits between TOP and the caption card (the whole height for an outside card).
  function flyToStep(st) {
    const CAM = window.C4PM_CAM, STRIP = window.C4PM_SIMSTRIP;
    const r = STRIP && STRIP.stepRect(st);
    if (!r || !CAM || !window.C4PM_STATE.map.cw) return;
    const card = $('pres') && $('pres').querySelector('.pres-card');
    const bottom = (card && card.offsetHeight || 0) + CARD_GAP;
    window.C4PM_STATE.map.openBand = { top: TOP, bottom };   // b786: the band beside the caption card
    CAM.flyTo(CAM.fitCamIn(r, 0.85, TOP, bottom));
  }

  // UI17-3: the window that plays step st: the lowest-id other linked map window showing st's view (C4PM_LINK.peers() is
  // sorted by id), else null (this window). An outside step is drawn in no view: always this window.
  function ownerOf(st) {
    if (!st || st.view === 'outside') return null;
    const L = window.C4PM_LINK;
    const others = L && L.peers ? L.peers().filter(p => p.map && p.view === st.view) : [];
    return others.length ? others[0].id : null;
  }

  // Play step st in this window: switch to its view, then fly once the map has its size (an outside step: nothing).
  function playHere(st) {
    if (st.view === 'outside') return;
    const at = P.i;
    SIM.goView(st.view, () => whenSized(() => { if (P.on && P.i === at) flyToStep(st); }, 10));
  }

  // UI17-3 (C4PM_LINK.onPeers): a peer came, left or changed its view while presenting: the step may change owner. Same
  // step, timer untouched; a step that comes back plays here; SIM.go re-posts the step with the new owner.
  function peersChanged() {
    if (!P.on) return;
    if (P.follow) {
      // UI17-5: the leader's window left (closed, its link off) or this window's link went off: the helper ends present
      const L = window.C4PM_LINK, ids = L && L.peers ? L.peers().map(p => p.id) : [];
      if (ids.indexOf(P.lead) < 0) endPresent();
      return;   // UI17-4a: the helper takes no step; the leader decides the owner
    }
    const st = steps()[P.i];
    const o = ownerOf(st);
    if (o === P.owner) return;
    P.owner = o;
    renderPres();
    if (P.playing) startBar(secOf(st));   // UI17-4c: the re-render built a new bar; it runs again (P.timer stays)
    if (o === null) playHere(st);
    SIM.go(curFirst(), { fromPres: true });   // b853 S6: the original index
  }

  // What endPresent restores: the view, the s-item and its cursor, the c-item, the sequence drawer, the camera.
  function remember() {
    if (P.on && P.prev) return;   // UI17-5: the view from before this window's FIRST present stays (a helper that leads)
    const map = window.C4PM_STATE && window.C4PM_STATE.map;
    P.prev = {
      view: MODE().get(), sim: SIM.selected(), step: SIM.step(),
      sel: window.C4PM_MAP ? window.C4PM_MAP.selectedId() : null,
      seq: seqOpen(), cam: map && map.cam ? Object.assign({}, map.cam) : null,
    };
  }

  // The present look (P.on already true): #root.presenting (sim.css hides the chrome), #pres shown, no c-item, no sequence.
  function showPresent() {
    const root = $('root'), box = $('pres');
    if (root) root.classList.add('presenting');
    if (box) box.hidden = false;
    if (window.C4PM_MAP && window.C4PM_MAP.selectedId()) window.C4PM_MAP.select(null);
    if (SIM.hooks.seq && seqOpen()) SIM.hooks.seq(false);
  }

  function startPresent(id, at) {
    if (!id || !SIM.byId(id)) return;
    // UI17-5: a helper starts its own present: it stops following without a restore (P.prev stays) and leads; its later
    // since makes the old leader yield (4c)
    if (P.follow) { P.follow = false; P.lead = null; P.lastFlown = null; }
    if (!P.on) remember();
    clearTimeout(P.timer);
    P.on = true; P.sim = id; P.playing = false; P.twoNote = '';
    P.since = Date.now();   // UI17-4c: the last window to start present leads (follow)
    const i = flowIdx(at), n = steps().length;   // b853 S6: `at` is an original index; i the flow index
    // UI17-4c: the cursor and owner before the select, so its post already names the window that plays the step
    if (n) { P.i = clamp(i, 0, n - 1); P.owner = ownerOf(steps()[P.i]); }
    showPresent();
    if (SIM.selected() !== id) SIM.select(id, { fromPres: true, fit: false });
    presGo(i);
  }

  function presGo(i, opts) {   // i: a FLOW index (b853 S6; hooks.presentGo maps sim.js's original index); opts: not used yet
    if (!P.on || P.follow) return;   // UI17-4a: the helper runs no steps (its input goes to the leader: stepTo, 4b)
    clearTimeout(P.timer);
    const list = steps();
    if (!list.length) return;
    P.i = clamp(Number.isInteger(i) ? i : 0, 0, list.length - 1);
    const st = list[P.i];
    P.owner = ownerOf(st);   // UI17-3: before SIM.go, so its post carries the owner
    SIM.go(st.first, { fromPres: true });   // b853 S6: the cursor and the post take the flow step's first original index
    renderPres();
    if (P.owner === null) playHere(st);   // another window owns it: no view switch, no fly here
    schedule();   // the leader's timer runs either way
  }

  // The progress bar of #pres fills over sec seconds (CSS transition under .run); schedule() and the helper (UI17-4a) use it.
  function startBar(sec) {
    const prog = $('pres') && $('pres').querySelector('.pres-prog');
    if (!prog) return;
    prog.classList.remove('run');
    prog.style.setProperty('--pres-sec', sec + 's');
    void prog.offsetWidth;   // the bar starts empty, then the transition to full runs
    prog.classList.add('run');
  }

  // Auto-play: the bar fills over the step's seconds (CSS transition under .run), then the next step.
  function schedule() {
    if (P.follow) return;   // UI17-4a: the helper never sets a timer
    clearTimeout(P.timer);
    if (!P.on || !P.playing) return;
    const sec = secOf(steps()[P.i]);
    startBar(sec);
    P.timer = setTimeout(() => {
      if (P.i < steps().length - 1) presGo(P.i + 1);
      else { P.playing = false; renderPres(); }
    }, sec * 1000);
  }

  function presPlay(on) {
    if (!P.on || P.follow) return;   // UI17-4a: the helper's Play goes to the leader (playTo, 4b)
    P.playing = !!on;
    if (P.playing && P.i >= steps().length - 1) { presGo(0); return; }
    renderPres();
    schedule();
    SIM.go(curFirst(), { fromPres: true });   // UI17-4c: re-post the step, so the helper's Play / Pause and its bar follow
  }

  function endPresent(keep) {
    if (!P.on) return;
    clearTimeout(P.timer);
    const pv = P.prev, helper = P.follow, sim = P.sim, step = curFirst();   // b853 S6: the end message's original index
    P.on = false; P.playing = false; P.prev = null; P.owner = null;
    P.follow = false; P.lead = null; P.lastFlown = null;   // UI17-4a
    P.depth = null;   // b853 S6b: this window's own depth is in force again
    // UI17-5: the leader tells the other windows first (replayed: a window that joins later is not drawn into a finished
    // present); its restore below then posts as before, so they follow its s-item. The helper posts nothing.
    const L = window.C4PM_LINK;
    if (!helper && L) L.post('sim', { sim, step, pres: { end: true } }, { replay: true });
    window.C4PM_STATE.map.openBand = null;   // b786: the next strip fly sets its band again
    const root = $('root'), box = $('pres');
    if (root) root.classList.remove('presenting');
    if (box) { box.hidden = true; box.textContent = ''; box.classList.remove('outside'); box.classList.remove('away'); }
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch (e) { /* not in full screen */ }
    if (keep || !pv) { if (window.C4PM_SIMSTRIP) window.C4PM_SIMSTRIP.render(); return; }
    const quiet = helper ? { remote: true } : {};   // UI17-5: the helper's restore must not move the other windows
    SIM.goView(pv.view, () => whenSized(() => {
      if (P.on) return;   // presenting again before the switch ended
      const CAM = window.C4PM_CAM;
      if (pv.cam && CAM) CAM.flyTo(pv.cam);
      if (SIM.selected() !== pv.sim) SIM.select(pv.sim, Object.assign({ fit: false }, quiet));
      if (pv.sim) SIM.go(pv.step, quiet);
      if (window.C4PM_MAP && pv.sel) window.C4PM_MAP.select(pv.sel);
      if (SIM.hooks.seq && pv.seq !== seqOpen()) SIM.hooks.seq(pv.seq);
      if (window.C4PM_SIMSTRIP) window.C4PM_SIMSTRIP.render();
    }, 10));
  }

  // UI17-4b: the input of the controls and keys. The leader steps / plays itself (presGo, presPlay). The helper asks the
  // leader: a step is a plain 'sim' post (C4PM_SIM.go fromPres: the cursor and map move here, presentState null); the
  // leader's sim.js runs it as a remote go -> presentGo -> presGo decides the owner and posts it with pres; this window
  // follows. Play / pause is a { pres: { req: 'play' | 'pause' } } post (not replayed); the leader runs it in follow().
  function stepTo(i) {
    const list = steps(), n = list.length;
    if (!n) return;
    const j = clamp(i, 0, n - 1);
    if (P.follow) SIM.go(list[j].first, { fromPres: true });   // b853 S6: the target flow step's original index
    else presGo(j);
  }

  function playTo(on) {
    // b853 S6: a request carries the helper's cursor = the leader's own original step (follow), so it never moves the leader
    if (P.follow) window.C4PM_LINK.post('sim', { sim: P.sim, step: SIM.step(), pres: { req: on ? 'play' : 'pause' } });
    else presPlay(on);
  }

  // UI17-5: Exit ✕ and Esc. The leader ends present (its end message ends the helpers). The helper asks the leader with a
  // { pres: { req: 'exit' } } post (not replayed) and does nothing else: the leader's end message then ends this window.
  function exitTo() {
    if (P.follow) window.C4PM_LINK.post('sim', { sim: P.sim, step: SIM.step(), pres: { req: 'exit' } });   // b853 S6: as playTo
    else endPresent();
  }

  // UI17-5, ⧉ Two windows: opens the second window (C4PM_OPEN, openView.js): the IO view when the s-item has io steps and
  // present did not start in IO, else the s-item's first view (sim.views order) other than the one present started in.
  // Returns the note line to show: the explanation, no other view, or the window link is off / not available.
  function twoWindows() {
    const L = window.C4PM_LINK, link = L && L.status ? L.status() : 'off';
    if (link === 'off' || link.indexOf('not available') === 0) return LINK_NOTE;
    const views = SIM.byId(P.sim).views || [], from = P.prev ? P.prev.view : MODE().get();
    const v = views.indexOf('io') >= 0 && from !== 'io' ? 'io' : views.filter(x => x !== from)[0];
    if (!v) return NONE_NOTE;
    window.C4PM_OPEN(v);
    return TWO_NOTE;
  }

  function presKey(e) {
    if (!P.on || !e) return false;
    const k = e.key;
    if (k === 'Escape') { exitTo(); if (e.preventDefault) e.preventDefault(); return true; }   // UI17-5: the helper asks
    // A held Alt / Meta / Ctrl / Shift leaves the key to the browser (Cmd+← = Back, Cmd+F = find), as sim.js does for ← →.
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
    if (k === 'ArrowRight' || k === 'PageDown') stepTo(P.i + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp') stepTo(P.i - 1);
    else if (k === ' ' || e.code === 'Space') playTo(!P.playing);
    else if (k === 'f' || k === 'F') presFull();
    else return false;
    if (e.preventDefault) e.preventDefault();
    return true;
  }

  function presFull() {
    try {
      if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen().catch(() => {}); }
      else {
        const de = document.documentElement;
        if (de && typeof de.requestFullscreen === 'function') {
          const p = de.requestFullscreen();
          if (p && p.catch) p.catch(() => {});
        }
      }
    } catch (e) { /* full screen not allowed here */ }
  }

  // "Stage 2 · Buy · flow s-1 step 4" (journeys).
  function stageLine(sim, st) {
    const sg = (sim.stages || [])[st.stage] || { name: '' };
    const head = 'Stage ' + (st.stage + 1);
    return head + (sg.name && sg.name !== head ? ' · ' + sg.name : '') + (st.flow ? ' · flow ' + st.flow + ' step ' + st.inFlow : '');
  }

  // The controls of renderPres, in order: the progress bar, the dots + buttons row, the ⧉ note, the keys line. They go
  // at the end of the caption card, or (UI17-3 away: another window plays the step) into .pres-ctl without a card.
  function presControls(list, st) {
    const N = list.length;
    const prog = el('div', 'pres-prog' + (P.playing ? ' on' : ''));
    prog.appendChild(el('i'));
    const bar = el('div', 'pres-bar'), dots = el('div', 'pres-dots');
    list.forEach((s, i) => {
      const d = el('button', 'pres-dot' + (i === P.i ? ' cur' : i < P.i ? ' done' : '') + (s.view === 'outside' ? ' out' : '') + (i > 0 && s.stage !== list[i - 1].stage ? ' sep' : ''));
      d.type = 'button';
      d.title = 'Step ' + (i + 1) + ': ' + SIM.stepTarget(s);
      d.setAttribute('aria-label', d.title);
      d.addEventListener('click', () => stepTo(i));
      dots.appendChild(d);
    });
    bar.appendChild(dots);
    const btn = (text, title, fn, off, cls) => {
      const b = el('button', 'tbb' + (cls ? ' ' + cls : ''), text);
      b.type = 'button';
      b.title = title;
      b.disabled = !!off;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    btn('‹ Back', 'Previous step (←)', () => stepTo(P.i - 1), P.i === 0);
    btn(P.playing ? '❚❚ Pause' : '▶ Play', 'Play / pause: each step lasts its durationSec (Space)', () => playTo(!P.playing), false, 'play');
    btn('Next ›', 'Next step (→)', () => stepTo(P.i + 1), P.i === N - 1);
    btn('⛶ Full screen', 'Full screen (F)', presFull);
    const note = el('div', 'pn-note', P.twoNote);
    note.hidden = !P.twoNote;
    // UI17-5: ⧉ opens the second window (twoWindows) and shows the outcome in the note
    btn('⧉ Two windows', 'Present across two windows: opens a second window (window link)', () => { P.twoNote = twoWindows(); note.textContent = P.twoNote; note.hidden = false; });
    btn('Exit ✕', 'Leave present mode and restore the view (Esc)', exitTo);
    // the note is set in place: a playing step's bar keeps running
    return [prog, bar, note, el('div', 'pres-keys', '← → step · Space play / pause · F full screen · Esc exit · ' + secOf(st) + ' s per step when playing')];
  }

  function renderPres() {
    const box = $('pres');
    if (!box) return;
    box.textContent = '';
    box.hidden = !P.on;
    if (!P.on) return;
    const list = steps(), N = list.length, st = list[P.i], sim = SIM.byId(P.sim), out = st.view === 'outside';
    const o = out ? st.outside || { text: '', from: null, channel: null } : null;
    box.classList.toggle('outside', out);
    box.classList.toggle('away', P.owner !== null);   // UI17-3: another window plays this step
    const viewText = out ? 'outside the system' : SIM.viewWord(st.view) + ' view';

    const head = el('div', 'pres-head');
    const ic = el('span', 'sim-ico');
    ic.innerHTML = SIM.icon(sim.kind);   // a constant of sim.js, no data
    head.appendChild(ic);
    head.appendChild(el('span', null, sim.id + ' · ' + sim.title));
    head.appendChild(el('span', 'pres-n', (P.i + 1) + '/' + N));
    head.appendChild(el('span', 'vchip ' + vcls(st), viewText));
    box.appendChild(head);

    if (P.owner !== null) {
      // UI17-3 away: the head pill, one line and the controls (no card); the leader still steps, plays and exits.
      box.appendChild(el('div', 'pres-away', 'Step ' + (P.i + 1) + ' plays in the ' + SIM.viewWord(st.view) + ' window'));
      const ctl = el('div', 'pres-ctl');
      presControls(list, st).forEach(e => ctl.appendChild(e));
      box.appendChild(ctl);
      return;
    }

    const card = el('div', 'pres-card');
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Present: ' + sim.title);
    const top = el('div', 'pres-top');
    top.appendChild(el('span', 'pres-n', 'Step ' + (P.i + 1) + '/' + N));
    if (sim.kind === 'journey') top.appendChild(el('span', null, stageLine(sim, st)));
    top.appendChild(el('span', 'vchip ' + vcls(st), out ? 'outside the system' + (o.channel ? ' · ' + o.channel : '') : viewText));
    if (st.unverified) top.appendChild(el('span', 'vchip unver', '? unverified'));
    card.appendChild(top);

    if (out) {
      const row = el('div', 'pres-top');
      row.appendChild(el('span', 'pres-ico', CHANNEL_ICON[o.channel] || '●'));
      const t = el('div');
      t.appendChild(el('div', 'pres-target', o.text));
      const person = SIM.personName(sim);
      t.appendChild(el('div', 'pres-state', (o.from ? 'from ' + o.from + ' ' : '') + (person ? 'to ' + person + ' ' : '') + '· not drawn in any view'));
      row.appendChild(t);
      card.appendChild(row);
    } else {
      const c = st.call;
      const call = c && c.from && c.to ? '   ·   ' + SIM.nameOfId(c.from, sim) + ' → ' + SIM.nameOfId(c.to, sim) + (c.label ? ' (' + c.label + ')' : '') : '';
      card.appendChild(el('div', 'pres-target', SIM.stepTarget(st) + call));
    }
    // b853 S6: one line per caption of the flow step's members (captions; else the one caption)
    const caps = st.captions && st.captions.length ? st.captions : [st.caption];
    caps.forEach(c => { if (c) card.appendChild(el('div', 'pres-cap', c)); });
    if (st.unverified) card.appendChild(el('div', 'pres-unver', 'Unverified (sim-step-unverified, info): ' + SIM.noPlace(st.unverified).replace(/\.\s*$/, '') + '. Drawn dashed on the map and in the sequence.'));
    if (st.goal) card.appendChild(el('div', 'pres-state', 'goal: ' + st.goal));
    if (st.state) {
      const s = el('div', 'pres-state', 'state: ');
      s.appendChild(el('b', null, st.state));
      card.appendChild(s);
    }
    const html = SIM.rowsTableHtml(SIM.tableStateAt(P.sim, st.last));   // b853 S6: the state after the whole flow step
    if (html) {
      const w = el('div', 'pres-rows');
      w.innerHTML = html;   // built by sim.js rowsTableHtml: every value escaped
      card.appendChild(w);
    }
    presControls(list, st).forEach(e => card.appendChild(e));
    box.appendChild(card);
  }

  // UI17-4a, hooks.presentRemote (every received 'sim' message, after sim.js applied its select / go): a leader's post
  // (pres.lead) makes this window the helper and keeps it on the leader's step, owner and playing. The helper plays a step
  // only when it owns it: a fly in its own view (never a view switch), once per step and owner; the bar runs while playing.
  // It never sets a timer and never posts pres (presentState null).
  function follow(d) {
    // UI17-4b / UI17-5: a helper's request ({ pres: { req } }: playTo, exitTo) runs in the leader
    if (d && d.pres && d.pres.req && P.on && !P.follow) {
      if (d.pres.req === 'play') presPlay(true);
      else if (d.pres.req === 'pause') presPlay(false);
      else if (d.pres.req === 'exit') endPresent();   // UI17-5: its end message ends every helper
      return;
    }
    // UI17-5: this window's leader ended present (its end message): the helper ends too, restoring its own view (no post)
    if (d && d.pres && d.pres.end) { if (P.on && P.follow && d.from === P.lead) endPresent(); return; }
    if (!d || !d.pres || !d.pres.lead) return;   // a plain cursor message (the leader's sim.js runs it) or another request
    if (SIM.hash().seqonly || !$('pres')) return;   // the sequence-only window, no #pres
    if (!SIM.byId(d.sim) || !Number.isInteger(d.step)) return;
    const L = window.C4PM_LINK;
    if (P.on && !P.follow) {
      // UI17-4c: two leaders: the later start (pres.since; equal: the lower link id) leads. The older one yields and
      // follows from this message on; the newer one ignores the message.
      const id = L && L.id ? L.id() : '';
      if (!(d.pres.since > P.since || (d.pres.since === P.since && d.from < id))) return;
      // UI17-5: the yield does not end present (no end message, no restore): it stops leading, and P.prev (the view
      // before this window's FIRST present) stays for its Exit
      clearTimeout(P.timer);
      P.follow = true; P.owner = null; P.lastFlown = null;
      window.C4PM_STATE.map.openBand = null;   // b786: a helper fly sets its own band
    }
    if (!P.on) {
      remember();
      P.on = true; P.follow = true; P.twoNote = '';
      showPresent();
    }
    // b853 S6b: the present list at the leader's depth (a known pres.depth, else this window's), before flowIdx
    P.depth = SIM.DEPTHS.indexOf(d.pres.depth) >= 0 ? d.pres.depth : SIM.depth();
    P.lead = d.from; P.sim = d.sim; P.i = flowIdx(d.step); P.playing = !!d.pres.playing;   // b853 S6: d.step is original
    SIM.go(d.step, { fromPres: true, remote: true });   // UI17-4b: redraw the helper's map for the leader's step (sim.js go() already moved cur; its presentGo hand-off skipped update()); posts nothing
    P.owner = L && L.id && d.pres.owner === L.id() ? null : (d.pres.owner || null);
    renderPres();
    const st = steps()[P.i], key = P.i + ':' + P.owner;
    if (P.owner === null && st && st.view !== 'outside' && key !== P.lastFlown) {
      const at = P.i;
      whenSized(() => { if (P.on && P.follow && P.i === at && P.owner === null) flyToStep(st); }, 10);
    }
    P.lastFlown = key;
    // UI17-4c: the bar runs in every window while playing, whoever owns the step; paused, renderPres built it stopped
    if (P.playing) startBar(d.pres.sec > 0 ? d.pres.sec : secOf(st));
  }

  SIM.hooks.present = startPresent;
  SIM.hooks.presentGo = (i, opts) => presGo(flowIdx(i), opts);   // b853 S6: sim.js hands over an original index
  // sim.js select (not fromPres) ends present for a new selection. UI17-4b: not in the helper: the leader's new s-item
  // arrives as a remote select and the helper keeps following (its remembered view stays for its Exit).
  SIM.hooks.presentEnd = () => { if (P.follow) return; endPresent(true); };
  SIM.hooks.presenting = () => P.on;
  SIM.hooks.presentKey = presKey;
  SIM.hooks.presentRemote = follow;   // UI17-4a
  // UI17-3: every 'sim' post of the leader says it leads, who owns the step (a link id), playing and the step's seconds.
  // UI17-4a: the helper posts no pres (only the leader does).
  SIM.hooks.presentState = () => {
    if (!P.on || P.follow) return null;
    const L = window.C4PM_LINK, pres = { lead: true, playing: P.playing, sec: secOf(steps()[P.i]), since: P.since, depth: SIM.depth() };
    if (P.owner !== null) pres.owner = P.owner;
    else if (L && L.id) pres.owner = L.id();
    return { pres };
  };
  if (window.C4PM_LINK && window.C4PM_LINK.onPeers) window.C4PM_LINK.onPeers(peersChanged);
  // b853 S6 / S6b: a depth change while presenting. The leader: the card shows the flow step holding the cursor, its owner
  // is decided again (plays here when this window owns it) and the step is re-posted, so the helper gets the new depth
  // and owner; the cursor and the timer stay. A helper: its list follows the leader's depth, so only a re-render.
  SIM.onChange(e => {
    if (!P.on || e.what !== 'depth') return;
    if (P.follow) { renderPres(); return; }
    P.i = flowIdx(SIM.step());
    const st = steps()[P.i];
    if (!st) return;
    P.owner = ownerOf(st);
    renderPres();
    if (P.owner === null) playHere(st);
    SIM.go(SIM.step(), { fromPres: true });
  });
})();
