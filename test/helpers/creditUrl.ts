// P22 b168 (K 2026-11-18): the page carries one external URL, the "Made with C4MP" credit link (viewer/index.html
// #made-with). It is a plain user-clicked anchor (target=_blank, rel="noopener noreferrer"): it loads nothing and sends
// no Referer, so "the page loads nothing remote / leaks nothing" still holds. Every other http(s) URL stays forbidden.

export const CREDIT_URL = 'https://github.com/tgsoon2002/c4mp-releases';

/** Matches any http(s) URL except the credit link's exact href value (the closing quote is part of the exception). */
export const NO_URL_EXCEPT_CREDIT = /https?:\/\/(?!github\.com\/tgsoon2002\/c4mp-releases")/;

/** Texts the rule must still catch: another site, and the credit host with another path or a longer name. */
export const URL_RULE_MISSES = [
  '<a href="https://example.com">x</a>',
  `<a href="${CREDIT_URL}/releases">x</a>`,
  `<a href="${CREDIT_URL}-x">x</a>`,
  '<script src="http://cdn.example.org/a.js"></script>',
];
