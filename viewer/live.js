// live.js: the live refresh of a page served by `c4mp serve` (Phase 30 SV8 b795 + b901; spec: scratchpad p30-live/spec-sv7-sv8-b901.md).
// Does nothing without window.C4PM_LIVE (the static page of c4pm view has no light and makes no request). Loads last: it reads
// C4PM_VIEWSTATE and the dirty checks the files before it registered.
// Contract: a long-poll loop on GET api/wait?since=<generation> (C4PM_LIVE.request).
//   new generation, no unsaved edits -> save the view state, reload the page (light: none, the page is gone)
//   new generation, C4PM_LIVE.isDirty() -> light 'new' (amber) + a Reload button; the page keeps its state
//   building -> 'updating' (amber); error -> 'failed' (red); idle -> 'live' (green)
//   lost server -> 'stopped' (red), retry every 5 s; 401 -> 'stopped', the key is from an earlier run, polling ends
// The light is #header[data-live] (style.css draws it); #live-badge holds the same state as text (textContent only).
(function () {
  'use strict';
  const LIVE = window.C4PM_LIVE;
  if (!LIVE || typeof LIVE.request !== 'function') return;

  const RETRY_MS = 5000;
  const LIVE_TEXT = 'Live: the map is up to date';
  const UPDATING = 'Updating ...';
  const NEW_DATA = 'New data. Your unsaved edits keep this page as it is. ';
  const FAILED = 'Refresh failed: ';
  const STOPPED = 'c4mp serve stopped. Retrying every 5 s; start it again with c4mp serve --repo <path>';
  const RESTARTED = 'c4mp serve was restarted. Open the link it printed.';

  let generation = LIVE.generation; // the one this page shows
  let held = false;                 // a newer generation waits behind unsaved edits
  let lost = false;                 // b920: the server was gone; its next answer may come from a restarted server

  // #header data-live=<state>; #live-badge text. A missing element: that part is skipped.
  function setLiveLight(state, text) {
    const h = document.getElementById('header');
    if (h && h.setAttribute) h.setAttribute('data-live', state);
    const b = document.getElementById('live-badge');
    if (!b) return;
    while (b.firstChild && b.removeChild) b.removeChild(b.firstChild);
    b.textContent = text;
    b.hidden = false;
    b.title = text;
  }

  // Phase 35 C (b945): the C4MP spinner (brand.js) in front of the text of the 'updating' (rebuilding) state. A missing element: skipped.
  function addSpinner() {
    const b = document.getElementById('live-badge');
    if (!b || !window.C4PM_BRAND || !b.insertBefore) return;
    b.insertBefore(window.C4PM_BRAND.spinner(16), b.firstChild);
  }

  function reloadNow() {
    try { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.save(); } catch (err) { /* the page still reloads */ }
    location.reload();
  }

  // The amber 'new data' state: text + a Reload button in the badge.
  function setNew() {
    setLiveLight('new', NEW_DATA);
    const b = document.getElementById('live-badge');
    if (!b) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'live-reload';
    btn.textContent = 'Reload';
    btn.addEventListener('click', reloadNow);
    b.appendChild(btn);
  }

  function dirtyNow() {
    return typeof LIVE.isDirty === 'function' && !!LIVE.isDirty();
  }

  function onAnswer(ans) {
    if (ans.status === 401) { setLiveLight('stopped', RESTARTED); return; }
    const j = ans.json;
    if (ans.status !== 200 || !j) {
      setLiveLight('failed', 'c4mp serve answered ' + ans.status + '. Retrying.');
      setTimeout(pollLive, RETRY_MS);
      return;
    }
    if (lost) {   // b920: back after a loss (a restart keeps the port and the key): reload, unless edits are unsaved
      lost = false;
      if (!dirtyNow()) { reloadNow(); return; }
      generation = j.generation;
      held = true;
      setNew();
      pollLive();
      return;
    }
    if (j.generation !== generation) {
      if (dirtyNow()) {
        generation = j.generation;
        held = true;
        setNew();
        pollLive();
      } else {
        reloadNow();
      }
      return;
    }
    if (j.error) setLiveLight('failed', FAILED + j.error);
    else if (j.building) { setLiveLight('updating', UPDATING); addSpinner(); }
    else if (held) setNew();
    else setLiveLight('live', LIVE_TEXT);
    pollLive();
  }

  function onLost() {
    lost = true;
    setLiveLight('stopped', STOPPED);
    setTimeout(pollLive, RETRY_MS);
  }

  function pollLive() {
    LIVE.request('GET', 'api/wait?since=' + generation).then(onAnswer, onLost);
  }

  if (LIVE.error) setLiveLight('failed', FAILED + LIVE.error);
  else setLiveLight('live', LIVE_TEXT);
  pollLive();
})();
