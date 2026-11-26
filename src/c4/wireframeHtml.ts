/**
 * Phase 20 wireframes (W1, board b297): what c4pm knows about the bare HTML of a screen, in one place, without a DOM.
 *  - scanWireRefs: the `data-c4` values of a fragment (the server counts and resolves them; the viewer never does).
 *    scanWireRefSpans: the same refs with the raw value and its offsets (plan move rewrites refs in place).
 *  - the rule table the viewer applies before it lays a fragment out: WIREFRAME_CSS (H7), WIREFRAME_BASE_CSS (H10),
 *    WIREFRAME_KEEP_TAGS and WIREFRAME_KEEP_ATTRS (C7: allow-lists, not deny-lists). The server injects it as
 *    C4PM_DATA.wireframeRules (wireframeRules()); the guide lists exactly WIREFRAME_CSS.
 * Spec: Document/Roadmap/PHASE_20_WIREFRAMES.md sections 0 (C2, C7) and 3.
 */
import type { WireframeRules } from '../types';   // the table the viewer receives (ViewModel.wireframeRules); defined in types.ts (W6, T1)

/**
 * H7: the layout properties a wireframe may use. An entry ending in `*` is a prefix (`grid*` keeps `grid-area`,
 * `inset*` keeps `inset-inline`); any other entry is the whole property name. Everything else (color, background, font,
 * border, transform, animation, `--custom` properties, vendor prefixes) is removed before layout. `calc()` values are fine.
 */
export const WIREFRAME_CSS: readonly string[] = [
  'display', 'flex*', 'align-*', 'justify-*', 'place-*', 'order', 'gap', 'row-gap', 'column-gap', 'grid*',
  'width', 'height', 'min-*', 'max-*', 'padding*', 'margin*', 'position', 'top', 'right', 'bottom', 'left', 'inset*',
  'box-sizing', 'aspect-ratio', 'z-index',
];

/** True when the CSS property `name` is in WIREFRAME_CSS (names are case-insensitive). The viewer applies the same rule. */
export function wireframeCssAllows(name: string): boolean {
  const n = name.trim().toLowerCase();
  return WIREFRAME_CSS.some(e => (e.endsWith('*') ? n.startsWith(e.slice(0, -1)) : n === e));
}

/** H10: applied before the file's own style, so a file lays out the same in every browser and theme (the mock's BASE, verbatim). */
export const WIREFRAME_BASE_CSS =
  '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;border:0;font:12px/1.25 sans-serif;appearance:none;min-width:0}';

/**
 * C7: the tags that stay (structural and form tags). Every other tag is dropped with its subtree. `style` is not in the
 * list: style blocks are read as sheets, cleaned to WIREFRAME_CSS, and never kept as nodes.
 */
export const WIREFRAME_KEEP_TAGS: readonly string[] = [
  'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'address', 'blockquote', 'pre', 'hr', 'br',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'figure', 'figcaption', 'details', 'summary', 'a', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'code', 'sub', 'sup', 'mark',
  'button', 'input', 'select', 'option', 'optgroup', 'textarea', 'label', 'fieldset', 'legend', 'output', 'progress', 'meter',
];

/** C7: a tag that is replaced by another and keeps its children (`form` becomes a `div`). Not part of WIREFRAME_KEEP_TAGS. */
export const WIREFRAME_TAG_ALIASES: Readonly<Record<string, string>> = { form: 'div' };

/** C7: the attributes that stay. Every other attribute (on*, src, srcset, href, ...) is removed. */
export const WIREFRAME_KEEP_ATTRS: readonly string[] = ['class', 'id', 'style', 'data-c4', 'hidden'];

/** The rule table as the viewer receives it (C4PM_DATA.wireframeRules). */
export function wireframeRules(): WireframeRules {
  return {
    css: [...WIREFRAME_CSS],
    base: WIREFRAME_BASE_CSS,
    keepTags: [...WIREFRAME_KEEP_TAGS],
    keepAttrs: [...WIREFRAME_KEEP_ATTRS],
  };
}

// ---- scanWireRefs ----

