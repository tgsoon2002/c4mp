// brand.js: the C4MP loading spinner (Phase 35 C, b945; Brand/logo/c4mp-spinner.svg, logo 13). Inlined at the start of the page's
// script block by renderPage (src/page/html.ts, the PRELUDE slot), with store.js, so every later script may use it.
//
// CONTRACT  window.C4PM_BRAND = { spinner }
//   spinner(px)  a new <span class="c4mp-spin"> holding an inline SVG, px wide and high (default 20): C, M and P circle the tent-4 and
//                its core glows. Pure inline markup: no network load. The colours come from the page theme (style.css: color
//                var(--brand) on .c4mp-spin, the core var(--brand-warm)); the motion is CSS (style.css, .c4mp-crew / .c4mp-glow) and
//                stops under prefers-reduced-motion. role="img" + aria-label "Loading" for a screen reader.
(function () {
  'use strict';

  const SVG =
    '<svg viewBox="0 0 140 140" width="__PX__" height="__PX__" aria-hidden="true" focusable="false">' +
    '<g class="c4mp-crew">' +
    '<circle cx="70" cy="70" r="62" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 7"/>' +
    '<g font-family="inherit" font-weight="700" font-size="30" fill="currentColor" text-anchor="middle">' +
    '<text x="24" y="80">C</text><text x="112" y="44">M</text><text x="112" y="122">P</text></g></g>' +
    '<g transform="translate(44 34)" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">' +
    '<path d="M34 4 L4 40 H34 Z"/><path d="M34 18 L16 40 H34" stroke-width="3.5"/><path d="M34 4 V64 M34 40 H46"/></g>' +
    '<path class="c4mp-glow" d="M78 64 L70 74 H78 Z"/></svg>';

  function brandSpinner(px) {
    const size = Number(px) > 0 ? Number(px) : 20;
    const el = document.createElement('span');
    el.className = 'c4mp-spin';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Loading');
    el.innerHTML = SVG.split('__PX__').join(String(size));
    return el;
  }

  window.C4PM_BRAND = { spinner: brandSpinner };
})();
