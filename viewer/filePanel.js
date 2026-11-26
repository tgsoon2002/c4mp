// filePanel.js: the file panel (showFile, opened from the Files tab, search and folder rows) and its owner rows; owns fileViewPath.
// LAY-12c (b389): split out of panel.js; registers P.file on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const { plural, getOwnerNode, root, parents, findViewFile, collectFileNodes, collectFileFindings, findNodeById } = P.vm;
  const { highlightC4Line, renderCodeBlock, section, goTo, renderFindingsList } = P.kit;

  // ===== P13-T8a: file panel (opened from the Files tab via window.C4PM_PANEL.showFile) =====
  // Data used (src/types.ts): ViewModel.files[] = ViewFile{path, kind, owners (ViewNode ids), flag?};
  // function/method ViewNodes carry file, line, endLine (P13-T2c); findings live on ViewNode.findings
  // (ViewFinding has no file field, so a finding belongs to a file when its NODE's `file` equals the path).
  let fileViewPath = null;   // path whose file view is showing; cleared by any other selection

  function ownerButton(id, name) {
    const btn = document.createElement('button');
    btn.className = 'pn-crumb';
    btn.textContent = name;
    btn.onclick = (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      console.debug(PANEL_TAG, 'owner click', { id });
      goTo(id);
    };
    return btn;
  }

  // "owned by X" / "split between A and B" / "split between A, B and C" / "no owner"; names are buttons.
  function renderFileOwners(owners) {
    const el = document.createElement('div');
    el.className = 'pn-detail';
    const named = owners.map(id => {
      const n = findNodeById(root(), id);
      return { id: id, name: n ? n.name : id };
    });
    if (!named.length) {
      el.textContent = 'no owner';
      return el;
    }
    el.appendChild(document.createTextNode(named.length === 1 ? 'owned by ' : 'split between '));
    named.forEach((o, i) => {
      if (i > 0) el.appendChild(document.createTextNode(i === named.length - 1 ? ' and ' : ', '));
      el.appendChild(ownerButton(o.id, o.name));
    });
    return el;
  }

  function renderFileFunctions(fns) {
    const sec = section('Functions in this file', String(fns.length));
    const list = document.createElement('div');
    list.className = 'pn-children';
    fns.forEach(fn => {
      const row = document.createElement('div');
      row.className = 'pn-child-row';
      row.style.cursor = 'pointer';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'pn-child-name';
      nameDiv.appendChild(document.createTextNode(fn.name + '()'));
      if (fn.line) {
        const small = document.createElement('small');
        small.textContent = fn.endLine && fn.endLine !== fn.line ? 'L' + fn.line + '–L' + fn.endLine : 'L' + fn.line;
        nameDiv.appendChild(small);
      }
      row.appendChild(nameDiv);
      const owner = getOwnerNode(fn, parents());
      if (owner) row.appendChild(ownerButton(owner.id, owner.name));
      else {
        const none = document.createElement('div');
        none.className = 'pn-child-weight';
        none.textContent = 'Unassigned';
        row.appendChild(none);
      }
      row.onclick = () => { console.debug(PANEL_TAG, 'function click', { id: fn.id }); goTo(fn.id); };
      list.appendChild(row);
    });
    sec.appendChild(list);
    return sec;
  }

  function showFile(path) {
    const panel = document.getElementById('panel');
    console.debug(PANEL_TAG, 'showFile', { path });
    if (!panel) { console.warn(PANEL_TAG, 'showFile: no #panel element'); return; }
    const vf = findViewFile(path);
    panel.innerHTML = '';
    fileViewPath = path;   // so the slice select that follows (tree.js flyTo+select) does not overwrite this view

    const crumb = document.createElement('div');
    crumb.className = 'pn-breadcrumb';
    crumb.textContent = !vf ? 'source file' : vf.kind === 'plan' ? 'plan file' : 'source file';
    panel.appendChild(crumb);

    const header = document.createElement('div');
    header.className = 'pn-header';
    const h2 = document.createElement('h2');
    h2.classList.add('pn-mono');
    h2.appendChild(document.createTextNode(path));
    header.appendChild(h2);
    panel.appendChild(header);

    if (!vf) {
      console.warn(PANEL_TAG, 'showFile: path not in data.files', { path });
      const msg = document.createElement('div');
      msg.className = 'pn-detail';
      msg.textContent = 'This file is not in the scan.';
      panel.appendChild(msg);
      return;
    }
    if (vf.kind === 'plan') {
      const note = document.createElement('div');
      note.className = 'pn-detail';
      note.textContent = 'The architecture lives here, not inside the code folders.';
      panel.appendChild(note);
      if (!Array.isArray(vf.lines)) {
        console.debug(PANEL_TAG, 'showFile: plan file without embedded text', { path });
        const none = document.createElement('div');
        none.className = 'pn-detail';
        none.textContent = 'The text of this file was not embedded in the view.';
        panel.appendChild(none);
        return;
      }
      console.debug(PANEL_TAG, 'showFile: plan file body', { path, lines: vf.lines.length, truncated: vf.truncated || 0 });
      const sec = section('Plan file', vf.lines.length + (vf.truncated ? ' of ' + (vf.lines.length + vf.truncated) : '') + ' ' + plural(vf.truncated ? vf.lines.length + vf.truncated : vf.lines.length, 'line'));
      sec.appendChild(renderCodeBlock(vf.lines, 1, highlightC4Line));
      if (vf.truncated > 0) {
        const more = document.createElement('div');
        more.className = 'pn-detail pn-mono';
        more.textContent = '… ' + vf.truncated + ' more ' + plural(vf.truncated, 'line');
        sec.appendChild(more);
      }
      panel.appendChild(sec);
      return;
    }

    panel.appendChild(renderFileOwners(vf.owners || []));
    if (vf.fileOnly) {
      // P14-T30: a file listed without a parser has no functions or imports to show
      console.debug(PANEL_TAG, 'file-only note', { path });
      const fo = document.createElement('div');
      fo.className = 'pn-detail';
      fo.textContent = 'File-only: functions and imports are not read for this language (no parser yet).';
      panel.appendChild(fo);
    }

    const nodes = collectFileNodes(root(), path);
    const fns = nodes.filter(n => n.kind === 'function' || n.kind === 'method')
      .sort((a, b) => (a.line || 0) - (b.line || 0));
    const findings = collectFileFindings(nodes);
    console.debug(PANEL_TAG, 'showFile: collected', {
      path, flag: vf.flag, owners: vf.owners, nodes: nodes.length, functions: fns.length, findings: findings.length,
    });

    if (fns.length) panel.appendChild(renderFileFunctions(fns));
    const fl = renderFindingsList(findings);
    if (fl) {
      panel.appendChild(section('Findings', String(findings.length)));
      panel.appendChild(fl);
    }
  }

  P.file = { ownerButton, showFile, viewPath: () => fileViewPath, leave: () => { fileViewPath = null; } };
})();
