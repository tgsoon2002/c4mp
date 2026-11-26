// serve-boot.js: the boot of the page shell that `c4mp serve` sends (Phase 30 SV4, b791). NOT in VIEWER_SCRIPTS: the
// static page (c4mp view) never holds it; renderViewShell (src/page/html.ts) puts it in the scripts slot of the shell.
// (1) The key: the URL printed by c4mp serve ends in '#t=<token>'. The token goes to sessionStorage 'c4mp.token:<port>'
//     (a reload and a view window opened from this tab keep it) and leaves the URL (history.replaceState) before any
//     viewer script reads the hash; the other hash parts stay ('#io&t=abc' -> '#io'). No token in the hash: the stored one.
// (2) GET api/boot with the header X-C4PM-Token (never a cookie: section 4.2 of the Phase 30 plan). Relative URLs only.
// (3) Answer ok: window.C4PM_DATA = the page data, window.C4PM_LIVE = { generation, stamps, settings, error, request, dirty, isDirty },
//     then the viewer scripts load from viewer.js. Else one line of text in #map-wrap says what to do, and the light
//     (#header data-live) is red: 'stopped' for a lost server, 'failed' for a missing key or a bad answer.
// (4) dirty(fn) registers an unsaved-edits check (SV8: controls.js layout edits, board-kanban.js pending moves);
//     isDirty() is true when any check is true or throws (a broken check keeps the edits: never reload over them).
(function () {
  const HEADER = 'X-C4PM-Token';
  const storeKey = 'c4mp.token:' + location.port;
  const NEEDS_LINK = 'This page needs the link that c4mp serve printed (it carries a key). Open that link again. Run `c4mp serve --link` to see it.';
  const NOT_RUNNING = 'c4mp serve is not running. Start it again: c4mp serve --repo <path>';
  const LOADING = 'Loading the map ...';

  // The token from the hash (stored, then cut from the URL), else the one this tab stored before; '' when none.
  function takeToken() {
    const parts = location.hash.replace(/^#/, '').split('&').filter(Boolean);
    const found = parts.find(p => p.slice(0, 2) === 't=');
    if (!found) {
      try { return sessionStorage.getItem(storeKey) || ''; } catch (err) { return ''; }
    }
    const token = decodeURIComponent(found.slice(2));
    try { sessionStorage.setItem(storeKey, token); } catch (err) { /* storage blocked: the key lasts until a reload */ }
    const rest = parts.filter(p => p !== found);
    history.replaceState(history.state, '', location.pathname + location.search + (rest.length ? '#' + rest.join('&') : ''));
    return token;
  }

  function say(text) {
    const wrap = document.getElementById('map-wrap');
    if (wrap) wrap.textContent = text;
  }

  // Phase 35 C (b945): the first load shows the C4MP spinner (brand.js) and a line of text in #map-wrap until api/boot answers;
  // say() replaces it on failure, hideLoading() removes it when the viewer scripts start. A missing element: skipped.
  function showLoading() {
    const wrap = document.getElementById('map-wrap');
    if (!wrap || !window.C4PM_BRAND) return;
    const box = document.createElement('div');
    box.id = 'boot-loading';
    box.className = 'c4mp-boot';
    box.setAttribute('role', 'status');
    box.appendChild(window.C4PM_BRAND.spinner(48));
    const t = document.createElement('span');
    t.textContent = LOADING;
    box.appendChild(t);
    wrap.appendChild(box);
  }
  function hideLoading() {
    const box = document.getElementById('boot-loading');
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  // The light on a failed boot (live.js sets it once the viewer runs). Missing header: skip.
  function light(state) {
    const h = document.getElementById('header');
    if (h && h.setAttribute) h.setAttribute('data-live', state);
  }

  // Unsaved-edit checks (SV8, b795): registered by viewer scripts at their load, asked by live.js before a reload.
  const checks = [];
  function dirty(fn) {
    if (typeof fn !== 'function') throw new TypeError('C4PM_LIVE.dirty needs a function');
    checks.push(fn);
  }
  function isDirty() {
    return checks.some(f => { try { return !!f(); } catch (err) { return true; } });
  }

  const token = takeToken();

  // One API call: the key header, a JSON body when given. Resolves { status, json } (json null when the answer is not JSON).
  function request(method, path, body) {
    const headers = {};
    headers[HEADER] = token;
    const init = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(res => res.json().then(json => ({ status: res.status, json: json }), () => ({ status: res.status, json: null })));
  }

  if (!token) { light('failed'); say(NEEDS_LINK); return; }
  showLoading();
  request('GET', 'api/boot').then(ans => {
    if (ans.status === 401) { light('failed'); say(NEEDS_LINK); return; }
    if (ans.status !== 200 || !ans.json) { light('failed'); say('c4mp serve answered ' + ans.status + ((ans.json && ans.json.message) ? ': ' + ans.json.message : '') + '. Reload the page.'); return; }
    const boot = ans.json;
    hideLoading();
    window.C4PM_DATA = boot.data;
    window.C4PM_LIVE = { generation: boot.generation, stamps: boot.stamps, settings: boot.settings, error: boot.error, request: request, dirty: dirty, isDirty: isDirty };
    const s = document.createElement('script');
    s.src = 'viewer.js';
    document.body.appendChild(s);
  }, () => { light('stopped'); say(NOT_RUNNING); });
})();
