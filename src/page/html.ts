import * as fs from 'fs';
import * as path from 'path';
import { ViewModel, ViewNode, C4pmConfig } from '../types';
import { openProject } from '../scan/project';
import { findPlan, scanWithPlan } from '../scan/planScan';
import { needsCallIndex } from '../sim/run';
import { resolveSimTarget, type SimTargetHit } from '../sim/resolve';
import { simFileFor } from '../sim/load';
import { callIndex } from '../callGraph/callResolve';
import { buildViewSims, type SimRefKeys } from '../view/simModel';
import { UID_KEY } from '../util/uid';
import { driftFrom } from '../scan/snapshots';
import { buildViewModel } from '../view/model';
import { forEachNode, viewRoots } from '../view/tree';
import { testsBinding } from '../query/testsContext';
import { buildKindWords } from '../view/kindWords';
import { wireframeRules } from '../c4/wireframeHtml';
import { layoutView } from '../view/layout';
import { buildNavView } from '../view/navLayout';
import { buildStorageView } from '../view/storageModel';
import { applyDrift, applyFindings } from '../view/overlay';
import { collectFindings } from '../check/collect';
import { attachBoard } from '../board/view';
import { boardFileFor } from '../board/load';
import { todayIso } from '../util/dates';
import { log } from '../log';
import { legacyStoreDir } from '../util/userFiles';
import { TOOL_VERSION } from '../constants';
import { embeddedAssetDir, findAssetDir } from '../assets';

/**
 * Find the viewer directory containing index.html: `../../viewer` (compiled dist/src), `../../../viewer`,
 * or `viewer/` beside the entry script (single executable, where `__dirname` is the build machine's path).
 */
export function viewerDir(): string {
  const dir = findAssetDir([
    path.resolve(__dirname, '../../viewer'),
    path.resolve(__dirname, '../../../viewer'),
    embeddedAssetDir('viewer'),
  ], 'index.html');
  if (!dir) throw new Error('Could not find viewer directory with index.html');
  return dir;
}

// LAY-12c (b389): the side panel's scripts, in load order. viewModel.js creates window.C4PM_PANEL_PARTS, each part registers
// on it and reads only the parts before it; panel.js (last) runs the setup (C4PM_PANEL, select listener, search, legend).
// The panel vm tests load this same list (test/helpers/panelScripts.ts).
export const PANEL_SCRIPTS = [
  'viewModel.js', 'panelKit.js', 'filePanel.js', 'ioPanel.js', 'storagePanel.js', 'testsPanel.js', 'summary.js', 'search.js', 'legend.js',
  'panel.js',
];

