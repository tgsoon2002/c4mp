// b914: the Export section of the gear popup of a served page. One click: the server rewrites the repo's usual page
// file and answers JSON { file, name, noSource, html }; the browser downloads that html (C4PM_CONTROLS.downloadText).
// Does nothing without window.C4PM_LIVE (the static page of `c4mp view` shows no Export). Every text goes through
// textContent. Only the relative URL api/export is used (through C4PM_LIVE.request, which adds the token).
(function () {
  'use strict';
  const LIVE = window.C4PM_LIVE;
  if (!LIVE || typeof LIVE.request !== 'function') return;
  const pop = document.getElementById('settings-pop');
  if (!pop) return;

  const CHECK_TEXT = 'Leave source code out';
  const CHECK_NOTE = 'Board and plan text are kept as written.';   // K may change it: the one place
  const START_TEXT = 'Writes C4MP/<id>/c4mpView.html and downloads a copy that works offline.';

  let ui = null;

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // The Export row, after the note of the popup: label, checkbox, note, button, status line.
  function buildExport(host) {
    const row = el('div', 'set-row set-export');
    row.appendChild(el('div', 'set-l', 'Export'));
    const label = el('label', 'set-check');
    const box = el('input');
    box.type = 'checkbox'; box.id = 'export-nosource'; box.checked = false;
    label.appendChild(box);
    label.appendChild(el('span', '', CHECK_TEXT));
    row.appendChild(label);
    row.appendChild(el('div', 'set-status', CHECK_NOTE));
    const seg = el('span', 'seg');
    const btn = el('button', '', 'Export');
    btn.type = 'button'; btn.id = 'btn-export-page';
    seg.appendChild(btn);
    row.appendChild(seg);
    const line = el('div', 'set-status', START_TEXT);
    line.id = 'export-status';
    row.appendChild(line);
    host.appendChild(row);
    return { box, btn, line };
  }

  function exportPage() {
    if (ui.btn.disabled) return;
    ui.btn.disabled = true;
    ui.line.textContent = 'Exporting ...';
    LIVE.request('POST', 'api/export', { noSource: !!ui.box.checked }).then(onExportAnswer, onExportLost);
  }

  function onExportAnswer(ans) {
    ui.btn.disabled = false;
    const j = ans && ans.json;
    if (!ans || ans.status !== 200 || !j || typeof j.html !== 'string') {
      ui.line.textContent = ans && ans.status === 401
        ? 'Export failed: the key is from an earlier c4mp serve run. Open the link it printed.'
        : 'Export failed: ' + (j && j.message ? j.message : 'c4mp serve answered ' + (ans && ans.status));
      return;
    }
    try {
      window.C4PM_CONTROLS.downloadText(j.name, j.html, 'text/html');
    } catch (e) {
      ui.line.textContent = 'Wrote ' + j.file + '; the download failed: ' + (e && e.message ? e.message : e);
      return;
    }
    ui.line.textContent = 'Exported: wrote ' + j.file + ' and downloaded ' + j.name + (j.noSource ? ' (no source code)' : '') + '.'
      + (typeof LIVE.isDirty === 'function' && LIVE.isDirty() ? ' Unsaved edits on this page are not in it.' : '');
  }

  function onExportLost() {
    ui.btn.disabled = false;
    ui.line.textContent = 'Export failed: c4mp serve is not running.';
  }

  ui = buildExport(pop);
  ui.btn.addEventListener('click', exportPage);
})();
