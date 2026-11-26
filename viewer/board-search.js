// board-search.js: the left search box also finds board items (P16-B34). SRCH-1 (b235): this file is the 'board' search
// provider of panel.js (C4PM_SEARCH.registerSearchProvider): Names = id, title, owner, tags; Content = description and outcome.
// The panel shows the rows after its own, says "No results", wires the pick and handles Enter and Escape.
// Map-node results keep their cap of 20; board rows are extra (at most 10 per mode). Text only: titles and owners are never markup.
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  if (!B || !window.C4PM_MAP) return;   // no board: nothing to do
  if (!window.C4PM_SEARCH) return;      // the page has no search box (panel.js set up no search)

  const MAX_ROWS = 10;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const has = (s, q) => typeof s === 'string' && s.toLowerCase().indexOf(q) >= 0;

  // What an item is called (Names) and what it says (Content).
  const named = (it, q) => has(it.id, q) || has(it.title, q) || has(it.owner, q) || (it.tags || []).some(t => has(t, q));
  const said = (it, q) => has(it.description, q) || has(it.outcome, q);

  // Items of the boards the drawer can show (archived boards are hidden there, so an item of one could not be selected).
  function matches(q, test) {
    const out = [];
    B.boards().forEach(entry => {
      (entry.items || []).forEach(it => {
        if (out.length >= MAX_ROWS) return;
        if (test(it, q)) out.push({ it, entry });
      });
    });
    return out;
  }

  function row(r) {
    const b = el('button', 'bd-search-result');
    b.type = 'button';
    b.style.display = 'block';
    b.style.width = '100%';
    b.style.padding = '8px 12px';
    b.style.border = 'none';
    b.style.background = 'none';
    b.style.textAlign = 'left';
    b.style.cursor = 'pointer';
    b.style.borderBottom = '1px solid var(--line)';
    b.style.fontSize = '13px';
    const top = el('div');
    top.style.fontWeight = '500';
    const kind = r.it.kind || '?';
    const chip = el('span', 'bd-kind' + (/^[a-z-]+$/.test(kind) ? ' bk-' + kind : ''), kind.charAt(0).toUpperCase());
    chip.style.display = 'inline-block';
    top.appendChild(chip);
    top.appendChild(el('span', 'bd-id', ' ' + r.it.id + ' '));   // the class carries the style; the spaces keep the pieces apart when read as text
    top.appendChild(el('span', 'bd-t', r.it.title));
    const sub = el('div', 'bd-st', r.it.status + ' · ' + r.entry.name);
    sub.style.fontSize = '12px';
    sub.style.color = 'var(--muted)';
    sub.style.marginTop = '2px';
    b.appendChild(top);
    b.appendChild(sub);
    return { el: b, pick: () => { B.open(); B.select(r.it.id); } };   // the panel clears the box and the results after the pick
  }

  // Rows: a label heading the item rows; none when nothing matches.
  function rows(q, test) {
    const found = matches(q, test);
    if (!found.length) return [];
    const label = el('div', 'bd-search-label', 'Board items');
    label.style.padding = '6px 12px 2px';
    label.style.fontSize = '11px';
    label.style.color = 'var(--muted)';
    label.style.textTransform = 'uppercase';
    return [{ el: label }].concat(found.map(row));
  }

  window.C4PM_SEARCH.registerSearchProvider({
    id: 'board',
    names: q => rows(q, named),
    content: q => rows(q, said),
  });
})();
