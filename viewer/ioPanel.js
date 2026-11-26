// ioPanel.js: the IO view panel (screens, parts, navigation edges, calls, wireframe section).
// LAY-12c (b389): split out of panel.js; registers P.io on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const data = window.C4PM_DATA;
  const map = window.C4PM_MAP;
  const { plural, root, parents, entryKind, isPartNode, stateKids, insideKids, ioEntries, owningEntry, navEntryOf, findNodeById } = P.vm;
  const { section, copyText, renderMetaPills, ioLink, pillsOf, chipsSection, idRowOf, lineOf } = P.kit;

  // ===== P20-T5-E (b259): IO view panel (screens). Data: navView nodes (kind 'screen': id = fqn, uid, meta.status;
  // kind 'container' = group, 'system' = the io root) and C4PM_DATA.nav (NavModel, src/types.ts): edges {from,to,label,via}
  // with from/to = screen fqns and via = a control fqn, groups[].entries[].parts[] {fqn,title,parts}. =====
  function navPartTitles() {
    const titles = new Map();
    const walk = (parts) => (parts || []).forEach(p => { titles.set(p.fqn, p.title); walk(p.parts); });
    ((data.nav && data.nav.groups) || []).forEach(g => (g.entries || []).forEach(sc => walk(sc.parts)));
    return titles;
  }

  // via fqn -> the part's title when the nav groups hold it, else the last segment of the fqn
  function viaName(via, titles) {
    if (titles.has(via)) return titles.get(via);
    return via.split('.').pop();
  }

  // One row per nav edge: target link, then the label and the control: "Sign in" via Submit
  function renderNavEdges(title, edges, otherOf) {
    const sec = section(title);
    if (!edges.length) {
      const none = document.createElement('div');
      none.className = 'pn-note';
      none.textContent = 'none';
      sec.appendChild(none);
      return sec;
    }
    const titles = navPartTitles();
    edges.forEach(e => {
      const row = document.createElement('div');
      row.className = 'pn-rel';
      const otherId = otherOf(e);
      const other = findNodeById(root(), otherId);
      if (other) row.appendChild(ioLink(other.id, other.name));
      else {
        console.debug(PANEL_TAG, 'nav edge end not in tree, plain text', { from: e.from, to: e.to });
        row.appendChild(document.createTextNode(otherId));
      }
      const how = [];
      // P20-T5-P (b263): navModel.ts sets label = the relation's own label (and labelled: true), else the control's title
      // (via part). Quote only a label of its own, so the control is not said twice.
      const viaTitle = e.via ? viaName(e.via, titles) : null;
      if (e.label && e.labelled) how.push('"' + e.label + '"');
      if (e.via) how.push('via ' + viaTitle);
      if (how.length) {
        const note = document.createElement('span');
        note.className = 'pn-detail';
        note.textContent = ' ' + how.join(' ');
        row.appendChild(note);
      }
      sec.appendChild(row);
    });
    return sec;
  }

  // b130: show the architecture node `ids[0]` (the Calls row). Setting openIn 'here': switch this window to arch, select + fly to it;
  // 'window': light all `ids` in the other window (link 'light') and open the arch view there (C4PM_OPEN).
  function openArch(ids) {
    if (window.C4PM_SETTINGS.get('openIn') === 'here') {
      window.C4PM_MODE.set('arch');
      // keep the hash in step so the header button can switch back (mode.js follows the hash); keep '&bare'
      if (window.location) window.location.hash = window.C4PM_MODE.bare() ? '#arch&bare' : '';
      map.select(ids[0]);
      map.flyTo(ids[0]);
    } else {
      if (window.C4PM_LINK) window.C4PM_LINK.light(ids);
      window.C4PM_OPEN('arch');
    }
  }

  // States (the state children) and Inside (the other children) of an entry or part, as chips that select them
  function renderPartLists(panel, node) {
    const st = stateKids(node), inside = insideKids(node);
    if (st.length) panel.appendChild(chipsSection('States', st));
    if (inside.length) panel.appendChild(chipsSection('Inside', inside));
  }

  // The panel of a part: id (+ uid), type / in / required, Goes to (its row's navigation), States, Inside, Calls (relations from this part)
  function renderPartPanel(panel, node) {
    panel.appendChild(idRowOf(node));
    const m = node.meta || {};
    const how = [m.type ? 'type ' + m.type : null, m.in ? 'in ' + m.in : null, m.required === 'true' ? 'required' : (m.required ? 'required: ' + m.required : null)].filter(Boolean);
    if (how.length) panel.appendChild(pillsOf(how));
    const entry = owningEntry(node), row = entry && entry.io && entry.io.rows.find(r => r.id === node.id), nav = row && row.nav;
    renderPartPlacement(panel, node, entry);   // W13 (b309)
    if (nav) {
      const to = findNodeById(root(), nav.to);
      const sec = section('Goes to'), chips = document.createElement('div');
      chips.className = 'pn-deps';
      if (to) chips.appendChild(ioLink(to.id, to.name + (nav.label ? ' · ' + nav.label : '')));
      else chips.appendChild(document.createTextNode(nav.to));
      sec.appendChild(chips);
      panel.appendChild(sec);
    }
    renderPartLists(panel, node);
    const calls = renderNavCalls(node, true);
    if (calls) panel.appendChild(calls);
  }

  // p27: the rows of an entry card, grouped like the card: indent by depth, kind chip from the kind table, title, type or word on the right.
  function renderEntryRows(node) {
    const rows = (node.io && node.io.rows) || [];
    const mode = window.C4PM_MODE;
    const sec = section('Parts', String(rows.length));
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'pn-rel';
      row.style.paddingLeft = (r.depth * 14) + 'px';
      const chip = document.createElement('span');
      chip.className = 'pn-badge';
      chip.textContent = r.word || mode.word(r.kind) || r.kind;
      row.appendChild(chip);
      row.appendChild(document.createTextNode(' ' + r.title));
      const how = r.meta && [r.meta.type, r.meta.in, r.meta.required === 'true' ? 'required' : null].filter(Boolean).join(', ');
      if (how) {
        const note = document.createElement('span');
        note.className = 'pn-detail';
        note.textContent = ' ' + how;
        row.appendChild(note);
      }
      sec.appendChild(row);
    });
    return sec;
  }

  // b130: "Calls" of a screen: one row per data.nav.calls entry of this screen whose toKind is in C4PM_MODE.callKinds. The chip names the
  // target (a component by its arch node name, anything else by its title NavCall.toTitle (b277: a planned function has no map node),
  // the last fqn segment when the page has no toTitle); the tooltip is the fqn; the note says the label and the control.
  function renderNavCalls(node, viaOnly) {   // viaOnly (a part): the calls made through this part; none: no section (null)
    const sec = section('Calls');
    const kinds = window.C4PM_MODE.callKinds;
    const calls = ((data.nav && data.nav.calls) || []).filter(c => (viaOnly ? c.via === node.id : c.from === node.id) && kinds.indexOf(c.toKind) >= 0);
    if (viaOnly && !calls.length) return null;
    if (!calls.length) {
      const none = document.createElement('div');
      none.className = 'pn-note';
      none.textContent = 'none';
      sec.appendChild(none);
      return sec;
    }
    const titles = navPartTitles();
    calls.forEach(c => {
      const row = document.createElement('div');
      row.className = 'pn-rel';
      const archId = map.archIdOf(c);
      const archNode = archId ? findNodeById(data.root, archId) : null;
      const name = archNode && c.to === c.toComponent ? archNode.name : (c.toTitle || c.to.split('.').pop());
      if (archId) {
        const btn = document.createElement('button');
        btn.className = 'pn-dep-chip';
        btn.title = c.to;
        btn.textContent = name;
        btn.onclick = () => { console.debug(PANEL_TAG, 'call click', { to: c.to, archId }); openArch([archId]); };
        row.appendChild(btn);
      } else {
        console.debug(PANEL_TAG, 'call target not on the map, plain text', { to: c.to });
        row.appendChild(document.createTextNode(name));
      }
      const how = [];
      if (c.label) how.push('"' + c.label + '"');
      if (c.via) how.push('via ' + viaName(c.via, titles));
      if (how.length) {
        const note = document.createElement('span');
        note.className = 'pn-detail';
        note.textContent = ' ' + how.join(' ');
        row.appendChild(note);
      }
      sec.appendChild(row);
    });
    return sec;
  }

  function renderScreenUid(node) {
    const row = document.createElement('div');
    row.className = 'pn-uid';
    row.textContent = node.uid ? 'uid ' + node.uid : 'uid: none yet (run c4mp plan ids)';
    if (node.uid) {
      const copyUid = document.createElement('button');
      copyUid.className = 'pn-copy';
      copyUid.textContent = 'Copy uid';
      copyUid.onclick = () => copyText(node.uid, copyUid);
      row.appendChild(copyUid);
    }
    return row;
  }

  // b128: the 'Design' section of a screen: node.io.design as given; an http(s) value is a link, anything else plain text
  function renderScreenDesign(node) {
    const design = node.io && node.io.design;
    if (!design) return null;
    const sec = section('Design');
    if (/^https?:\/\//i.test(design)) {
      const a = document.createElement('a');
      a.className = 'pn-vscode-link';
      a.href = design;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = design;
      sec.appendChild(a);
    } else {
      const t = document.createElement('div');
      t.className = 'pn-detail';
      t.textContent = design;
      sec.appendChild(t);
    }
    return sec;
  }

  // ===== W13 (b309): wireframe facts. Server side (W6, src/types.ts): NavEntry.wireframe = { file, html?, error?, refs: WireRef[]
  // { ref, fqn, problem?: 'unknown' | 'ambiguous', candidates? }, missing: part fqns }, IoCard.viewport = { w, h, source: 'device' | 'metadata' }.
  // Browser side (W11, b307 contract): C4PM_IOVIEW.wireOf(screenFqn) -> { state, reason? } | null and placed(partFqn) -> { boxes, hidden } | null;
  // both are looked up with typeof (a page without them gets the server facts only). =====
  // Q12 (same rule as W11's badge): "no wireframe" only when at least one entry of the page has a wireframe
  const pageHasWireframe = () => ((data.nav && data.nav.groups) || []).some(g => (g.entries || []).some(e => !!e.wireframe));
  const ioViewFn = name => (window.C4PM_IOVIEW && typeof window.C4PM_IOVIEW[name] === 'function' ? window.C4PM_IOVIEW[name] : null);

  // one row: a word ("Missing", "Ambiguous x") then chips (ioLink) or plain texts
  function wireRow(word, chips, texts) {
    const row = document.createElement('div');
    row.className = 'pn-rel';
    const label = document.createElement('span');
    label.className = 'pn-detail';
    label.textContent = word + ' ';
    row.appendChild(label);
    (chips || []).forEach(c => row.appendChild(ioLink(c.id, c.name)));
    if (texts && texts.length) row.appendChild(document.createTextNode(texts.join(', ')));
    return row;
  }

  // The 'Wireframe' section of a screen (c-item renderScreenWireframe): the mark (no wireframe / wireframe not drawn / wireframe out of
  // date), the lists (missing, unknown, ambiguous with candidates), the size W x H and its source, the file. null: not a screen, or no
  // screen of the page has a wireframe (a repo without wireframes, a repo-wide plan: K1, K2).
  function renderScreenWireframe(node) {
    if (entryKind(node) !== 'screen') return null;
    const entry = navEntryOf(node.id), wf = entry && entry.wireframe;
    if (!wf && !pageHasWireframe()) return null;
    const sec = section('Wireframe');
    if (!wf) sec.appendChild(lineOf('pn-note', 'no wireframe'));
    else if (wf.error) {
      sec.appendChild(lineOf('pn-note', 'wireframe not drawn'));
      sec.appendChild(lineOf('pn-detail', wf.error));
    } else {
      const wireOf = ioViewFn('wireOf'), drawn = wireOf ? wireOf(node.id) : null;
      if (!wireOf) sec.appendChild(lineOf('pn-detail', 'drawing state not known on this page'));
      else if (drawn && drawn.state === 'not-drawn') {
        sec.appendChild(lineOf('pn-note', 'wireframe not drawn'));
        if (drawn.reason) sec.appendChild(lineOf('pn-detail', drawn.reason));
      }
      const unknown = wf.refs.filter(r => r.problem === 'unknown'), ambiguous = wf.refs.filter(r => r.problem === 'ambiguous');
      if (wf.missing.length || unknown.length || ambiguous.length) {
        sec.appendChild(lineOf('pn-note', 'wireframe out of date'));
        const titles = navPartTitles();
        if (wf.missing.length) sec.appendChild(wireRow('Missing', wf.missing.map(f => ({ id: f, name: viaName(f, titles) }))));
        if (unknown.length) sec.appendChild(wireRow('Unknown', null, unknown.map(r => r.ref)));
        ambiguous.forEach(r => sec.appendChild(wireRow('Ambiguous ' + r.ref, (r.candidates || []).map(f => ({ id: f, name: viaName(f, titles) })))));
      }
    }
    const vp = node.io && node.io.viewport;
    sec.appendChild(lineOf('pn-detail', vp ? 'size ' + vp.w + ' x ' + vp.h + (vp.source === 'metadata' ? ' (viewport metadata)' : ' (device)') : 'size not known'));
    sec.appendChild(lineOf('pn-detail', wf ? 'file ' + wf.file : 'expected file io/' + node.id + '.html'));
    return sec;
  }

  // A region or control of a screen with a wireframe: "not placed in the wireframe" (server: wireframe.missing), else from the drawn
  // boxes (C4PM_IOVIEW.placed, when the page has it): "shown sometimes" (a hidden box), "placed <n> times" (more than one box).
  function renderPartPlacement(panel, node, entry) {
    if (node.kind !== 'region' && node.kind !== 'control') return;
    const nav = entry ? navEntryOf(entry.id) : null, wf = nav && nav.wireframe;
    if (!wf) return;
    if (wf.missing.indexOf(node.id) >= 0) { panel.appendChild(lineOf('pn-note', 'not placed in the wireframe')); return; }
    const placed = ioViewFn('placed'), p = placed ? placed(node.id) : null;
    if (!p) return;
    if (p.hidden) panel.appendChild(lineOf('pn-note', 'shown sometimes'));
    if (p.boxes > 1) panel.appendChild(lineOf('pn-note', 'placed ' + p.boxes + ' times'));
  }

  function renderIoNode(panel, node) {
    const pills = renderMetaPills(node);   // meta.status (screens), Tech (groups with a technology)
    if (pills) panel.appendChild(pills);
    if (isPartNode(node)) { renderPartPanel(panel, node); return; }
    if (node.kind === 'screen') {
      panel.appendChild(renderScreenUid(node));
      const group = parents()[node.id];
      if (group) panel.appendChild(section('Group', group.name));
      const design = renderScreenDesign(node); if (design) panel.appendChild(design);   // b128
      const wf = renderScreenWireframe(node); if (wf) panel.appendChild(wf);   // W13 (b309)
      if (entryKind(node) === 'screen') {   // p27: navigation is screen to screen; a command, route or tool shows its parts instead
        const regions = insideKids(node).filter(c => c.kind === 'region');
        const controls = (function count(n) { return (n.children || []).reduce((a, c) => a + (c.kind === 'control' ? 1 : 0) + count(c), 0); })(node);
        panel.appendChild(pillsOf([regions.length + ' ' + plural(regions.length, 'region'), controls + ' ' + plural(controls, 'control')]));
        const edges = (data.nav && data.nav.edges) || [];
        panel.appendChild(renderNavEdges('Navigates to', edges.filter(e => e.from === node.id), e => e.to));
        panel.appendChild(renderNavEdges('Reached from', edges.filter(e => e.to === node.id), e => e.from));
      } else if (!(node.children || []).length && node.io.rows.length) panel.appendChild(renderEntryRows(node));   // no part nodes (an older page): the rows
      renderPartLists(panel, node);   // States, Inside (a command lists its parts and its subcommands)
      panel.appendChild(renderNavCalls(node));   // b130
      return;
    }
    const members = node.kind === 'container' ? ioEntries(node) : (node.children || []);   // an app lists all its entries (subcommands too); the root its apps
    if (!members.length) return;
    const sec = section(node.kind === 'container' ? (members.every(m => entryKind(m) === 'screen') ? 'Screens' : 'Entries') : 'Groups', String(members.length));
    const row = document.createElement('div');
    row.className = 'pn-deps';
    members.forEach(m => row.appendChild(ioLink(m.id, m.name)));
    sec.appendChild(row);
    panel.appendChild(sec);
  }

  P.io = { openArch, renderIoNode };
})();
