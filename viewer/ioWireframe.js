// ioWireframe.js (W4, b300; spec Document/Roadmap/PHASE_20_WIREFRAMES.md section 0 C6/C7/C8): the browser measurer of screen wireframes.
// A wireframe is bare HTML written by a repo author, so it is UNTRUSTED: it is parsed inertly, cleaned with allow-lists, and only then moved
// into a hidden off-screen shadow root where the browser lays it out once. Nothing is drawn here: boxes go in, boxes come out.
// CONTRACT  window.C4PM_IO_WIREFRAME = { measureAll(items, rules) -> { [fqn]: { ok: true, viewport: {w,h}, boxes } | { ok: false, reason, reasons } } }
//   items = [{ fqn, html, viewport: {w, h} }]       html: the wireframe fragment (linked sheets already inlined as <style>, H11)
//   rules = { css: string[], base: string, keepTags: string[], keepAttrs: string[] }   (C2: the server's single rule table, C4PM_DATA.wireframeRules)
//     css: kept CSS property names; a trailing '*' is a prefix ('flex*' keeps flex-grow), anything else is an exact name
//     base: the base style (H10), trusted, applied unfiltered first
//     keepTags: allowed tag names (lower case); 'form' is turned into a 'div' and 'style' is read, never copied
//     keepAttrs: allowed attribute names; 'hidden' is turned into data-c4-hidden (laid out as if shown, H6)
//   box = { ref, x, y, w, h, hidden, order }   x, y relative to the viewport element; order = document order of the [data-c4] elements
//   Errors are never swallowed (R3, C8): every problem found is a reason on THAT screen only (the others still measure):
//   a zero-size box (display:none, a closed <details>), a box outside the viewport, no [data-c4] at all, a data-c4 inside a dropped tag
//   (svg, object...), a bad viewport, or no layout engine (the vm harness has no DOMParser): { ok: false, reason: 'a; b', reasons: ['a', 'b'] }.
(function() {
  const HOST_STYLE = 'position:fixed;left:-40000px;top:0;visibility:hidden;contain:strict;';

  // Which layout engine parts we need; the first missing one is the reason (vm harness: no DOMParser).
  function engineGap() {
    if (typeof DOMParser === 'undefined') return 'no layout engine: DOMParser is missing';
    if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function') return 'no layout engine: constructable stylesheets are missing';
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return 'no layout engine: document is missing';
    if (typeof Element === 'undefined' || typeof Element.prototype.attachShadow !== 'function') return 'no layout engine: shadow DOM is missing';
    return null;
  }

  // A property filter from the rule table: 'flex*' is a prefix, 'order' an exact name.
  function propFilter(list) {
    const exact = new Set(), prefix = [];
    for (const raw of list) {
      const p = String(raw).toLowerCase();
      if (p.endsWith('*')) prefix.push(p.slice(0, -1)); else exact.add(p);
    }
    return name => exact.has(name) || prefix.some(p => name.startsWith(p));
  }

  // Remove every declaration the filter does not keep. Walks backwards: removeProperty shifts the indexes.
  function cleanStyle(st, keep) {
    for (let i = st.length - 1; i >= 0; i--) if (!keep(st[i])) st.removeProperty(st[i]);
  }

  // Author CSS -> a cleaned CSSStyleSheet. replaceSync ignores @import; only plain style rules survive (@media, @font-face, nested
  // rules are dropped), :host rules are dropped so author CSS cannot restyle our own host, and each kept rule is cut down to the kept properties.
  function cleanSheet(text, keep) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      const plain = r.style && typeof r.selectorText === 'string' && !(r.cssRules && r.cssRules.length) && r.selectorText.indexOf(':host') < 0;
      if (plain) cleanStyle(r.style, keep); else sheet.deleteRule(i);
    }
    return sheet;
  }

  // Clean the children of `parent` in the inert document, in place. Collects the <style> texts and the data-c4 refs that sat inside dropped tags.
  function cleanTree(parent, ctx) {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType === 3) continue;                                  // text stays: it sizes the box (never drawn)
      if (n.nodeType !== 1) { n.remove(); continue; }                  // comments, processing instructions
      let el = n;
      const tag = el.localName;
      if (tag === 'style') { ctx.styles.push(el.textContent); el.remove(); continue; }
      if (tag === 'form') {                                            // form is unwrapped: children kept in a div
        const div = parent.ownerDocument.createElement('div');
        while (el.firstChild) div.appendChild(el.firstChild);
        parent.replaceChild(div, el);
        el = div;
      } else if (!ctx.keepTags.has(tag)) {
        const refs = Array.from(el.querySelectorAll('[data-c4]')).concat(el.hasAttribute('data-c4') ? [el] : []);
        for (const r of refs) ctx.reasons.push('data-c4 "' + r.getAttribute('data-c4') + '" is inside <' + tag + '>, which is removed');
        el.remove();
        continue;
      }
      for (const a of Array.from(el.attributes)) if (!ctx.keepAttrs.has(a.name)) el.removeAttribute(a.name);
      if (el.hasAttribute('style')) { cleanStyle(el.style, ctx.keepCss); if (!el.getAttribute('style')) el.removeAttribute('style'); }
      if (el.hasAttribute('hidden')) { el.removeAttribute('hidden'); el.setAttribute('data-c4-hidden', ''); }
      cleanTree(el, ctx);
    }
  }

  const goodSize = v => v && Number.isFinite(v.w) && Number.isFinite(v.h) && v.w > 0 && v.h > 0;

  // Phase 1 of one screen: clean, build the host. No layout is read here, so all screens share one layout pass in phase 2.
  function prepare(item, rules, ctx0) {
    const reasons = [];
    if (!goodSize(item.viewport)) return { fail: ['bad viewport: ' + JSON.stringify(item.viewport)] };
    const { w: W, h: H } = item.viewport;
    const doc = new DOMParser().parseFromString('<body>' + String(item.html), 'text/html');   // inert: nothing runs, nothing loads
    const ctx = { styles: [], reasons, keepTags: ctx0.keepTags, keepAttrs: ctx0.keepAttrs, keepCss: ctx0.keepCss };
    cleanTree(doc.body, ctx);

    const host = document.createElement('div');
    host.style.cssText = HOST_STYLE + 'width:' + W + 'px;height:' + H + 'px;';   // off-screen measuring host, never shown; css-guard: dynamic
    const root = host.attachShadow({ mode: 'open' });
    const vp = document.createElement('div');                          // kept in a variable: an author id="vp" cannot break the lookup
    for (const [k, v] of [['position', 'relative'], ['width', W + 'px'], ['height', H + 'px']]) vp.style.setProperty(k, v, 'important');   // css-guard: dynamic
    for (const c of Array.from(doc.body.childNodes)) vp.appendChild(document.importNode(c, true));   // cleaned nodes only, no string round trip
    root.appendChild(vp);
    const base = new CSSStyleSheet();
    base.replaceSync(rules.base);
    root.adoptedStyleSheets = [base].concat(ctx.styles.map(t => cleanSheet(t, ctx0.keepCss)));
    return { host, vp, W, H, reasons };
  }

  // Phase 2 of one screen: read the boxes and check them.
  function read(p) {
    const reasons = p.reasons.slice();
    const vr = p.vp.getBoundingClientRect();
    const els = Array.from(p.vp.querySelectorAll('[data-c4]'));
    const boxes = els.map((el, order) => {
      const r = el.getBoundingClientRect();
      return { ref: el.getAttribute('data-c4'), x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height, hidden: !!el.closest('[data-c4-hidden]'), order };
    });
    for (const b of boxes) {
      const d = els[b.order].closest('details:not([open])'), sm = els[b.order].closest('summary');
      if (d && !(sm && sm.parentElement === d)) reasons.push('data-c4 "' + b.ref + '" is inside a closed <details>, which is not laid out');   // Chrome gives such a child a size anyway
      else if (b.w <= 0 || b.h <= 0) reasons.push('data-c4 "' + b.ref + '" has no size (display:none or a closed <details>?)');
      else if (b.x >= p.W || b.y >= p.H || b.x + b.w <= 0 || b.y + b.h <= 0) reasons.push('data-c4 "' + b.ref + '" is outside the ' + p.W + 'x' + p.H + ' viewport');
    }
    if (!boxes.length && !reasons.length) reasons.push('the wireframe has no data-c4 element');
    return reasons.length ? { ok: false, reason: reasons.join('; '), reasons } : { ok: true, viewport: { w: p.W, h: p.H }, boxes };
  }

  function measureAll(items, rules) {
    const out = {};
    const gap = engineGap();
    if (gap) { for (const it of items) out[it.fqn] = { ok: false, reason: gap, reasons: [gap] }; return out; }
    const ctx0 = { keepTags: new Set(rules.keepTags), keepAttrs: new Set(rules.keepAttrs), keepCss: propFilter(rules.css) };
    const prepared = [];
    try {
      for (const it of items) {
        const p = prepare(it, rules, ctx0);
        if (p.fail) out[it.fqn] = { ok: false, reason: p.fail.join('; '), reasons: p.fail }; else prepared.push([it.fqn, p]);
      }
      for (const [, p] of prepared) document.body.appendChild(p.host);
      for (const [fqn, p] of prepared) out[fqn] = read(p);           // the first read lays everything out; the rest reuse that layout
    } finally {
      for (const [, p] of prepared) p.host.remove();
    }
    return out;
  }

  window.C4PM_IO_WIREFRAME = { measureAll };
})();