// Viewer script files, joined in this order into the single /*C4PM_SCRIPTS*/ block.
export const VIEWER_SCRIPTS = [
  // P20-T11 (b232): the settings module first; every other script reads window.C4PM_SETTINGS.
  // P20-T5-0 (b254): mode.js right after it (subscribers read C4PM_MODE at their own load); LAY-12a (b377): state.js next
  // (creates window.C4PM_STATE before every reader: camera, render, controls, ioView, storageView, map); openView.js and link.js after
  // map.js (link.js subscribes to C4PM_MAP.onSelect at load), all before the panel scripts (PANEL_SCRIPTS) and tree.js.
  // IO view renderer: the wireframe measurer first (W10, b306: ioView.layout calls it, W11), then the two family modules,
  // then the core (its layout() runs at load and needs them).
  'settings.js', 'mode.js', 'state.js', 'edit.js', 'camera.js', 'render.js', 'ioWireframe.js', 'ioScreens.js', 'ioBoxes.js', 'ioView.js', 'storageView.js', 'controls.js', 'map.js', 'openView.js', 'link.js',
  ...PANEL_SCRIPTS, 'tree.js',
  // Phase 25 (UI13, b763): the shared height drag of the drawers under the map, before board-drawer.js and sim-sequence.js.
  'drawer-resize.js',
  // P16-B18: board scripts, after tree.js (they need window.C4PM_MAP and run their listeners after the panel's).
  'board.js', 'board-map.js', 'board-drawer.js', 'board-panel.js', 'board-list.js', 'board-kanban.js',
  'board-timeline-math.js', 'board-timeline.js', 'board-dashboard.js', 'board-search.js',
  // Phase 25 (b853 S2): the pure flow steps per depth (C4PM_SIMFLOW), just before the core that reads it.
  'sim-flow.js',
  // Phase 25 (UI3, b753): the simulation core (C4PM_SIM), after the board (Esc reads C4PM_BOARD); the other sim-*.js files follow it.
  'sim.js',
  // Phase 25 (UI8, b758): the simulation overlay on the map (a post-draw function), right after the core.
  'sim-map.js',
  // Phase 25 (UI5, b755): the Simulations section of the left column, tree row flags, hint tail (after tree.js and controls.js)
  'sim-list.js',
  // Phase 25 (UI7, b757): the path strip and the camera hooks (fly, fitPath).
  'sim-strip.js',
  // Phase 25 (UI10, b760): the right panel of an s-item and "In simulations" on a c-item (after panel.js and board-panel.js:
  // its map listener runs after theirs and appends to the panel they drew)
  'sim-panel.js',
  // Phase 30 (SV9a, b642): the view state kept across reloads (C4PM_VIEWSTATE); its restore runs after the first fit, so the
  // sim hooks of the files below are set by then. Later scripts add their parts through C4PM_VIEWSTATE.part.
  'viewState.js',
  // Phase 25 (UI12, b762): present mode (hooks present / presentKey of C4PM_SIM), after the panel; reads C4PM_SIMSTRIP.stepRect.
  'sim-present.js',
  // Phase 25 (UI13, b763): the sequence drawer under the map (hook seq; reads C4PM_SIMSTRIP to refit the map).
  'sim-sequence.js',
  // Phase 30 (SV8, b795): the live refresh of a served page (api/wait long-poll, reload, the status light); does nothing without window.C4PM_LIVE (static page). Last: it reads C4PM_VIEWSTATE and the dirty checks the files above registered.
  'live.js',
  // b914: the Export section of the gear popup of a served page (POST api/export); after live.js, does nothing without window.C4PM_LIVE.
  'live-export.js',
];

// Phase 30 SV4 (b791): the scripts of the page shell (renderViewShell, c4pm serve), in its /*C4PM_SCRIPTS*/ slot instead of
// VIEWER_SCRIPTS. Never in the static page. serve-boot.js loads the viewer scripts from viewer.js after api/boot answers.
export const SHELL_SCRIPTS = ['serve-boot.js'];

// Phase 35 C (b945): the scripts every page (static and shell) holds at the very start of its script block (slot /*C4PM_PRELUDE*/):
// store.js (C4PM_STORE: saved settings, new c4mp.* keys with the old c4pm.* read) and brand.js (C4PM_BRAND: the loading spinner).
// Before the inline scripts of index.html and before VIEWER_SCRIPTS / SHELL_SCRIPTS; in no other list.
export const PRELUDE_SCRIPTS = ['store.js', 'brand.js'];

// P16-B18: board styles, appended after style.css into the same /*C4PM_STYLE*/ slot.
const VIEWER_STYLES = [
  'board-drawer.css', 'board-panel.css', 'board-list.css', 'board-kanban.css', 'board-timeline.css', 'board-dashboard.css',
  // Phase 25 (UI4, b754): every simulation class (the sim-*.js scripts add theirs to this one sheet)
  'sim.css',
  // P2: the panel sheet goes last: panel.js used to append it at runtime, after every other sheet.
  'panel.css',
];

/**
 * Render the ViewModel as a complete, self-contained HTML file.
 * Reads index.html, style.css, edit.js, map.js, panel.js and inlines everything.
 * Replaces placeholders with actual content.
 */
export function renderViewHtml(model: ViewModel, render: PageRenderOptions = {}): string {
  return renderDataHtml(JSON.stringify(pageData(model)), render);
}

