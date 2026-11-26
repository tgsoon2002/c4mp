// testsPanel.js: the Tests section (to run, to write, touching) and the trace back; defines window.C4PM_PANEL_TESTS (board-panel.js).
// LAY-12c (b389): split out of panel.js; registers P.tests on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const PANEL_TAG = '[c4pm panel]';
  const data = window.C4PM_DATA;
  const { esc, getBreadcrumb, root, parents, findNodeById } = P.vm;
  const { section, goTo, shellQuote, copyText } = P.kit;

  // ===== Phase 26 (T26-10): Tests section =====
  // node.tests {count, ids, children?, touches?} index into data.tests.cases ({id, line, level, runner, run?});
  // data.tests.runners[runner] = {cwd} or {reason}. Lists: the tests to run (attached here, then below) and the tests
  // attached elsewhere that touch this box. Each row: name, level, where it is attached, run command + Copy.
  const TESTS_SHOWN = 30;   // rows per list before a "Show N more" button
  let testHomes = null;     // case index -> the node it is attached to (built once, from the architecture tree)
  function testHome(i) {
    if (!testHomes) {
      testHomes = new Map();
      (function walk(n) {
        ((n.tests && n.tests.ids) || []).forEach(k => testHomes.set(k, n));
        (n.children || []).forEach(walk);
      })(data.root);
    }
    return testHomes.get(i) || null;
  }

  function testRunText(c) {
    const runner = data.tests.runners[c.runner] || {};
    if (!c.run) return null;
    return runner.cwd && runner.cwd !== '.' ? 'cd ' + shellQuote(runner.cwd) + ' && ' + c.run : c.run;
  }

  function renderTestRow(i, relation) {
    const c = data.tests.cases[i];
    const hash = c.id.indexOf('#');
    const file = hash < 0 ? c.id : c.id.slice(0, hash);
    const row = document.createElement('div');
    row.className = 'pn-test';
    const head = document.createElement('div');
    head.className = 'pn-test-head';
    const name = document.createElement('span');
    name.className = 'pn-test-name';
    name.textContent = hash < 0 ? file : c.id.slice(hash + 1);
    name.title = c.id;
    head.appendChild(name);
    const level = document.createElement('span');
    level.className = 'pn-badge pn-test-level';
    level.textContent = c.level;
    head.appendChild(level);
    row.appendChild(head);

    const where = document.createElement('div');
    where.className = 'pn-test-where';
    const home = relation === 'own' ? null : testHome(i);
    where.appendChild(document.createTextNode(relation === 'own' ? 'attached here' : relation === 'child' ? 'via ' : 'touches this; attached to '));
    if (relation !== 'own') {
      if (home) {
        const btn = document.createElement('button');
        btn.className = 'pn-rel-target';
        btn.title = home.id;
        btn.textContent = home.name;
        btn.onclick = () => { console.debug(PANEL_TAG, 'test home click', { test: c.id, id: home.id }); goTo(home.id); };
        where.appendChild(btn);
      } else {
        where.appendChild(document.createTextNode('code not drawn on the map'));
      }
    }
    where.appendChild(document.createTextNode(' · ' + file + ':' + c.line));
    row.appendChild(where);

    const cmd = testRunText(c);
    if (cmd) {
      const run = document.createElement('div');
      run.className = 'pn-test-run';
      const code = document.createElement('code');
      code.textContent = cmd;
      code.title = cmd;
      run.appendChild(code);
      const copy = document.createElement('button');
      copy.className = 'pn-copy';
      copy.textContent = 'Copy';
      copy.onclick = () => copyText(cmd, copy);
      run.appendChild(copy);
      row.appendChild(run);
    } else {
      const none = document.createElement('div');
      none.className = 'pn-note';
      none.textContent = 'no run command: ' + ((data.tests.runners[c.runner] || {}).reason || 'runner unknown');
      row.appendChild(none);
    }
    return row;
  }

  // One list of rows (rowOf(item) -> element); past TESTS_SHOWN rows a button shows the rest.
  function renderRowList(items, rowOf) {
    const list = document.createElement('div');
    list.className = 'pn-tests';
    items.slice(0, TESTS_SHOWN).forEach(it => list.appendChild(rowOf(it)));
    if (items.length > TESTS_SHOWN) {
      const more = document.createElement('button');
      more.className = 'pn-tests-more';
      more.textContent = 'Show ' + (items.length - TESTS_SHOWN) + ' more';
      more.onclick = () => {
        list.removeChild(more);
        items.slice(TESTS_SHOWN).forEach(it => list.appendChild(rowOf(it)));
      };
      list.appendChild(more);
    }
    return list;
  }

  // Test case rows: items are [case index, relation].
  const renderTestList = items => renderRowList(items, ([i, rel]) => renderTestRow(i, rel));

  // T26-14c: a test to write (ViewTests.toWrite, indexes into C4PM_DATA.tests.toWrite): a planned `test` block of the plan
  // that no detected case matches yet. Its name, and the plan element whose block it is.
  function renderWriteRow(i) {
    const w = data.tests.toWrite[i];
    const row = document.createElement('div');
    row.className = 'pn-test pn-test-write';
    const name = document.createElement('div');
    name.className = 'pn-test-name';
    name.textContent = w.name;
    row.appendChild(name);
    const where = document.createElement('div');
    where.className = 'pn-test-where';
    where.textContent = 'on ' + w.parent;
    row.appendChild(where);
    return row;
  }
  const renderWriteList = indexes => renderRowList(indexes, renderWriteRow);

  // T26-12: the board drawer (board-panel.js) lists a b-item's tests with the same rows.
  window.C4PM_PANEL_TESTS = { renderTestList, renderWriteList };

  // To run (attached here or below), to write (planned, no case yet), touching (attached elsewhere). The heading counts
  // only the lists that have rows, so a node with only planned tests reads "1 to write", not "0 to run".
  function renderTestsSection(node) {
    const t = node.tests;
    if (!t || !data.tests) return null;
    const run = [...t.ids.map(i => [i, 'own']), ...(t.children || []).map(i => [i, 'child'])];
    const write = t.toWrite || [];
    const touches = (t.touches || []).map(i => [i, 'touch']);
    console.debug(PANEL_TAG, 'renderTestsSection', { id: node.id, own: t.ids.length, children: (t.children || []).length, toWrite: write.length, touches: touches.length });
    const counts = [[run.length, ' to run'], [write.length, ' to write'], [touches.length, ' touching']].filter(([k]) => k > 0);
    const sec = section('Tests', counts.length ? counts.map(([k, w]) => k + w).join(' · ') : '0 to run');
    if (run.length) sec.appendChild(renderTestList(run));
    if (write.length) {
      const sub = document.createElement('div');
      sub.className = 'pn-tests-sub';
      sub.textContent = 'To write (planned in the plan)';
      sec.appendChild(sub);
      sec.appendChild(renderWriteList(write));
    }
    if (touches.length) {
      const sub = document.createElement('div');
      sub.className = 'pn-tests-sub';
      sub.textContent = 'Attached elsewhere, touching this';
      sec.appendChild(sub);
      sec.appendChild(renderTestList(touches));
    }
    return sec;
  }

  function renderTraceBack(node) {
    const sec = section('Trace back');
    const chainIds = getBreadcrumb(node.id, parents());
    const trace = document.createElement('div');
    trace.className = 'pn-trace';
    chainIds.forEach((id, i) => {
      const n = findNodeById(root(), id);
      const btn = document.createElement('button');
      btn.textContent = n ? (n.kind === 'function' || n.kind === 'method' ? n.name + '()' : n.name) : esc(id);
      btn.onclick = () => goTo(id);
      trace.appendChild(btn);
      if (i < chainIds.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'pn-trace-sep';
        sep.textContent = '→';
        trace.appendChild(sep);
      }
    });
    sec.appendChild(trace);
    return sec;
  }

  P.tests = { renderTestsSection, renderTraceBack };
})();
