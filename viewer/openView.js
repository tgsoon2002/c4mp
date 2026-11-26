// openView.js: open a view in its own window, and the view switch in the top bar (P20-T5-0, b254; P20-T5-G, b261; VIEW-0, b337).
// Loaded after map.js (src/view/html.ts VIEWER_SCRIPTS).
//
// CONTRACT  window.C4PM_OPEN = function (mode) { ... }
//   mode = a registered view (mode.js C4PM_VIEWS): opens that view in a named popup window ('c4pm-' + mode) and shows a toast in
//   #view-toast. The URL is location.href without its hash, plus '#' + mode + '&bare' ('#io&bare', '#arch&bare')
//   (P20-T5-Q, b264: the new window shows only the map, see mode.js bare()). A name that is not registered throws.
//   A named window that already shows the same URL is only focused (no navigation, so no hashchange).
//   C4PM_OPEN.toast(msg): the same toast for another script (Phase 25 UI7: an outside step); one shared timer.
//   Wired to #view-switch at the end of this script (VIEW-0, b337): see wireSwitch.
(function () {
  var TOAST_MS = 2500;
  var BLOCKED = 'The browser blocked the new window - allow pop-ups for this page';
  var timer = 0;   // one timer: a second toast restarts it

  // The registered view of this name (label, short: mode.js registerView); an unknown name is an error.
  function viewOf(mode) {
    if (!Object.prototype.hasOwnProperty.call(window.C4PM_VIEWS, mode)) throw new Error('C4PM_OPEN: no view ' + JSON.stringify(mode));
    return window.C4PM_VIEWS[mode];
  }

  // Does nothing visible when the page has no #view-toast.
  function toast(msg) {
    var t = document.getElementById('view-toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { t.hidden = true; }, TOAST_MS);
  }

  window.C4PM_OPEN = function (mode) {
    var label = viewOf(mode).label;
    var url = location.href.split('#')[0] + '#' + mode + '&bare';
    var w = null;
    try { w = window.open(url, 'c4pm-' + mode, 'popup,width=1280,height=800'); }
    catch (e) { w = null; }   // a throwing open is the same as a blocked one (spec b261)
    if (!w) { toast(BLOCKED); return; }
    w.focus();
    toast('Opened the ' + label + ' in its own window');
  };
  window.C4PM_OPEN.toast = toast;

  // VIEW-0 (b337): #view-switch (class .seg) gets one button per registered view, in registration order. Text = label,
  // data-short = short (style.css shows it at narrow widths; the title carries the full name), aria-pressed = the current view.
  // b602: with openIn 'window' the title of another view adds ' (opens in its own window)'; it follows the setting.
  // A view without data (C4PM_MODE.has false) is disabled with a title. Click on another view: setting openIn 'window' ->
  // C4PM_OPEN(mode); 'here' -> location.hash ('' for arch, '#<name>' else), the mode switch then follows through mode.js's
  // hashchange listener. A page without #view-switch does nothing.
  function wireSwitch() {
    var box = document.getElementById('view-switch');
    if (!box) return;
    var buttons = Object.keys(window.C4PM_VIEWS).map(function (mode) {
      var spec = window.C4PM_VIEWS[mode];
      var b = document.createElement('button');
      b.setAttribute('type', 'button');
      b.setAttribute('data-mode', mode);
      b.setAttribute('data-short', spec.short);
      b.textContent = spec.label;
      b.addEventListener('click', function () {
        if (b.disabled || mode === window.C4PM_MODE.get()) return;
        if (window.C4PM_SETTINGS.get('openIn') === 'here') location.hash = mode === 'arch' ? '' : '#' + mode;
        else window.C4PM_OPEN(mode);
      });
      box.appendChild(b);
      return { b: b, mode: mode, spec: spec };
    });
    function refresh() {
      var now = window.C4PM_MODE.get();
      var inWindow = window.C4PM_SETTINGS.get('openIn') === 'window';
      buttons.forEach(function (x) {
        x.b.setAttribute('aria-pressed', String(x.mode === now));
        x.b.disabled = !window.C4PM_MODE.has(x.mode);
        x.b.setAttribute('title', x.b.disabled ? 'Nothing for the ' + x.spec.label + ' in the plan yet'
          : x.spec.label + (inWindow && x.mode !== now ? ' (opens in its own window)' : ''));
      });
    }
    refresh();
    window.C4PM_MODE.onChange(refresh);
    window.C4PM_SETTINGS.onChange(function (key) { if (key === 'openIn') refresh(); });
  }
  wireSwitch();
})();
