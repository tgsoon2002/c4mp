// summary.js: the panel summary shown when nothing is selected (renderSummary).
// LAY-12c (b389): split out of panel.js; registers P.summary on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const data = window.C4PM_DATA;
  const { esc, plural, modeNow, root, archTree, entryKind, ioEntries } = P.vm;
  const { goTo } = P.kit;

  // UI5 (b755): a page with s-items (C4PM_DATA.sims) starts every view's summary with one bullet that points at the Simulations
  // section (sim-list.js); null without s-items.
  function simsNote() {
    if (!Array.isArray(data.sims) || !data.sims.length) return null;
    const ul = document.createElement('ul');
    ul.className = 'pn-sims-note';
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = 'Simulations';
    li.appendChild(b);
    li.appendChild(document.createTextNode(' open the section at the bottom of the left column and pick one: its path lights up in all three views. ▶ presents it step by step.'));
    ul.appendChild(li);
    return ul;
  }

  function renderSummary(panel) {
    // P20-T5-E (b259): the architecture summary (findings, drift, build notes) says nothing about screens (or, STOR-6b, records):
    // another tree gets a title and one line, not the repo name (P20-T5-P, b263)
    if (!archTree()) {
      const viewSummary = (title, text) => {
        const box = document.createElement('div');
        box.className = 'pn-summary';
        const h2 = document.createElement('h2');
        h2.style.fontSize = '15px';
        h2.style.fontWeight = '600';
        h2.style.margin = '0';
        h2.textContent = title;
        box.appendChild(h2);
        const line = document.createElement('div');
        line.style.fontSize = '13px';
        line.style.color = 'var(--muted)';
        line.textContent = text;
        box.appendChild(line);
        const note = simsNote();
        if (note) box.appendChild(note);
        panel.appendChild(box);
      };
      const entries = ioEntries(root());   // entries: screens, commands, routes, tools
      if (entries.length) {
        const groups = (root().children || []);
        const navEdges = (data.nav && data.nav.edges) || [];
        viewSummary('IO view', `IO view: ${groups.length} ${plural(groups.length, 'group')} · ${window.C4PM_MODE.counts(entries.map(entryKind))} · ${navEdges.length} ${plural(navEdges.length, 'navigation')}`);
        return;
      }
      // a tree with no entries (the storage view): the view's label and its header chips (C4PM_VIEWS, VIEW-0; chips is optional)
      const view = window.C4PM_VIEWS[modeNow()];
      viewSummary(view.label, view.chips ? view.label + ': ' + view.chips(data) : view.label);
      return;
    }
    const summary = document.createElement('div');
    summary.className = 'pn-summary';

    // Title and summary text
    const titleSection = document.createElement('div');
    titleSection.className = 'pn-summary-section';
    const titleH2 = document.createElement('h2');
    titleH2.style.fontSize = '15px';
    titleH2.style.fontWeight = '600';
    titleH2.style.margin = '0';
    titleH2.textContent = data.title;
    titleSection.appendChild(titleH2);
    const subtitleDiv = document.createElement('div');
    subtitleDiv.style.fontSize = '12px';
    subtitleDiv.style.color = 'var(--muted)';
    subtitleDiv.textContent = data.subtitle;
    titleSection.appendChild(subtitleDiv);
    const summaryText = document.createElement('div');
    summaryText.style.fontSize = '13px';
    summaryText.style.color = 'var(--muted)';
    summaryText.textContent = data.summary; // refined below once counts are known (T12c)
    titleSection.appendChild(summaryText);
    summary.appendChild(titleSection);
    const simsUl = simsNote();
    if (simsUl) summary.appendChild(simsUl);

    // T12b: "How this map is built" + counts, all computed from `data`
    const counts = { container: 0, component: 0, fn: 0 };
    const sev = { critical: 0, warning: 0, info: 0 };
    // T12c: one list per severity feeds BOTH the chips and the lists below, so they always agree.
    // Entry = { finding, node } (node = owning ViewNode for node findings, null for plan findings).
    const byFindSev = { critical: [], warning: [], info: [] };
    const countFinding = (f, ownerNode) => {
      if (f && sev[f.severity] !== undefined) { sev[f.severity]++; byFindSev[f.severity].push({ finding: f, node: ownerNode || null }); }
    };
    (function walk(n) {
      if (n.kind === 'container') counts.container++;
      else if (n.kind === 'component') counts.component++;
      else if (n.kind === 'function' || n.kind === 'method') counts.fn++;
      (n.findings || []).forEach(f => countFinding(f, n));
      (n.children || []).forEach(walk);
    })(root());
    (data.planFindings || []).forEach(f => countFinding(f, null));
    console.debug(PANEL_TAG, 'summary counts', { counts, sev });
    // T12c: header line comes pre-built from the pipeline. P14-T5c/T33b: its container number is already the
    // rendered count (html.ts withRenderedContainerCount), so only the plural fix runs here.
    summaryText.textContent = String(data.summary == null ? '' : data.summary)
      .replace(/\b(\d+) (component edge|component|file|code element|unresolved import)s?\b/g, (m, n, w) => `${n} ${plural(n, w)}`);
    console.debug(PANEL_TAG, 'summary header line', { raw: data.summary, shown: summaryText.textContent });
    const howSec = document.createElement('div');
    howSec.className = 'pn-summary-section pn-how';
    const howTitle = document.createElement('div');
    howTitle.className = 'pn-summary-title';
    howTitle.textContent = 'How this map is built';
    howSec.appendChild(howTitle);
    const howText = document.createElement('div');
    howText.style.fontSize = '12px';
    howText.style.color = 'var(--muted)';
    howText.textContent = 'Each box is a piece of the system, from the whole system down to single functions. Click a box to open it and read its details here. Components own files and functions; anything no component claims is listed as Unassigned.';
    howSec.appendChild(howText);
    const countsRow = document.createElement('div');
    countsRow.className = 'pn-counts';
    [
      [counts.container, 'container', 1], [counts.component, 'component', 1], [counts.fn, 'function', 1],
      [sev.critical, 'critical', 0], [sev.warning, 'warning', 0], [sev.info, 'info', 0],
    ].forEach(([n, label, pl]) => {
      const b = document.createElement('span');
      b.className = 'pn-badge pn-count';
      b.textContent = `${n} ${pl ? plural(n, label) : label}`;
      countsRow.appendChild(b);
    });
    howSec.appendChild(countsRow);
    summary.appendChild(howSec);

    // Drift summary
    if (data.drift) {
      const driftSection = document.createElement('div');
      driftSection.className = 'pn-summary-section';
      const driftTitle = document.createElement('div');
      driftTitle.className = 'pn-summary-title';
      driftTitle.textContent = 'Drift';
      driftSection.appendChild(driftTitle);
      const driftText = document.createElement('div');
      driftText.style.fontSize = '12px';
      driftText.style.color = 'var(--muted)';
      driftText.textContent = data.drift.summary;
      driftSection.appendChild(driftText);

      // Removed list
      if (data.drift.removed && data.drift.removed.length > 0) {
        const removedDiv = document.createElement('div');
        removedDiv.className = 'pn-removed-list';
        removedDiv.style.marginTop = '6px';
        data.drift.removed.forEach(item => {
          const itemDiv = document.createElement('div');
          itemDiv.className = 'pn-removed-item';
          itemDiv.innerHTML = esc(item.id) + ' <span class="pn-removed-kind">(' + esc(item.kind) + ', ' + item.lines + ' ' + plural(item.lines, 'line') + ')</span>';
          removedDiv.appendChild(itemDiv);
        });
        driftSection.appendChild(removedDiv);
      }
      summary.appendChild(driftSection);
    }

    // T12c: findings by severity -- the SAME entries the chips count (node findings + plan findings).
    // Capped at SUMMARY_FINDINGS_CAP per severity with "... N more"; node findings link to their node.
    const SUMMARY_FINDINGS_CAP = 15;
    ['critical', 'warning', 'info'].forEach(severity => {
      const entries = byFindSev[severity];
      if (!entries.length) return;
      const sec = document.createElement('div');
      sec.className = 'pn-summary-section';
      const title = document.createElement('div');
      title.className = 'pn-summary-title';
      title.textContent = severity.charAt(0).toUpperCase() + severity.slice(1) + ' (' + entries.length + ')';
      sec.appendChild(title);
      entries.slice(0, SUMMARY_FINDINGS_CAP).forEach(({ finding, node: owner }) => {
        const findingEl = document.createElement('div');
        findingEl.className = 'pn-finding pn-finding-' + severity;
        const msg = document.createElement('div');
        msg.className = 'pn-finding-message';
        msg.textContent = finding.message;
        findingEl.appendChild(msg);
        const rule = document.createElement('div');
        rule.className = 'pn-finding-rule';
        rule.textContent = finding.rule;
        findingEl.appendChild(rule);
        if (owner) {
          const link = document.createElement('button');
          link.className = 'pn-finding-node';
          link.title = owner.id;
          link.textContent = owner.name;
          link.onclick = () => { console.debug(PANEL_TAG, 'finding node click', { id: owner.id }); goTo(owner.id); };
          findingEl.appendChild(link);
        }
        sec.appendChild(findingEl);
      });
      if (entries.length > SUMMARY_FINDINGS_CAP) {
        const more = document.createElement('div');
        more.className = 'pn-finding-more';
        more.textContent = '… ' + (entries.length - SUMMARY_FINDINGS_CAP) + ' more';
        sec.appendChild(more);
      }
      console.debug(PANEL_TAG, 'summary findings list', { severity, total: entries.length, shown: Math.min(entries.length, SUMMARY_FINDINGS_CAP) });
      summary.appendChild(sec);
    });

    panel.appendChild(summary);
  }

  P.summary = { renderSummary };
})();