/** Elements whose content is text, not markup, for the HTML parser: a `data-c4` in there is no element. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode character references in an attribute value: numeric (`&#46;`, `&#x2e;`) and the few named ones; others stay as written. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (all, dec, hex, name) => {
    if (name !== undefined) return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : all;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);

/** One `data-c4` value: `ref` decoded, `raw` as written; `html.slice(start, end) === raw` (quotes excluded; no value = empty span after the name). */
export interface WireRefSpan { ref: string; raw: string; start: number; end: number }

/** The `data-c4` values of an HTML fragment, in document order (the refs of scanWireRefSpans). */
export function scanWireRefs(html: string): string[] {
  return scanWireRefSpans(html).map(s => s.ref);
}

/**
 * The `data-c4` values of an HTML fragment, in document order, one entry per element (a ref on two elements appears twice;
 * `new Set(...)` gives the distinct refs). Values are entity-decoded and not trimmed. An attribute with no value gives ''.
 * Reads like an HTML parser, without building a DOM: skips comments (also `<!-->`, `<!--->`, bogus `<!...>` / `<?...>`),
 * the content of script / style / textarea (and the other raw-text elements) and of `<template>` (nested too), and
 * understands double-quoted, single-quoted and unquoted values. When an attribute repeats, the first one wins. A tag that
 * is cut off by the end of the text is dropped.
 */
export function scanWireRefSpans(html: string): WireRefSpan[] {
  const refs: WireRefSpan[] = [];
  const n = html.length;
  let i = 0;
  let templateDepth = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const next = html[lt + 1];

    if (html.startsWith('<!--', lt)) {
      // `<!-->` and `<!--->` are complete empty comments; otherwise the comment ends at the first `-->` after the opener
      if (html.startsWith('<!-->', lt)) { i = lt + 5; continue; }
      if (html.startsWith('<!--->', lt)) { i = lt + 6; continue; }
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (next === '!' || next === '?' || (next === '/' && !isLetter(html[lt + 2]))) {
      // doctype, processing instruction or bogus comment: ends at the first '>'
      const end = html.indexOf('>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (next === '/') {
      const end = html.indexOf('>', lt + 2);
      if (end < 0) break;
      if (html.slice(lt + 2, end).split(/[\s/]/)[0].toLowerCase() === 'template' && templateDepth > 0) templateDepth--;
      i = end + 1;
      continue;
    }
    if (!isLetter(next)) { i = lt + 1; continue; }   // a lone '<' is text

    // start tag
    let j = lt + 1;
    while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
    const tag = html.slice(lt + 1, j).toLowerCase();
    let ref: WireRefSpan | undefined;
    let closed = false;
    while (j < n) {
      while (j < n && (isSpace(html[j]) || html[j] === '/')) j++;
      if (j >= n) break;
      if (html[j] === '>') { closed = true; j++; break; }
      const nameStart = j;
      j++;   // the first character belongs to the name even when it is '='
      while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
      const name = html.slice(nameStart, j).toLowerCase();
      let k = j;
      while (k < n && isSpace(html[k])) k++;
      let vs = j;   // the value's span; no value = the empty span right after the name
      let ve = j;
      if (html[k] === '=') {
        k++;
        while (k < n && isSpace(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, k + 1);
          if (end < 0) { j = n; break; }   // unclosed quote swallows the rest: the tag is cut off
          vs = k + 1;
          ve = end;
          j = end + 1;
        } else {
          vs = k;
          while (k < n && !isSpace(html[k]) && html[k] !== '>') k++;
          ve = k;
          j = k;
        }
      }
      if (name === 'data-c4' && ref === undefined) {
        const raw = html.slice(vs, ve);
        ref = { ref: decodeEntities(raw), raw, start: vs, end: ve };
      }
    }
    if (!closed) break;   // cut off by the end of the text: dropped
    i = j;

    if (tag === 'template') { templateDepth++; continue; }
    if (templateDepth === 0 && ref !== undefined) refs.push(ref);
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = new RegExp('</' + tag + '(?=[\\s/>])', 'ig');
      close.lastIndex = i;
      const m = close.exec(html);
      if (!m) break;
      i = m.index;   // the end tag itself is read by the loop
    } else if (tag === 'plaintext') {
      break;
    }
  }
  return refs;
}