/** b914 / b61: how the page is rendered from its data. noSource: leave out every function and method source (ViewNode.code) and the absolute repo path. */
export interface PageRenderOptions {
  noSource?: boolean;
}

/**
 * b914 / b61: the page data without function and method source. Deletes `ViewNode.code` on every node of the arch, IO
 * and storage trees (subregions too) and replaces `repoPath` (the user's absolute folder, K 2026-11-23) with '' - the
 * viewer reads '' as "no absolute path" (no VS Code links, '.' in copied commands). CHANGES the object it is given
 * (its one caller passes a fresh JSON.parse result) and returns it. Kept on purpose, they are not source: planBlock
 * (the .c4 text of a node), files[].lines (plan files only), history (commit messages), planned signature/purpose,
 * relative file paths and line numbers.
 */
export function withoutSource(data: ViewModel): ViewModel {
  for (const [, root] of viewRoots(data)) {
    forEachNode(root, (n) => { delete n.code; });
  }
  data.repoPath = '';
  return data;
}

/**
 * b914: the static page of one page data JSON (`JSON.stringify(pageData(model))`: renderViewHtml's, or the live model's
 * dataJson), never parsed again unless noSource.
 */
export function renderDataHtml(dataJson: string, render: PageRenderOptions = {}): string {
  // SV4 (b791): the template, styles and scripts as the shell has them (renderPage); only the data slot differs.
  const json = render.noSource ? JSON.stringify(withoutSource(JSON.parse(dataJson) as ViewModel)) : dataJson;
  // Escape < to prevent </script> from breaking out of the script context
  let safe = json.replace(/</g, '\\u003c');
  // Escape U+2028 and U+2029 (line/paragraph separators) for proper JSON parsing
  safe = safe.replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028');
  safe = safe.replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  const out = renderPage(safe, viewerScriptText());
  log('view', 'rendered html', { bytes: out.length, dataBytes: safe.length, noSource: !!render.noSource });
  return out;
}

/**
 * SV4 (b791): the one page data object, `window.C4PM_DATA` of the static page and `data` of `api/boot` (c4pm serve).
 * b142: the kind words ride along (C4PM_DATA.kindWords); W10 (b306): so does the wireframe rule table (C4PM_DATA.wireframeRules, C2);
 * P33: and the build that made the page (C4PM_DATA.toolVersion, e.g. c4pm@0.8.2; the settings popup shows it).
 */
export function pageData(model: ViewModel): object {
  return { ...model, kindWords: buildKindWords(), wireframeRules: wireframeRules(), toolVersion: TOOL_VERSION };
}

/** The text of these viewer files, read from viewerDir() and joined in the given order. A missing file throws. */
function viewerFilesText(files: readonly string[]): string {
  const vdir = viewerDir();
  return files.map(f => fs.readFileSync(path.join(vdir, f), 'utf8')).join('\n');
}

/**
 * SV4 (b791): VIEWER_SCRIPTS joined in order: what the static page inlines, and what c4pm serve sends as `viewer.js`.
 * P14-G1: fixed concatenation order. A missing file must throw (no existence check).
 * P13-T3a: tree.js (left panel) goes after map.js because it needs window.C4PM_MAP.
 */
export function viewerScriptText(): string {
  return viewerFilesText(VIEWER_SCRIPTS);
}

/**
 * SV4 (b791): the page without data, for c4pm serve: the same template, generator and styles as the static page, the data
 * slot `null` and the scripts slot = SHELL_SCRIPTS (serve-boot.js fetches `api/boot`, sets C4PM_DATA, then loads viewer.js).
 */
export function renderViewShell(): string {
  return renderPage('null', viewerFilesText(SHELL_SCRIPTS));
}

