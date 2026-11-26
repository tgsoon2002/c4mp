// panelKit.js: shared builders of the side panel: code block, section, breadcrumb, uid row, meta pills, findings, children list, shared/unassigned lists, IO chips.
// LAY-12c (b389): split out of panel.js; registers P.kit on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const data = window.C4PM_DATA;
  const map = window.C4PM_MAP;
  const { esc, plural, getBreadcrumb, root, parents, kidsOf, entryKind, findNodeById } = P.vm;

  // Panel styles live in viewer/panel.css (inlined last into the page <style> by src/view/html.ts).

  // ===== Syntax-light highlighting (no external library) =====
  // Ported from the mock's syntax() -- a simple keyword/string/comment approach, not a real
  // tokenizer. Good enough for a read-only source preview.
  const KEYWORDS = /\b(import|export|from|const|let|var|function|return|async|await|new|if|else|for|while|switch|case|break|continue|class|interface|type|enum|extends|implements|public|private|protected|static|readonly|throw|try|catch|finally|typeof|instanceof|this|super|void|null|undefined|true|false)\b/g;

  function highlightLine(line) {
    let s = esc(line);
    if (/^\s*(\/\/|#)/.test(line)) {
      return `<span class="pn-cm">${s}</span>`;
    }
    // block-comment-ish lines (/* ... */) rendered as comment too, best-effort single-line check
    if (/^\s*\/\*/.test(line) || /\*\/\s*$/.test(line)) {
      return `<span class="pn-cm">${s}</span>`;
    }
    s = s.replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="pn-str">$1</span>');
    s = s.replace(KEYWORDS, '<span class="pn-kw">$1</span>');
    return s;
  }

  // P13-T8b / Decision 10: .c4 colouring. One pass over the RAW line (so quotes are not pre-escaped):
  // `//` comment to end of line, quoted strings, then the keywords src/plan/parser.ts understands.
  const C4_TOKENS = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(specification|views|model|extend|element|system|container|component|technology|description|title|link|metadata)\b/g;

  function highlightC4Line(line) {
    let out = '';
    let last = 0;
    String(line).replace(C4_TOKENS, (m, cm, str, kw, idx) => {
      out += esc(line.slice(last, idx));
      out += `<span class="${cm ? 'pn-cm' : str ? 'pn-str' : 'pn-kw'}">${esc(m)}</span>`;
      last = idx + m.length;
      return m;
    });
    return out + esc(String(line).slice(last));
  }

  function renderCodeBlock(lines, startLine, highlighter) {
    const hl = highlighter || highlightLine;
    const code = document.createElement('div');
    code.className = 'pn-code';
    (lines || []).forEach((line, i) => {
      const ln = document.createElement('div');
      ln.className = 'pn-ln';
      const no = document.createElement('span');
      no.className = 'pn-no';
      no.textContent = String((startLine || 1) + i);
      ln.appendChild(no);
      const content = document.createElement('span');
      content.innerHTML = hl(line);
      ln.appendChild(content);
      code.appendChild(ln);
    });
    return code;
  }

  // ===== Shared section builders =====

  function section(labelText, codeText) {
    const sec = document.createElement('div');
    sec.className = 'pn-section';
    const label = document.createElement('div');
    label.className = 'pn-label';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    if (codeText) {
      const code = document.createElement('code');
      code.textContent = codeText;
      code.title = codeText;
      label.appendChild(code);
    }
    sec.appendChild(label);
    return sec;
  }

  function renderBreadcrumb(node) {
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'pn-breadcrumb';
    const chain = getBreadcrumb(node.id, parents());
    chain.forEach((id, idx) => {
      if (idx > 0) {
        const sep = document.createElement('span');
        sep.className = 'pn-sep';
        sep.textContent = '›';
        breadcrumb.appendChild(sep);
      }
      const nodeAtId = findNodeById(root(), id);
      // b142: the level chip comes from the kind table (C4PM_MODE.tag, mode.js); no chip for a kind without a row
      const tag = nodeAtId && window.C4PM_MODE ? window.C4PM_MODE.tag(entryKind(nodeAtId)) : null;
      if (tag) {
        const chip = document.createElement('span');
        chip.className = 'pn-crumb-chip';
        chip.textContent = tag;
        breadcrumb.appendChild(chip);
      }
      const btn = document.createElement('button');
      btn.className = 'pn-crumb';
      btn.textContent = nodeAtId ? nodeAtId.name : esc(id);
      btn.onclick = () => goTo(id);
      breadcrumb.appendChild(btn);
    });
    return breadcrumb;
  }

  function goTo(id) {
    if (map && map.flyTo && map.select) {
      map.flyTo(id);
      map.select(id);
    }
  }

  // P14-T16: quote one shell argument (POSIX single quotes unless the string is plain).
  const SHELL_PLAIN = /^[A-Za-z0-9_@%+=:,.\/-]+$/;
  function shellQuote(s) {
    if (SHELL_PLAIN.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  // P14-T16: copy text to the clipboard; textarea + execCommand when the async API is missing or fails.
  function copyText(text, btn) {
    const done = () => { btn.textContent = 'Copied'; };
    const failed = (err) => { btn.textContent = 'Copy failed'; console.warn(PANEL_TAG, 'copy failed', err); };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok === false) throw new Error('execCommand(copy) returned false');
        done();
      } catch (err) { failed(err); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallback());
    } else {
      fallback();
    }
  }

  // P14-T16: uid row + "Copy uid" / "Copy remove command" buttons (system/container/component only).
  function renderUidRow(node) {
    const row = document.createElement('div');
    row.className = 'pn-uid';
    if (node.uid) {
      row.textContent = 'uid ' + node.uid;
    } else if (node.origin && node.origin.kind === 'scanned') {
      row.textContent = 'uid: not on the map in folder mode — run c4mp plan show ' + node.name;
    } else {
      row.textContent = 'uid: none yet (run c4mp plan ids)';
    }
    if (node.uid) {
      const copyUid = document.createElement('button');
      copyUid.className = 'pn-copy';
      copyUid.textContent = 'Copy uid';
      copyUid.onclick = () => copyText(node.uid, copyUid);
      row.appendChild(copyUid);
    }
    const removeCmd = 'c4mp plan remove ' + (node.uid || node.id) + ' --repo ' + shellQuote(data.repoPath || '.');   // b914: '.' on a source-less page
    const copyCmd = document.createElement('button');
    copyCmd.className = 'pn-copy';
    copyCmd.textContent = 'Copy remove command';
    copyCmd.onclick = () => copyText(removeCmd, copyCmd);
    row.appendChild(copyCmd);
    return row;
  }

  // P14-L4-10: a node with no code has no size: plan-only, or a ghost (planned, no linked file)
  function hasNoCode(n) { return !!n.planOnly || (n.builtState === 'planned' && !n.file); }

  function renderMetaPills(node) {
    // T12b: ViewNode.meta {status, owner, sprint, priority} (T2c; only keys present on the plan element, claim mode).
    // Status = pill (class pn-status-<value>), others = "Owner: x" pills. Tech = container's `detail`
    // (folder mode has no meta; technology lives in detail). Nothing is invented.
    const meta = node.meta || {};
    const labels = [['owner', 'Owner'], ['sprint', 'Sprint'], ['priority', 'Priority'], ['role', 'Role']];
    const present = labels.filter(([k]) => meta[k]);
    // T12c: show Tech only when known (not the 'Unknown' fallback, not the empty-container note 'no parsed code')
    const techRaw = node.kind === 'container' && node.detail ? node.detail : null;
    const tech = techRaw && !/^(unknown|no parsed code)$/i.test(String(techRaw).trim()) ? techRaw : null;
    if (techRaw && !tech) console.debug(PANEL_TAG, 'tech pill hidden', { id: node.id, detail: techRaw });
    if (!meta.status && !present.length && !tech) return null;
    const pills = document.createElement('div');
    pills.className = 'pn-meta-pills';
    const add = (cls, text) => {
      const badge = document.createElement('span');
      badge.className = 'pn-badge' + (cls ? ' ' + cls : '');
      badge.textContent = text;
      pills.appendChild(badge);
    };
    if (meta.status) add('pn-status pn-status-' + String(meta.status).toLowerCase().replace(/[^a-z0-9]+/g, '-'), String(meta.status));
    present.forEach(([k, label]) => add('', `${label}: ${meta[k]}`));
    if (meta.role === 'foundation' && node.usedByCount != null) add('', 'Used by: ' + node.usedByCount);   // b908
    if (tech) add('', `Tech: ${tech}`);
    console.debug(PANEL_TAG, 'meta pills', { id: node.id, status: meta.status || null, keys: present.map(p => p[0]), tech: !!tech });
    return pills;
  }

  function renderFindingsList(findings) {
    if (!findings || !findings.length) return null;
    const findingsDiv = document.createElement('div');
    findingsDiv.className = 'pn-findings';
    findings.forEach(finding => {
      const findingEl = document.createElement('div');
      findingEl.className = 'pn-finding pn-finding-' + finding.severity;
      const msg = document.createElement('div');
      msg.className = 'pn-finding-message';
      msg.textContent = finding.message;
      findingEl.appendChild(msg);
      const rule = document.createElement('div');
      rule.className = 'pn-finding-rule';
      rule.textContent = finding.rule;
      findingEl.appendChild(rule);
      findingsDiv.appendChild(findingEl);
    });
    return findingsDiv;
  }

  // opts (P13-T9a, all optional): nameOf(child) -> row title, weightOf(child) -> right-hand text,
  // after(child) -> element appended below the row (e.g. "used by ...").
  function renderChildrenList(node, labelText, opts) {
    const kids = kidsOf(node);   // a subregion lists its components (LK-G)
    if (!kids.length) return null;
    const o = opts || {};
    const sec = document.createElement('div');
    if (labelText) sec.appendChild(section(labelText));
    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'pn-children';
    kids.forEach(child => {
      const row = document.createElement('button');
      row.className = 'pn-child-row';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'pn-child-name';
      const nameText = o.nameOf ? o.nameOf(child) : ((child.kind === 'function' || child.kind === 'method') ? child.name + '()' : child.name);
      nameDiv.appendChild(document.createTextNode(nameText));
      // P14-L4-10: a child with no code gets no weight cell (the caller's weightOf still wins)
      const showWeight = !!o.weightOf || !hasNoCode(child);
      const weightText = o.weightOf ? o.weightOf(child) : (showWeight ? child.weight + ' ' + plural(child.weight, 'line') : '');
      // T12c: function detail is already "N lines" (types.ts) -- don't print it twice next to the weight column
      const detailDup = child.detail && String(child.detail).trim() === weightText;
      if (detailDup) console.debug(PANEL_TAG, 'child detail duplicates weight, dropped', { id: child.id, detail: child.detail });
      if (child.detail && !detailDup) {
        const small = document.createElement('small');
        small.textContent = child.detail;
        nameDiv.appendChild(small);
      }
      row.appendChild(nameDiv);
      if (showWeight) {
        const weightDiv = document.createElement('div');
        weightDiv.className = 'pn-child-weight';
        weightDiv.textContent = weightText;
        row.appendChild(weightDiv);
      }
      row.onclick = () => goTo(child.id);
      childrenDiv.appendChild(row);
      const extra = o.after ? o.after(child) : null;
      if (extra) childrenDiv.appendChild(extra);
    });
    sec.appendChild(childrenDiv);
    return sec;
  }

  function renderVscodeLink(node) {
    if (!node.file || !data.repoPath) return null;   // b914: no absolute path on a source-less page -> no link
    const link = document.createElement('a');
    link.className = 'pn-vscode-link';
    link.href = 'vscode://file/' + encodeURI(data.repoPath + '/' + node.file) + ':' + (node.line || 1);
    link.textContent = 'Open in VS Code';
    return link;
  }

  // ===== Per-kind explanatory notes (shared/unassigned) =====
  const KIND_NOTE = {
    shared: "Code nobody claims but files owned by other components import. C4PM created this component automatically -- it isn't written in any .c4 file. To make it permanent, give it a real component in a .c4 file, or link each function to the component that should own it.",
    unassigned: "No component claims this and no file that a claimed function imports reaches it. Either it's unplanned code that needs a claim, or it's dead code. This is an import-based approximation: calls are not tracked yet.",
  };

  // P13-T9a: shared node -- under each child "used by X, Y" (child.usedBy = resolved node ids, or raw ids
  // when unresolved: those stay plain text). Empty/absent usedBy -> no line.
  function sharedListOpts() {
    return {
      after: child => {
        const ids = Array.isArray(child.usedBy) ? child.usedBy : [];
        console.debug(PANEL_TAG, 'shared child usedBy', { id: child.id, usedBy: ids });
        const imp = Array.isArray(child.importedBy) ? child.importedBy : [];
        const usedLine = ids.length ? buildUsedBy(child, ids) : null;
        let impLine = null;
        if (imp.length) {
          impLine = document.createElement('div');
          impLine.className = 'pn-imported-by';
          impLine.textContent = 'imported by ' + imp.map(i => {
            const t = findNodeById(root(), i.owner);
            return i.file + ' (' + (t ? t.name : i.owner) + ')';
          }).join(', ');
        }
        if (usedLine && impLine) {
          const both = document.createElement('div');
          both.appendChild(usedLine);
          both.appendChild(impLine);
          return both;
        }
        return usedLine || impLine;
      },
    };
  }

  function buildUsedBy(child, ids) {
    const line = document.createElement('div');
    line.className = 'pn-used-by';
    line.appendChild(document.createTextNode('used by '));
    ids.forEach((uid, i) => {
      if (i > 0) line.appendChild(document.createTextNode(', '));
      const target = findNodeById(root(), uid);
      if (!target) {
        console.debug(PANEL_TAG, 'usedBy id not in tree, plain text', { id: child.id, user: uid });
        const span = document.createElement('span');
        span.className = 'pn-used-by-raw';
        span.textContent = uid;
        line.appendChild(span);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'pn-used-by-link';
      btn.title = target.id;
      btn.textContent = target.name;
      btn.onclick = () => { console.debug(PANEL_TAG, 'usedBy click', { id: target.id }); goTo(target.id); };
      line.appendChild(btn);
    });
    return line;
  }

  // P13-T9a: unassigned node -- rows "file#fn" + line count (endLine-line+1 when both known, else weight).
  function unassignedListOpts() {
    const lineCount = c => (typeof c.line === 'number' && typeof c.endLine === 'number') ? c.endLine - c.line + 1 : c.weight;
    return {
      nameOf: c => (c.file ? c.file + '#' : '') + c.name,
      weightOf: c => {
        const n = lineCount(c);
        console.debug(PANEL_TAG, 'unassigned row', { id: c.id, file: c.file, lines: n });
        return n + ' ' + plural(n, 'line');
      },
    };
  }

  function ioLink(id, name) {
    const btn = document.createElement('button');
    btn.className = 'pn-dep-chip';
    btn.title = id;
    btn.textContent = name;
    btn.onclick = () => { console.debug(PANEL_TAG, 'io link click', { id }); goTo(id); };
    return btn;
  }

  function pillsOf(texts) {
    const pills = document.createElement('div');
    pills.className = 'pn-meta-pills';
    texts.forEach(t => { const b = document.createElement('span'); b.className = 'pn-badge'; b.textContent = t; pills.appendChild(b); });
    return pills;
  }
  function chipsSection(title, nodes, textOf) {
    const sec = section(title, String(nodes.length));
    const row = document.createElement('div');
    row.className = 'pn-deps';
    nodes.forEach(n => row.appendChild(ioLink(n.id, textOf ? textOf(n) : n.name)));
    sec.appendChild(row);
    return sec;
  }

  // 'id <id>  ·  uid <uid>' (IO parts, storage nodes)
  const idRowOf = node => lineOf('pn-uid', 'id ' + node.id + (node.uid ? '  ·  uid ' + node.uid : ''));

  function lineOf(className, text) {
    const d = document.createElement('div');
    d.className = className;
    d.textContent = text;
    return d;
  }

  P.kit = { highlightC4Line, renderCodeBlock, section, renderBreadcrumb, goTo, shellQuote, copyText, renderUidRow, hasNoCode,
    renderMetaPills, renderFindingsList, renderChildrenList, renderVscodeLink, KIND_NOTE, sharedListOpts, unassignedListOpts,
    ioLink, pillsOf, chipsSection, idRowOf, lineOf };
})();
