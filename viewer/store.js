// store.js: the one place the viewer reads and writes its saved settings (Phase 35 C, b945). Inlined at the start of the page's
// script block by renderPage (src/page/html.ts, the PRELUDE slot, PRELUDE_SCRIPTS), before the inline scripts of index.html and every viewer script.
//
// CONTRACT  window.C4PM_STORE = { get, set, remove }   (keys are the NEW names, 'c4mp.<name>')
//   get(key)     the value of localStorage[key]; when that is missing, the value of the old key 'c4pm.<name>' (kept for two
//                versions so a user's saved panel widths, theme, ... survive the rename); null when neither exists or storage is blocked.
//   set(key, v)  writes the NEW key only; the old key is never written. Storage blocked = nothing kept (no error).
//   remove(key)  removes the new key AND the old one (else get() would find the old value again). Storage blocked = nothing.
// Every access is in try/catch: blocked storage is the one error the viewer tolerates here.
(function () {
  'use strict';

  const NEW_PREFIX = 'c4mp.';
  const OLD_PREFIX = 'c4pm.';

  // 'c4mp.leftWidth' -> 'c4pm.leftWidth'; a key without the new prefix has no old name (null).
  function oldKeyOf(key) { return String(key).indexOf(NEW_PREFIX) === 0 ? OLD_PREFIX + String(key).slice(NEW_PREFIX.length) : null; }

  function storeGet(key) {
    try {
      let v = localStorage.getItem(key);
      const old = oldKeyOf(key);
      if ((v === null || v === undefined) && old) v = localStorage.getItem(old);
      return v === undefined ? null : v;
    } catch (e) { return null; }
  }

  function storeSet(key, v) {
    try { localStorage.setItem(key, v); } catch (e) { /* storage blocked: ignore */ }
  }

  function storeRemove(key) {
    try {
      localStorage.removeItem(key);
      const old = oldKeyOf(key);
      if (old) localStorage.removeItem(old);
    } catch (e) { /* storage blocked: ignore */ }
  }

  window.C4PM_STORE = { get: storeGet, set: storeSet, remove: storeRemove };
})();
