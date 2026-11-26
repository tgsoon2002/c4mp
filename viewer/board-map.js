// board-map.js: the note on the map for a selected b-item and "Zoom to these c-items" (P16-B30c).
// No CSS twin (the note is styled inline), so index.html and style.css stay untouched.
(function () {
  'use strict';
  const B = window.C4PM_BOARD;
  const M = window.C4PM_MAP;
  if (!B || !M) return;   // no board: nothing to do

  const wrap = document.getElementById('map-wrap');
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  // Smallest node that holds every id: the deepest common ancestor (a single id is its own ancestor).
  function commonAncestor(ids) {
    const chains = ids.map(id => {
      const chain = [];
      for (let n = M.nodeById(id); n; n = n.parent) chain.unshift(n);
      return chain;
    }).filter(c => c.length);
    if (!chains.length) return null;
    let lca = null;
    for (let d = 0; chains.every(c => c[d] && c[d] === chains[0][d]); d++) lca = chains[0][d];
    return lca;
  }

  // Fit the region that holds the c-items of the selected b-item. Returns true when the camera was sent.
  B.zoomToLinked = function () {
    const id = B.selectedId();
    if (!id) return false;
    const ids = B.litNodeIds(id).filter(n => M.nodeById(n));
    const lca = ids.length ? commonAncestor(ids) : null;
    if (!lca) return false;
    M.flyTo(lca.id);
    return true;
  };

  if (!wrap || typeof wrap.appendChild !== 'function') return;
  const note = document.createElement('div');
  note.id = 'bd-note';
  note.hidden = true;
  note.style.cssText = 'position:absolute;left:12px;bottom:32px;max-width:calc(100% - 24px);padding:5px 10px;border-radius:8px;' +
    'background:var(--panel);border:1px solid #FFB020;color:var(--ink);font-size:12px;pointer-events:none';   // no display rule here: it would beat the hidden attribute
  const text = document.createElement('span');
  const zoom = document.createElement('button');
  zoom.type = 'button';
  zoom.className = 'bd-zoom';
  zoom.textContent = 'Zoom to these c-items';
  zoom.style.cssText = 'pointer-events:auto;margin-left:10px;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer';
  zoom.addEventListener('click', () => B.zoomToLinked());
  note.appendChild(text);
  note.appendChild(zoom);
  wrap.appendChild(note);

  function update() {
    const it = B.selectedId() && B.item(B.selectedId());
    if (!it) { note.hidden = true; return; }
    const info = M.highlightInfo();
    if (!info.lit) {
      // b130: links that exist only in the other view (arch c-items while the IO view is open, or the reverse) are not lit here
      const other = B.litNodeIds(it.id).length;
      text.textContent = it.id + ' · ' + it.title + ' — ' + (other ? other + ' linked in the other view' : 'no c-items linked');
      zoom.hidden = true;
    } else {
      text.textContent = it.id + ' · ' + it.title + ' — ' + plural(info.lit, 'c-item') + ' lit, ' + plural(info.arrows, 'arrow') + ' between them (Esc to clear)';
      zoom.hidden = false;
    }
    note.hidden = false;
  }
  B.onChange(update);
})();