/** index.html filled: generator, style.css + VIEWER_STYLES, the data JSON (already safe inside a script tag), the scripts. */
function renderPage(dataJson: string, scripts: string): string {
  const vdir = viewerDir();
  const html = fs.readFileSync(path.join(vdir, 'index.html'), 'utf8');
  // A missing style file must throw too (same rule as the scripts).
  const style = [fs.readFileSync(path.join(vdir, 'style.css'), 'utf8'), ...VIEWER_STYLES.map(f => fs.readFileSync(path.join(vdir, f), 'utf8'))].join('\n');
  return fillTemplate(html, [
    // P33: <meta name="generator"> attribute value, escaped for a double-quoted attribute
    ['/*C4PM_GENERATOR*/', TOOL_VERSION.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`)],
    ['/*C4PM_STYLE*/', style],
    ['/*C4PM_DATA*/null', dataJson],
    // Phase 35 C (b945): store.js and brand.js first in the script block, before the inline scripts of index.html and the viewer scripts.
    ['/*C4PM_PRELUDE*/', viewerFilesText(PRELUDE_SCRIPTS)],
    ['/*C4PM_SCRIPTS*/', scripts],
  ]);
}

/**
 * Substitute each placeholder exactly once, in one left-to-right pass over the ORIGINAL template.
 * Inserted text is never re-scanned (so a value that itself contains a later placeholder, e.g. the
 * scanned repo is C4PM and its source holds these literals, cannot be hit) and is never pattern-
 * interpreted (no `$&`, `$'`, `$$` handling as with String.replace). P13-BUG-html-inject.
 * Placeholders must each occur exactly once in the template, in the order given.
 */
export function fillTemplate(template: string, subs: Array<[string, string]>): string {
  const parts: string[] = [];
  let pos = 0;
  for (const [placeholder, value] of subs) {
    const at = template.indexOf(placeholder, pos);
    if (at < 0) throw new Error(`Template placeholder not found (or out of order): ${placeholder}`);
    if (template.indexOf(placeholder, at + placeholder.length) >= 0) {
      throw new Error(`Template placeholder occurs more than once: ${placeholder}`);
    }
    parts.push(template.slice(pos, at), value);
    pos = at + placeholder.length;
  }
  parts.push(template.slice(pos));
  return parts.join('');
}

export interface BuildViewOptions {
  repo: string;
  config?: Partial<C4pmConfig>;
  from?: string | null;
  store?: string;
  sprint?: string | null;
}

/**
 * P14-T5c: make the header sentence agree with the container chip. The snapshot counts SCANNED
 * containers; the chip counts rendered container nodes (plan-only containers add, merged ones don't).
 * Replaces the first "<n> container(s)" in model.summary with the rendered count; other numbers stay.
 */
export function withRenderedContainerCount(model: ViewModel): ViewModel {
  let n = 0;
  (function walk(node: ViewNode): void {
    if (node.kind === 'container') n++;
    for (const c of node.children ?? []) walk(c);
  })(model.root);
  const summary = model.summary.replace(/\b\d+ containers?\b/, `${n} ${n === 1 ? 'container' : 'containers'}`);
  return summary === model.summary ? model : { ...model, summary };
}

/**
 * UI2 (b752), B1 rule 1 (Document/Roadmap/Phase25/UI_TASKS.md): what the page looks up for a resolved s-item ref. A plan
 * hit: its uid, then its code key (`file#name`, the scanned node) and its fqn (a ghost node's id, or a node's planId); a
 * code hit: its `file#name` key only; missing: null.
 */
function keysOfHit(hit: SimTargetHit): SimRefKeys | null {
  if (hit.kind === 'plan') {
    return { uid: hit.el.metadata[UID_KEY] ?? null, ids: [...(hit.code ? [hit.code] : []), hit.el.id] };
  }
  if (hit.kind === 'code') return { uid: null, ids: [hit.key] };
  return null;
}

/**
 * Build a complete view model, laid out, ready for the page (SV4, b791: buildView renders it; c4pm serve sends pageData of it).
 * Also returns the inputs the "changed since read" stamps are made from: the plan texts and the board file text.
 * Orchestrates the full pipeline:
 *   1. Project & scan: openProject, findPlan, scanWithPlan (write:false, quiet:true, the calls of the test files; every
 *      call when an s-item has a function -> function step pair, T8)
 *   2. collectFindings (plan + wireframe + board + sim findings, the wireframe load the IO view draws (W7), the storage
 *      read, the board and the s-items)
 *   3. buildViewModel with the summary line (repo name from the scan's meta), the tests binding (Query testsBinding) and the wireframes
 *   4. if from: Project & scan driftFrom (the stored snapshot by ref, compared with the scan), applyDrift
 *   5. if .c4 files exist: applyFindings
 *   6. the IO-view tree (buildNavView) and, with a store in the plan, the storage-view tree (buildStorageView)
 *   7. if the project has s-items: buildViewSims (model.sims, refs resolved by the engine's resolveSimTarget; UI2)
 *   8. if the repo has a board: attachBoard
 *   9. layoutView
 */
export function buildPageModel(opts: BuildViewOptions): { model: ViewModel; inputs: { planTexts: Map<string, string>; boardText: string | null } } {
  // b506 (rows G1, G2): Project & scan opens the project, reads the plan and scans once, as the Query layer does.
  // Errors (config, plan, scan) reach the caller unchanged.
  const { config, project } = openProject(opts.repo, opts.config);

  // Parse the plan up front (if any .c4 files exist), before building the snapshot. P6-T9's
  // claim-mode Component[] construction lives in snapshot/build.ts's buildSnapshot, which only
  // runs when a Plan is passed in -- runSnapshot (pipeline.ts) never built one on its own, so a
  // claim-mode plan's components never reached the Snapshot in production CLI use (verified via
  // an actual `view` run: plan-declared components were simply absent from snapshot.components,
  // even though the plan's containers rendered via buildViewModel's own union logic). P6-T11 closes
  // that gap by parsing the plan here and threading it into runSnapshot, which forwards it to
  // buildSnapshot exactly as P6-T9's direct buildSnapshot(input, plan) tests already exercise.
  const found = findPlan(opts.repo, config);
  const plan = found.plan ?? null;

  // Run current snapshot. Phase 26 (A1): calls of the role-test files, for the test attachment (c4/testAttach.ts).
  // T8 (Q6): every call when an s-item has a function -> function step pair (true covers 'tests').
  const snapshot = scanWithPlan(opts.repo, config, plan ?? undefined, { collectCalls: needsCallIndex(project, plan) || 'tests' });

  // Build summary line from snapshot stats; the repo name is the scan's own meta (readMeta of the same repo)
  const meta = snapshot.meta;
  const s = snapshot.stats;
  const unresolvedCount = s.unresolvedImports || 0;
  const summaryLine = `${meta.repoName} — ${s.containers} containers, ${s.components} components, ${s.files} files, ${s.codeElements} code elements, ${s.componentEdges} component edges, ${unresolvedCount} unresolved import${unresolvedCount !== 1 ? 's' : ''}`;

  // P13-T2b: .c4 text for ViewNode.planBlock. buildViewModel is pure, so the disk read happens here.
  // Plan file paths are repo-relative and may start with '../'. Unreadable file -> skipped + logged.
  const planTexts = new Map<string, string>();
  for (const f of plan?.files ?? []) {
    try {
      planTexts.set(f, fs.readFileSync(path.join(opts.repo, f), 'utf8'));
    } catch (err) {
      log('view', 'plan text not readable', { file: f, error: (err as Error)?.message });
    }
  }

  // SV4 (b791): the board file text, for the "changed since read" stamp of c4pm serve. Read before collectFindings reads the
  // board, so a write in between makes the stamp older than the page data (a save is refused, never let through on old data).
  // No project or no board file: null.
  const boardText = project ? readBoardText(boardFileFor(project)) : null;

  // Findings: one collector for plan + wireframes + board (src/check/collect.ts), shared with check, MCP and status.
  // W7 (b303): before the model, so the IO view draws the wireframe files the rules read (one load). It does not read the model.
  const collected = collectFindings(opts.repo, project, plan ?? null, snapshot, {
    sprint: opts.sprint ?? config.sprint ?? undefined,
    today: todayIso(),
    planDir: found.dir,
    config,
  });
  const load = collected.wireframes;   // null without a plan

  // Build view model
  let model = withRenderedContainerCount(
    buildViewModel(snapshot, summaryLine, plan ?? undefined, plan ? planTexts : undefined, {
      // Phase 26 (T26-10): tests on the map; run commands from the runner of each test file's container (D12)
      tests: {
        config: config.tests,
        runnerOf: testsBinding(snapshot, config).runnerOf,
      },
      wireframes: load && load.status === 'ok' ? load.files : undefined,
      planTitle: true,   // C1 A3 (b830): the map and header name the system after the plan (the summary line keeps the repo name)
    }),
  );

  // Apply drift if from is specified
  if (opts.from) {
    // b507 (row G3): Project & scan loads the stored snapshot and compares it with this scan. The store is the one the
    // caller passes, else the legacy ~/.c4pm/store (question b497).
    const store = opts.store ?? legacyStoreDir();
    const { entry: fromEntry, diff } = driftFrom(store, opts.from, snapshot);

    const date = (fromEntry.commitDate ?? fromEntry.createdAt).slice(0, 10);
    const commit = fromEntry.commit ? fromEntry.commit.slice(0, 7) : 'no-git';
    const fromLabel = `${opts.from} ${commit} (${date})`;
    model = applyDrift(model, diff, fromLabel);
  }

  // Apply plan findings if .c4 files exist
  if (plan) model = applyFindings(model, collected.plan);

  // b130: the IO-view tree is built before the board so a b-item linked to a screen uid resolves (attachBoard indexes it)
  if (model.nav) model.navView = buildNavView(model.nav);
  // STOR-5w (b609): the storage-view tree, from the one storage read the storage rules used (collected.storage); also before
  // the board, so a b-item linked to a store, record or field uid resolves. No store in the plan: no storageView (page unchanged).
  if (plan && collected.storage) {
    const sv = buildStorageView(plan, collected.storage);
    if (sv) model.storageView = sv;
  }
  // UI2 (b752): the s-items of the page (src/view/simModel.ts), every step resolved on the server in the three trees, so
  // after the storage view; before the board (attachBoard does not read them). collectFindings loaded and checked them
  // once (simData, sims); the refs resolve with the check's own resolver. No sim/ or no readable s-item: no sims key.
  if (project && collected.simData && collected.simData.length) {
    const code = callIndex(snapshot).elements;
    const sims = buildViewSims(model, {
      items: collected.simData,
      findings: collected.sims,
      fileOf: (id) => path.relative(opts.repo, simFileFor(project, id)).split(path.sep).join('/'),
      keysOf: (ref) => keysOfHit(resolveSimTarget(ref, plan, code)),
    });
    if (sims.length) model.sims = sims;
    log('view', 'sims', { items: sims.length, steps: sims.reduce((n, s) => n + s.steps.length, 0) });
  }

  // P16-B18: the board (if the repo has a board file). One entry point, shared with `c4pm check`. After
  // applyFindings (the links read node.findings), before layoutView.
  if (collected.boardData) model = attachBoard(model, collected.boardData, collected.board);

  // Layout the view
  model = layoutView(model);

  return { model, inputs: { planTexts, boardText } };
}

/** SV4 (b791): the board file text; a missing file is null, an unreadable one is null and logged (loadBoard reports it). */
function readBoardText(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('view', 'board text not readable', { file, error: (err as Error)?.message });
    return null;
  }
}

/** The page model (buildPageModel) rendered as the static page (renderViewHtml): what `c4pm view` writes. */
export function buildView(opts: BuildViewOptions, render: PageRenderOptions = {}): { model: ViewModel; html: string } {
  const { model } = buildPageModel(opts);
  return { model, html: renderViewHtml(model, render) };
}
