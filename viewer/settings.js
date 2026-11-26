// settings.js: the viewer's rarely-changed options, ONE module (P20-T11, b232).
// Loaded FIRST (src/view/html.ts VIEWER_SCRIPTS); every other script reads window.C4PM_SETTINGS and keeps no copy.
// Stored per browser as one JSON object in localStorage 'c4mp.settings' (the old 'c4pm.settings' is still read); never written to the plan or the repo.
// Served page (b646): the file ~/.c4pm/settings.json wins at load (C4PM_LIVE.settings) and every change is sent with PUT api/settings; the static page never.
// Later items add their key to DEF (label + options + default): the popup in controls.js is built from this table.
(function () {
  const STORE_KEY = 'c4mp.settings';   // Phase 35 C (b945): read through C4PM_STORE (store.js): the old 'c4pm.settings' is read when this one is missing
  const OLD_SEARCH_KEY = 'c4mp.searchMode';   // before P20-T11 the search start mode lived here; migrated once below

  // key -> { label, opts: [[value, text], ...], def, status? }
  // P20-T5-0 (b254): an entry may have status(): string, a line shown under its row, re-read each time the popup opens.
  const DEF = {
    theme: { label: 'Theme', opts: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], def: 'system' },
    search: { label: 'Search starts in', opts: [['names', 'Names'], ['content', 'Content']], def: 'names' },
    help: { label: 'Help text on the map', opts: [['show', 'Show'], ['hide', 'Hide']], def: 'show' },
    openIn: { label: 'Open a view in', opts: [['window', 'New window'], ['here', 'This window']], def: 'window' },   // P20-T12 (b233)
    lightImpl: { label: 'Light implemented components', opts: [['on', 'On'], ['off', 'Off']], def: 'off' },   // b130: ring on components a screen calls (map.js buildImpl)
    link: { label: 'Window link', opts: [['on', 'On'], ['off', 'Off']], def: 'on', status: () => (statusFns.link ? statusFns.link() : '') },   // link.js registers it (setStatus)
  };
  const valid = (key, v) => !!DEF[key] && DEF[key].opts.some(o => o[0] === v);

  const statusFns = {};   // key -> status() registered by the script that owns the setting (setStatus), so settings.js names no later script
  const cur = {};
  const listeners = [];
  // Served page (c4pm serve, b646): window.C4PM_LIVE has request(). Then ~/.c4pm/settings.json wins at load (a valid value
  // from C4PM_LIVE.settings over localStorage) and each change is sent back with PUT api/settings. The static page: browser only.
  const LIVE = window.C4PM_LIVE && typeof window.C4PM_LIVE.request === 'function' ? window.C4PM_LIVE : null;
  let pushTimer = null;

  function save() {
    window.C4PM_STORE.set(STORE_KEY, JSON.stringify(cur));   // storage blocked: the setting lasts for this page only
  }

  // Storage is the one place an error is tolerated: blocked storage or unparsable JSON = defaults.
  function load() {
    let saved = {};
    let old = null;
    try {
      const raw = window.C4PM_STORE.get(STORE_KEY);
      if (raw) saved = JSON.parse(raw) || {};
      old = window.C4PM_STORE.get(OLD_SEARCH_KEY);
    } catch (err) { /* storage blocked or not JSON: defaults */ }
    Object.keys(DEF).forEach(k => { cur[k] = valid(k, saved[k]) ? saved[k] : DEF[k].def; });
    // One-time migration: no stored search value yet and the old key exists -> use it, write it into c4mp.settings, drop the old key.
    if (!valid('search', saved.search) && old !== null) {
      if (valid('search', old)) cur.search = old;
      save();
      window.C4PM_STORE.remove(OLD_SEARCH_KEY);   // removes the old c4pm.searchMode too
    }
    // Served page (b646): a valid value from the settings file wins over the browser copy; the browser copy then follows.
    const file = LIVE && LIVE.settings && typeof LIVE.settings === 'object' ? LIVE.settings : null;
    if (file) {
      let changed = false;
      Object.keys(DEF).forEach(k => { if (valid(k, file[k]) && cur[k] !== file[k]) { cur[k] = file[k]; changed = true; } });
      if (changed) save();
    }
  }

  // Served page only (b646): 300 ms after the last change send all six settings; the file is replaced. The answer and errors are ignored.
  function pushSettings() {
    if (!LIVE) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      try {
        const p = LIVE.request('PUT', 'api/settings', { settings: Object.assign({}, cur) });
        if (p && typeof p.catch === 'function') p.catch(() => { /* the browser copy stays */ });
      } catch (err) { /* the browser copy stays */ }
    }, 300);
  }

  // What a setting does to the page itself. Settings other scripts own (search) are applied by them through onChange.
  function apply(key) {
    if (key === 'theme') {
      const html = document.documentElement;
      if (cur.theme === 'system') html.removeAttribute('data-theme'); else html.setAttribute('data-theme', cur.theme);
      // The map reads its colours from CSS at draw time: map.js subscribes (onChange) and asks for a redraw.
    } else if (key === 'help') {
      const root = document.getElementById('root');
      if (root) root.classList.toggle('no-help', cur.help === 'hide');
    }
  }

  window.C4PM_SETTINGS = {
    DEF,
    get(key) {
      if (!DEF[key]) throw new Error('C4PM_SETTINGS.get: unknown setting ' + key);
      return cur[key];
    },
    set(key, value) {
      if (!valid(key, value)) throw new Error('C4PM_SETTINGS.set: ' + key + ' cannot be ' + value);
      if (cur[key] === value) return;
      cur[key] = value;
      save();
      pushSettings();
      apply(key);
      listeners.forEach(fn => fn(key, value));
    },
    // fn(key, value) runs after a setting changed, whoever changed it (the popup or another script's own control).
    onChange(fn) { listeners.push(fn); },
    // setStatus(key, fn): fn() -> string, the line shown under the row of an entry that has status (DEF.link). Unknown key throws.
    setStatus(key, fn) {
      if (!DEF[key] || !DEF[key].status) throw new Error('C4PM_SETTINGS.setStatus: setting ' + key + ' has no status line');
      if (typeof fn !== 'function') throw new Error('C4PM_SETTINGS.setStatus: fn must be a function');
      statusFns[key] = fn;
    },
  };

  load();
  // At load only a stored non-default value has something to apply (the page starts in the default state).
  Object.keys(DEF).forEach(k => { if (cur[k] !== DEF[k].def) apply(k); });
})();
