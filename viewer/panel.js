/* panel.js: Detail panel for the C4PM viewer: the per-kind panel (updatePanel), the select handler and the setup.
 *
 * LAY-12c (b389): the shared parts load before this file and register on window.C4PM_PANEL_PARTS (viewModel, panelKit,
 * filePanel, ioPanel, storagePanel, testsPanel, summary, search, legend; order in PANEL_SCRIPTS, src/page/html.ts).
 *
 * Per-kind panel rendering ported from Document/v0.3-viewer-mock.html's renderPanel(), adapted
 * to the REAL ViewNode/ViewModel shapes (src/types.ts), not the mock's fake-data shapes:
 *   - claims:  Pick<Claim,'kind'|'path'|'fn'>[] -- component nodes only, claim-mode. Rendered
 *     plainly (kind/path/fn). The mock's per-claim won/lost styling needs OwnershipConflict data
 *     (winner/losers/reason) that is NOT surfaced on ViewNode or ViewModel as of this phase (P7-T6)
 *     -- see src/types.ts's Ownership/OwnershipConflict, which src/view/model.ts never attaches to
 *     a node. So "lost to X" can't be shown honestly; only the claim list itself is real.
 *   - source:  the .c4 file path a claim-mode component was declared in.
 *   - history: component nodes only, claim-mode -- git log entries from source.ts (P7-T3/T4).
 *   - code:    function/method nodes only -- real source lines from source.ts (P7-T3/T4).
 *   - callsAvailable: always false this phase (Decision §0.1) -- rendered as a plain, honest
 *     current-limitation note, not the mock's fake chips / "idea only" mockup styling.
 *   - node.meta (status/owner/sprint/priority): populated in claim mode (components from
 *     Component.meta, containers/systems from plan metadata); absent in folder mode.
 *     Rendered defensively (only if present), never invented.
 */
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const data = window.C4PM_DATA;
  const map = window.C4PM_MAP;
  const { esc, plural, getOwnerNode, getOwnerLabel, findElementsInFile, root, ownRenderer, parents, syncParents, kidsOf,
    collectDeps, entryKind, partWord, isStorageNode, claimMatchesFn, findMatchingClaim, findNodeById } = P.vm;
  const { highlightC4Line, renderCodeBlock, section, renderBreadcrumb, goTo, renderUidRow, hasNoCode, renderMetaPills,
    renderFindingsList, renderChildrenList, renderVscodeLink, KIND_NOTE, sharedListOpts, unassignedListOpts } = P.kit;
  const { ownerButton, showFile } = P.file;
  const { renderIoNode } = P.io;
  const { renderStorageNode } = P.storage;
  const { renderTestsSection, renderTraceBack } = P.tests;
  const { renderSummary } = P.summary;

  function renderHeader(node, extraBadge) {
    const header = document.createElement('div');
    header.className = 'pn-header';
    const h2 = document.createElement('h2');
    if (node.kind === 'function' || node.kind === 'method' || node.kind === 'slice') {
      h2.classList.add('pn-mono');
    }
    const nameText = (node.kind === 'function' || node.kind === 'method') ? node.name + '()' : node.name;
    h2.appendChild(document.createTextNode(nameText));
    const kindSpan = document.createElement('span');
    kindSpan.className = 'pn-kind';
    kindSpan.textContent = partWord(node) || entryKind(node);
    h2.appendChild(kindSpan);
    if (extraBadge) h2.appendChild(extraBadge);
    header.appendChild(h2);
    if (node.detail) {
      const detailDiv = document.createElement('div');
      detailDiv.className = 'pn-detail';
      detailDiv.textContent = node.detail;
      header.appendChild(detailDiv);
    }
    // P14-T44b: plan-only node (ViewNode.planOnly from T44a), not the L4 `planned` field.
    // C1 A2 (b829): only for a kind that needs code (C4PM_MODE.needsCode, from KIND_TABLE): never on a person or an external.
    if (node.planOnly && (!window.C4PM_MODE || window.C4PM_MODE.needsCode(node.kind))) {
      const planned = document.createElement('div');
      planned.className = 'pn-planned';
      planned.textContent = 'planned (no code yet)';
      header.appendChild(planned);
    }
    // P20-T5-E (b259): in the IO view the uid row (with its plan remove command) is the screen's own, see renderIoNode;
    // STOR-6b: the same for any view with its own renderer (a storage node has its id row, see renderStorageNode)
    if (['system', 'container', 'subregion', 'component'].includes(node.kind) && !ownRenderer()) {
      header.appendChild(renderUidRow(node));
    }
    return header;
  }

  function renderWeightBar(node) {
    // P14-T44b / P14-L4-10: a node with no code has only a placeholder weight, not a size
    if (hasNoCode(node)) return null;
    const parentNode = parents()[node.id];
    // C1-CTX: a 'context' root is a frame (the system beside its actors), not code: no "% of parent" against it
    if (!parentNode || parentNode.kind === 'context' || !parentNode.weight || !node.weight) return null;
    // T12c: an empty container/component has only the placeholder weight 1 -- a "1 line / 8% of parent" bar is meaningless
    if (!kidsOf(node).length) {
      if (node.kind === 'container' || node.kind === 'subregion' || node.kind === 'component' || node.kind === 'system') {
        console.debug(PANEL_TAG, 'weight bar hidden: no code', { id: node.id, kind: node.kind });
        return null;
      }
    }
    const barSection = document.createElement('div');
    barSection.className = 'pn-bar-section';
    const barLabel = document.createElement('div');
    barLabel.className = 'pn-bar-label';
    barLabel.innerHTML = `<span>${esc(node.weight)} ${plural(node.weight, 'line')}</span><span>${Math.round(node.weight / parentNode.weight * 100)}% of parent</span>`;
    barSection.appendChild(barLabel);
    const barContainer = document.createElement('div');
    barContainer.className = 'pn-bar-container';
    const barFill = document.createElement('div');
    barFill.className = 'pn-bar-fill';
    barFill.style.width = (node.weight / parentNode.weight * 100) + '%';
    barContainer.appendChild(barFill);
    barSection.appendChild(barContainer);
    return barSection;
  }

  // P14-T14: "Where from" -- ViewNode.origin {kind, folder, manifest, planFile, planLine, planEndLine, rule}.
  // Plus the reason an empty container/component is empty. Nothing is invented: only fields present are printed.
  const ORIGIN_KINDS = ['system', 'container', 'subregion', 'component', 'shared', 'unassigned'];
  function renderOrigin(node) {
    const o = node.origin;
    if (!o || ORIGIN_KINDS.indexOf(node.kind) < 0) return null;
    const sec = section('Where from');
    const line = (t) => {
      const d = document.createElement('div');
      d.className = 'pn-detail';
      d.textContent = t;
      sec.appendChild(d);
    };
    const folder = o.folder === '.' ? 'the repo root' : o.folder;
    const hasScan = o.kind === 'scanned' || o.kind === 'both';
    const hasPlan = o.kind === 'plan' || o.kind === 'both';
    if (hasScan) {
      line('Found by scanning the code.' + (folder ? ' Folder: ' + folder : '') + (o.manifest ? '. Manifest: ' + o.manifest : ''));
    }
    if (hasPlan && o.planFile) {
      const end = o.planEndLine && o.planEndLine !== o.planLine ? '-' + o.planEndLine : '';
      line('Declared in the plan: ' + o.planFile + (o.planLine ? ':' + o.planLine + end : ''));
    }
    if (o.kind === 'synthetic') {
      line('Made by C4PM automatically (not in any .c4 file).' + (o.rule ? ' Rule: ' + o.rule : ''));
    } else if (o.rule) {
      line('Note: ' + o.rule);
    }
    const empty = !kidsOf(node).length;
    if (empty && (node.kind === 'container' || node.kind === 'subregion' || node.kind === 'component')) {
      if (hasScan) line('Empty: no source files were parsed in ' + (folder || 'its folder') + '.');
      else if (o.kind === 'plan') line('Empty: nothing in the plan links to code yet.');
    }
    console.debug(PANEL_TAG, 'origin', { id: node.id, kind: o.kind, empty });
    return sec;
  }

  // P14-T15: shared/unassigned node -- files of the contents grouped by folder (node.origins), each file opens
  // its file panel. A folder row flies to the container whose origin.folder is the longest prefix of it (none -> logged, no-op).
  function containerForFolder(folder) {
    let best = null;
    (function walk(n) {
      const f = n.origin && n.origin.folder;
      if ((n.kind === 'container') && typeof f === 'string' && f !== '.' && (folder === f || folder.indexOf(f + '/') === 0)) {
        if (!best || f.length > best.origin.folder.length) best = n;
      }
      (n.children || []).forEach(walk);
    })(root());
    return best;
  }
  function renderOrigins(node) {
    const groups = Array.isArray(node.origins) ? node.origins : [];
    if (!groups.length) return null;
    const empty = new Set(Array.isArray(node.emptyFiles) ? node.emptyFiles : []);
    const total = groups.reduce((a, g) => a + g.files.length, 0);
    const sec = section('Files by folder', total + ' ' + plural(total, 'file'));
    groups.forEach(g => {
      const row = document.createElement('button');
      row.className = 'pn-child-row pn-folder-row';
      row.textContent = g.folder + ' (' + g.files.length + ')';
      row.onclick = () => {
        const c = containerForFolder(g.folder);
        if (!c) { console.debug(PANEL_TAG, 'folder row: no container owns it', { folder: g.folder }); return; }
        console.debug(PANEL_TAG, 'folder row -> container', { folder: g.folder, id: c.id });
        goTo(c.id);
      };
      sec.appendChild(row);
      g.files.forEach(f => {
        const b = document.createElement('button');
        b.className = 'pn-file-link';
        b.title = f;
        b.textContent = f + (empty.has(f) ? ' (no functions)' : '');
        b.onclick = () => { console.debug(PANEL_TAG, 'file link click', { path: f }); showFile(f); };
        sec.appendChild(b);
      });
    });
    console.debug(PANEL_TAG, 'origins', { id: node.id, folders: groups.length, files: total });
    return sec;
  }

  // Claims list -- plain kind/path/fn, no won/lost: OwnershipConflict data isn't surfaced on
  // ViewNode/ViewModel as of this phase, so that status can't be shown honestly (see file header).
  function renderClaims(node) {
    if (!node.claims || !node.claims.length) return null;
    const sec = section('Claims', node.source);
    const claims = document.createElement('div');
    claims.className = 'pn-claims';
    node.claims.forEach(cl => {
      const row = document.createElement('div');
      row.className = 'pn-claim';
      const kindSpan = document.createElement('span');
      kindSpan.className = 'pn-claim-kind';
      kindSpan.textContent = cl.kind;
      row.appendChild(kindSpan);
      const pathSpan = document.createElement('span');
      pathSpan.className = 'pn-claim-path';
      const label = cl.kind === 'function' ? `${cl.path}#${cl.fn}` : cl.path;
      pathSpan.textContent = label;
      pathSpan.title = label;
      row.appendChild(pathSpan);
      // T12b: "N fn" from ownedCount (T2c); absent = not computed, show nothing
      if (typeof cl.ownedCount === 'number') {
        const metaLine = document.createElement('div');
        metaLine.className = 'pn-claim-meta';
        let txt = `${cl.ownedCount} fn`;
        if (cl.ownedCount === 0) {
          // lostClaims[] = {path (file), fn, lostTo (winner elementId)}: attribute to this claim only when it owns nothing
          // (a claim that owns functions cannot be told apart from a more specific sibling claim by the data alone).
          const winners = [];
          (node.lostClaims || []).forEach(lc => {
            if (lc.fn ? !claimMatchesFn(cl, lc.path, lc.fn) : !(cl.kind === 'file' ? cl.path === lc.path : cl.kind === 'folder' && String(lc.path).startsWith(cl.path))) return;
            const w = findNodeById(root(), lc.lostTo);
            const label = w ? w.name : lc.lostTo;
            if (!winners.includes(label)) winners.push(label);
          });
          if (winners.length) {
            txt += ` · lost to ${winners.join(', ')}`;
            row.classList.add('pn-claim-lost');
          }
          console.debug(PANEL_TAG, 'claim 0 fn', { path: cl.path, fn: cl.fn, winners });
        }
        metaLine.textContent = txt;
        row.appendChild(metaLine);
      }
      claims.appendChild(row);
    });
    sec.appendChild(claims);
    return sec;
  }

  // P13-T7: "The plan" -- the node's own text from its .c4 file (ViewNode.planBlock {file,startLine,endLine,lines},
  // set by src/view/model.ts attachPlanBlocks: claim mode only, absent when no/ambiguous plan element).
  // `extend <fqn> { ... }` is real syntax (src/plan/parser.ts 'extend' + fqn; src/c4/generate.ts writes
  // `extend <system>.<container> {`), so the empty-container hint uses that spelling.
  // P14-L4-5b: "Plan" block for a node with ViewNode.planned (a function/class/method/type element of the plan).
  // Shown on real and ghost nodes; the real code view, when there is one, stays below it.
  function renderPlannedBlock(node) {
    const pl = node.planned;
    if (!pl) return null;
    console.debug(PANEL_TAG, 'renderPlannedBlock', { id: node.id, status: pl.status, builtState: node.builtState });
    const sec = section('Plan');
    const chip = document.createElement('div');
    chip.className = 'pn-badge pn-status pn-status-' + String(pl.status).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    chip.textContent = pl.status;
    sec.appendChild(chip);
    if (pl.signature) {
      const sig = document.createElement('code');
      sig.textContent = pl.signature;
      sig.title = pl.signature;
      sec.appendChild(sig);
    }
    if (pl.purpose) {
      const purpose = document.createElement('div');
      purpose.className = 'pn-detail';
      purpose.textContent = pl.purpose;
      sec.appendChild(purpose);
    }
    if (pl.source && pl.source.file) {
      const line = pl.source.line || 1;
      const src = document.createElement(data.repoPath ? 'a' : 'span');   // b914: no absolute path (source-less page) -> plain text, no link
      src.className = 'pn-vscode-link';
      if (data.repoPath) src.href = 'vscode://file/' + encodeURI(data.repoPath + '/' + pl.source.file) + ':' + line;
      src.textContent = pl.source.file + ':' + line;
      sec.appendChild(src);
    }
    return sec;
  }

  function renderPlanBlock(node) {
    const pb = node.planBlock;
    if (!pb || !Array.isArray(pb.lines) || !pb.lines.length) {
      console.debug(PANEL_TAG, 'renderPlanBlock: omitted', { id: node.id, hasPlanBlock: !!pb });
      return null;
    }
    const start = pb.startLine || 1;
    const end = pb.endLine || (start + pb.lines.length - 1);
    console.debug(PANEL_TAG, 'renderPlanBlock', { id: node.id, kind: node.kind, file: pb.file, start, end, lines: pb.lines.length });
    const sec = section('The plan', pb.file);
    const range = document.createElement('div');
    range.className = 'pn-detail';
    range.textContent = `L${start}–L${end}`;
    sec.appendChild(range);
    sec.appendChild(renderCodeBlock(pb.lines, start, highlightC4Line));
    const empty = !node.children || !node.children.length;
    if (empty && (node.kind === 'system' || node.kind === 'container')) {
      const fqn = node.kind === 'container' ? '<system-id>.<container-id>' : '<system-id>';
      console.debug(PANEL_TAG, 'renderPlanBlock: empty-container hint', { id: node.id });
      const hint = document.createElement('div');
      hint.className = 'pn-detail pn-plan-hint';
      hint.textContent = `No code mapped yet. Add an \`extend ${fqn} { … }\` block with components that link to code.`;
      sec.appendChild(hint);
    }
    return sec;
  }

  function renderDepsSection(node, dir) {
    if (node.kind !== 'component' && node.kind !== 'container' && node.kind !== 'subregion' && node.kind !== 'system') return null;
    const items = collectDeps(node, dir);
    console.debug(PANEL_TAG, 'renderDepsSection', { id: node.id, kind: node.kind, dir, chips: items.map(i => [i.node.id, i.weight]) });
    const sec = section(dir === 'out' ? 'Depends on' : 'Used by');
    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'pn-note';
      none.textContent = 'none';
      sec.appendChild(none);
      return sec;
    }
    const row = document.createElement('div');
    row.className = 'pn-deps';
    items.forEach(it => {
      const btn = document.createElement('button');
      btn.className = 'pn-dep-chip';
      btn.title = it.node.id;
      const name = document.createElement('span');
      name.textContent = it.node.name;
      btn.appendChild(name);
      const cnt = document.createElement('span');
      cnt.className = 'pn-dep-count';
      cnt.textContent = '×' + it.weight;
      btn.appendChild(cnt);
      btn.onclick = () => { console.debug(PANEL_TAG, 'dep chip click', { id: it.node.id }); goTo(it.node.id); };
      row.appendChild(btn);
    });
    sec.appendChild(row);
    return sec;
  }

  // P13-T6c (Decision 6): "Declared relations" from data.relations (ViewRelation {from,to,label,file,line},
  // src/types.ts; present only when a plan was given). Rows are this node's own (from === node.id), file order.
  // Row: "-> <target name button> -- <label>" (label omitted when null). None -> section omitted.
  function renderRelationsSection(node) {
    if (node.kind !== 'component' && node.kind !== 'container' && node.kind !== 'subregion') return null;
    const rels = Array.isArray(data.relations) ? data.relations.filter(r => r && r.from === node.id) : [];
    console.debug(PANEL_TAG, 'renderRelationsSection', { id: node.id, kind: node.kind, total: Array.isArray(data.relations) ? data.relations.length : null, mine: rels.length });
    const rows = [];
    rels.forEach(r => {
      const target = findNodeById(root(), r.to);
      if (!target) { console.debug(PANEL_TAG, 'relation target not in tree, row skipped', { from: r.from, to: r.to }); return; }
      rows.push({ r, target });
    });
    if (!rows.length) return null;
    const sec = section('Declared relations');
    const list = document.createElement('div');
    list.className = 'pn-rels';
    rows.forEach(({ r, target }) => {
      const row = document.createElement('div');
      row.className = 'pn-rel';
      row.appendChild(document.createTextNode('→ '));
      const btn = document.createElement('button');
      btn.className = 'pn-rel-target';
      btn.title = target.id;
      btn.textContent = target.name;
      btn.onclick = () => { console.debug(PANEL_TAG, 'relation target click', { id: target.id }); goTo(target.id); };
      row.appendChild(btn);
      if (r.label) {
        const lab = document.createElement('span');
        lab.className = 'pn-rel-label';
        lab.textContent = ' — ' + r.label;
        row.appendChild(lab);
      }
      list.appendChild(row);
    });
    sec.appendChild(list);
    return sec;
  }

  function renderHistory(node) {
    if (!node.history || !node.history.length) return null;
    const sec = section('History', node.source ? 'git log -- ' + node.source.split('/').pop() : null);
    const list = document.createElement('div');
    list.className = 'pn-history';
    node.history.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'pn-history-entry';
      const hash = document.createElement('span');
      hash.className = 'pn-history-hash';
      hash.textContent = (entry.commit || '').slice(0, 7);
      row.appendChild(hash);
      const dateSpan = document.createElement('span');
      dateSpan.className = 'pn-history-date';
      dateSpan.textContent = entry.date;
      row.appendChild(dateSpan);
      const msg = document.createElement('span');
      msg.className = 'pn-history-message';
      msg.textContent = entry.message;
      msg.title = entry.message;
      row.appendChild(msg);
      list.appendChild(row);
    });
    sec.appendChild(list);
    return sec;
  }

  // Calls/Called by -- callsAvailable is always false this phase (Decision §0.1, real final
  // value, not a stub). Render a plain, honest current-limitation note.
  function renderCallsSection(node) {
    const sec = section('Calls / Called by');
    const note = document.createElement('div');
    note.className = 'pn-note';
    note.textContent = "Function-level call tracking isn't built yet, so this panel can't show what this function calls or what calls it.";
    sec.appendChild(note);
    return sec;
  }

  // P14-T30: file and slice nodes under node (any depth) and how many are file-only (no parser).
  function countFileOnly(node) {
    const out = { files: 0, fileOnly: 0 };
    (node.children || []).forEach(child => {
      if (child.kind === 'file' || child.kind === 'slice') {
        out.files++;
        if (child.fileOnly) out.fileOnly++;
      }
      const sub = countFileOnly(child);
      out.files += sub.files;
      out.fileOnly += sub.fileOnly;
    });
    return out;
  }

  // ===== Update panel on selection =====
  function updatePanel(node) {
    const panel = document.getElementById('panel');
    if (!panel) return;

    panel.innerHTML = '';

    if (!node) {
      renderSummary(panel);
      return;
    }

    panel.appendChild(renderBreadcrumb(node));
    panel.appendChild(renderHeader(node));

    // P20-T5-E (b259): findings, drift, plan block, deps, relations and the rest below are architecture-only: a node of
    // a view with its own renderer (IO: system root, group, screen, part; storage: root, zone, store, record, field) never reaches them.
    if (ownRenderer()) {
      if (isStorageNode(node)) renderStorageNode(panel, node);   // STOR-6b (b340)
      else renderIoNode(panel, node);
      return;
    }

    const bar = renderWeightBar(node);
    if (bar) panel.appendChild(bar);

    const pills = renderMetaPills(node);
    if (pills) panel.appendChild(pills);

    const origin = renderOrigin(node);
    if (origin) panel.appendChild(origin);

    const plannedSec = renderPlannedBlock(node);
    if (plannedSec) panel.appendChild(plannedSec);

    if (node.drift) {
      const badge = document.createElement('div');
      badge.className = 'pn-badge pn-drift-badge';
      badge.textContent = node.drift;
      panel.appendChild(badge);
    }

    if (node.stub) {
      const badge = document.createElement('div');
      badge.className = 'pn-badge pn-stub-badge';
      badge.textContent = 'stub: ' + node.stub;
      panel.appendChild(badge);
    }

    // ---- per-kind body ----
    // Phase 26 (T26-10): the Tests section sits after "Used by" / relations (component, container, system, subregion) or
    // after Calls (function, method); any other kind with tests gets it after its body.
    let testsShown = false;
    const addTests = () => { testsShown = true; const sec = renderTestsSection(node); if (sec) panel.appendChild(sec); };
    if (node.kind === 'component') {
      const claims = renderClaims(node);
      if (claims) panel.appendChild(claims);

      const planSec = renderPlanBlock(node);
      if (planSec) panel.appendChild(planSec);

      const depsOut = renderDepsSection(node, 'out');
      if (depsOut) panel.appendChild(depsOut);
      const depsIn = renderDepsSection(node, 'in');
      if (depsIn) panel.appendChild(depsIn);
      const relsSec = renderRelationsSection(node);
      if (relsSec) panel.appendChild(relsSec);
      addTests();

      if (node.claims && node.claims.length) {
        const owned = node.children.reduce((s, c) => s + (c.children ? c.children.length : 0), 0);
        const ownsSec = section('Owns', `${owned} element${owned === 1 ? '' : 's'} across ${node.children.length} file${node.children.length === 1 ? '' : 's'}`);
        // T12b: one row per file slice: path + the function names it owns here
        const list = document.createElement('div');
        list.className = 'pn-owns-list';
        node.children.forEach(sl => {
          const row = document.createElement('div');
          row.className = 'pn-owns-file';
          const p = document.createElement('div');
          p.className = 'pn-owns-path';
          p.textContent = sl.file || sl.name;
          row.appendChild(p);
          const names = (sl.children || []).map(c => c.name);
          if (names.length) {
            const f = document.createElement('div');
            f.className = 'pn-owns-fns';
            f.textContent = names.join(', ');
            row.appendChild(f);
          }
          list.appendChild(row);
        });
        ownsSec.appendChild(list);
        console.debug(PANEL_TAG, 'owns list', { id: node.id, files: node.children.length });
        panel.appendChild(ownsSec);
      }

      // P14-T30: detail line only when at least one file is file-only
      const fo = countFileOnly(node);
      if (fo.fileOnly > 0) {
        console.debug(PANEL_TAG, 'file-only count', { id: node.id, fileOnly: fo.fileOnly, files: fo.files });
        const foLine = document.createElement('div');
        foLine.className = 'pn-detail';
        foLine.textContent = `${fo.fileOnly} of ${fo.files} files are file-only (no parser)`;
        panel.appendChild(foLine);
      }

      const childList = renderChildrenList(node);
      if (childList) panel.appendChild(childList);

      const findings = renderFindingsList(node.findings);
      if (findings) panel.appendChild(findings);

      const history = renderHistory(node);
      if (history) panel.appendChild(history);
    } else if (node.kind === 'system' || node.kind === 'container' || node.kind === 'subregion') {
      const planSec = renderPlanBlock(node);
      if (planSec) panel.appendChild(planSec);

      const depsOut = renderDepsSection(node, 'out');
      if (depsOut) panel.appendChild(depsOut);
      const depsIn = renderDepsSection(node, 'in');
      if (depsIn) panel.appendChild(depsIn);
      const relsSec = renderRelationsSection(node);
      if (relsSec) panel.appendChild(relsSec);
      addTests();

      const childList = renderChildrenList(node, 'Contains');
      if (childList) panel.appendChild(childList);

      const findings = renderFindingsList(node.findings);
      if (findings) panel.appendChild(findings);
    } else if (node.kind === 'context') {
      // C1-CTX: the C1 frame (our system, its persons and externals): what it holds, nothing of its own. C1 A1 (b828): it is a
      // holder now (no box, no hit, no tree row or search hit), so only a kept or shared selection of its id ('sel=__c1__') shows this.
      const childList = renderChildrenList(node, 'Contains');
      if (childList) panel.appendChild(childList);
    } else if (node.kind === 'slice') {
      const parentComp = parents()[node.id];
      const allInFile = node.file ? findElementsInFile(root(), node.file) : [];
      const desc = document.createElement('div');
      desc.className = 'pn-detail';
      desc.textContent = parentComp
        ? `Owned here by ${parentComp.name}: ${node.children.length} of ${allInFile.length || node.children.length} function${allInFile.length === 1 ? '' : 's'} in this file.`
        : `${node.children.length} function${node.children.length === 1 ? '' : 's'} owned in this file.`;
      panel.appendChild(desc);

      if (allInFile.length) {
        const sec = section('Every function in this file');
        const list = document.createElement('div');
        list.className = 'pn-children';
        allInFile.forEach(fn => {
          const row = document.createElement('button');
          row.className = 'pn-child-row';
          const nameDiv = document.createElement('div');
          nameDiv.className = 'pn-child-name';
          nameDiv.appendChild(document.createTextNode(fn.name + '()'));
          row.appendChild(nameDiv);
          const ownerDiv = document.createElement('div');
          ownerDiv.className = 'pn-child-weight';
          ownerDiv.textContent = getOwnerLabel(fn, parents());
          row.appendChild(ownerDiv);
          row.onclick = () => goTo(fn.id);
          list.appendChild(row);
        });
        sec.appendChild(list);
        panel.appendChild(sec);
      } else {
        const childList = renderChildrenList(node);
        if (childList) panel.appendChild(childList);
      }

      const findings = renderFindingsList(node.findings);
      if (findings) panel.appendChild(findings);
    } else if (node.kind === 'shared' || node.kind === 'unassigned') {
      const desc = document.createElement('div');
      desc.className = 'pn-detail';
      desc.textContent = KIND_NOTE[node.kind];
      panel.appendChild(desc);

      if (node.kind === 'unassigned' && !(node.children && node.children.length) && Array.isArray(node.emptyFiles) && node.emptyFiles.length) {
        const none = document.createElement('div');
        none.className = 'pn-detail';
        none.textContent = 'No function is unassigned. These ' + node.emptyFiles.length + ' files have no parsed functions, so no component can own them.';
        panel.appendChild(none);
      }
      const origins = renderOrigins(node);
      if (origins) panel.appendChild(origins);

      const childList = renderChildrenList(node, 'Contents', node.kind === 'shared' ? sharedListOpts() : unassignedListOpts());
      if (childList) panel.appendChild(childList);

      const findings = renderFindingsList(node.findings);
      if (findings) panel.appendChild(findings);
    } else if (node.kind === 'function' || node.kind === 'method') {
      const kv = document.createElement('div');
      kv.className = 'pn-detail';
      kv.textContent = `${node.file || ''}${node.line ? ' · L' + node.line : ''}`;
      panel.appendChild(kv);
      panel.appendChild(renderFunctionOwner(node));

      // P14-L4-5b: a ghost (planned, no file yet) has no file and no code: no Source block, no VS Code link
      if (node.file && node.code && node.code.length) {
        const sec = section('Source');
        sec.appendChild(renderCodeBlock(node.code, node.line || 1));
        panel.appendChild(sec);
        const vlink = renderVscodeLink(node);
        if (vlink) panel.appendChild(vlink);
      }

      panel.appendChild(renderCallsSection(node));
      addTests();
      panel.appendChild(renderTraceBack(node));

      const findings = renderFindingsList(node.findings);
      if (findings) panel.appendChild(findings);
    } else {
      // file / class / and any future kind: generic fallback (unchanged Phase 5 behavior)
      const childList = renderChildrenList(node);
      if (childList) panel.appendChild(childList);

      const findings = renderFindingsList(node.findings);
      if (findings) panel.appendChild(findings);
    }

    if (!testsShown) addTests();

    // generic VS Code link for kinds that didn't already render one above (component/container/
    // system/slice/shared/unassigned don't carry node.file; function/method already handled it
    // next to the Source block; file/class fall through to here)
    if (node.kind !== 'function' && node.kind !== 'method') {
      const vlink = renderVscodeLink(node);
      if (vlink) panel.appendChild(vlink);
    }
  }

  // ===== P13-T9c: function panel owner line =====
  function renderFunctionOwner(fnNode) {
    const owner = getOwnerNode(fnNode, parents());
    const wrap = document.createElement('div');
    wrap.className = 'pn-owner';
    const ownerLine = document.createElement('div');
    ownerLine.className = 'pn-detail';
    ownerLine.appendChild(document.createTextNode('owner: '));
    let how = null;
    if (owner && owner.kind === 'component') {
      ownerLine.appendChild(ownerButton(owner.id, owner.name));
      const claim = findMatchingClaim(owner, fnNode);
      if (claim) {
        const base = owner.source ? String(owner.source).split('/').pop() : '';
        how = `claimed by ${claim.kind} link ${claim.path}${claim.kind === 'function' && claim.fn ? '#' + claim.fn : ''}${base ? ' in ' + base : ''}`;
      }
      console.debug(PANEL_TAG, 'function owner', { fn: fnNode.id, owner: owner.id, claim: claim ? { kind: claim.kind, path: claim.path, fn: claim.fn } : null });
    } else if (owner && owner.kind === 'shared') {
      ownerLine.appendChild(document.createTextNode(owner.name));
      how = 'auto: used by other components';
      console.debug(PANEL_TAG, 'function owner shared', { fn: fnNode.id });
    } else {
      ownerLine.appendChild(document.createTextNode(owner ? owner.name : 'Unassigned'));
      how = 'nothing claims it';
      console.debug(PANEL_TAG, 'function owner unassigned', { fn: fnNode.id });
    }
    wrap.appendChild(ownerLine);
    if (how) {
      const howLine = document.createElement('div');
      howLine.className = 'pn-detail pn-owner-how';
      howLine.textContent = how;
      wrap.appendChild(howLine);
    }
    return wrap;
  }

  // Map selection handler: keeps the file view when the selected node is a slice of the same file, else normal render.
  function onMapSelect(node) {
    if (P.file.viewPath() && node && typeof node.id === 'string' && node.id.endsWith('::slice::' + P.file.viewPath())) {
      console.debug(PANEL_TAG, 'onSelect: keep file view', { path: P.file.viewPath(), id: node.id });
      return;
    }
    if (P.file.viewPath()) console.debug(PANEL_TAG, 'onSelect: leaving file view', { path: P.file.viewPath(), id: node && node.id });
    P.file.leave();
    syncParents();
    updatePanel(node);
  }

  // ===== Setup =====
  window.C4PM_PANEL = { showFile: showFile };
  if (map) {
    map.onSelect(onMapSelect);
    updatePanel(null); // Show summary on load
  } else {
    // map.js didn't load, show summary only
    const panel = document.getElementById('panel');
    if (panel) {
      renderSummary(panel);
    }
  }

  P.search.setup();
  P.legend.setup();
  // P20-T5-E (b259): the tree changed (loadTree already sent onSelect(null)): own parent map and legend follow the mode
  if (window.C4PM_MODE) window.C4PM_MODE.onChange(() => { syncParents(); P.legend.setup(); });

  // Phase 30 SV9b (b642): the view-state part 'panel' = { id, b, file, top }: the scroll of #panel-col, kept with what the
  // panel shows (the selected c-item id, the selected b-item id, the file view's path). It comes back only for the same
  // selection; a kept file view whose file is still in the page is shown first. viewState.js loads after this file, so the
  // part is added at DOMContentLoaded (or on the next timer in a loaded page), before the restore.
  const panelPart = {
    get: () => {
      const col = document.getElementById('panel-col');
      if (!col || !map) return undefined;
      const B = window.C4PM_BOARD;
      return { id: map.selectedId() || null, b: (B && B.selectedId()) || null, file: P.file.viewPath() || null, top: col.scrollTop || 0 };
    },
    set: v => {
      const col = document.getElementById('panel-col');
      if (!col || !map || !v || typeof v !== 'object') return;
      const B = window.C4PM_BOARD;
      if ((map.selectedId() || null) !== (v.id || null) || ((B && B.selectedId()) || null) !== (v.b || null)) return;   // another panel
      if (typeof v.file === 'string' && v.file !== P.file.viewPath()) {
        if (!(Array.isArray(data.files) && data.files.some(f => f && f.path === v.file))) return;   // the file is gone
        showFile(v.file);
      }
      if (typeof v.top === 'number' && isFinite(v.top) && v.top > 0) col.scrollTop = v.top;
    },
  };
  // C4PM_STATE.whenReady (state.js): a page without state.js (the panel vm tests) has no viewState.js either.
  if (window.C4PM_STATE) window.C4PM_STATE.whenReady(() => { if (window.C4PM_VIEWSTATE) window.C4PM_VIEWSTATE.part('panel', panelPart); });
})();
