export type ElementKind = 'function' | 'class' | 'method' | 'type' | 'test';   // 'test': Phase 26 test case (T26-4/-5 detect it)

export interface CodeElement {
  name: string;        // 'makeOrder', 'OrderService', 'OrderService.create'
  kind: ElementKind;
  startLine: number;   // 1-based
  endLine: number;     // 1-based, inclusive
  lineCount: number;   // endLine - startLine + 1
  stub?: StubKind;     // set only when the body is not implemented
  signature?: string;  // P14-L4-1: declaration text; filled only by P14-L4-7b
  hash?: string;       // b568: content hash of lines startLine..endLine (parseCache addContentHashes); absent in old snapshots
}

/**
 * b782/b787: a named function declared inside the body of a function or method (or of another nested one), named
 * `<parent>.<name>`. A target of outline / find / show / link / check / edit only: never a map element, never a call
 * owner, not in ownership (owner lookups use `outer`).
 */
export interface NestedElement extends CodeElement {
  parent: string;   // name of the element or nested function it sits in directly ('build', 'Box.open', 'build.renderNode')
  outer: string;    // name of the element of `elements` that holds it
}

export interface FileOutline {
  file: string;        // repo-relative
  lineCount: number;
  parseError: boolean;
  elements: CodeElement[];   // sorted by startLine, then name
  fileOnly?: true;   // listed without parsing (no functions, no imports)
  testBlocks?: TestBlock[];   // Phase 26 (T26-4): role-test files only, when they have describe blocks or hooks; sorted by startLine
  nested?: NestedElement[];   // b782: functions declared inside function bodies, sorted by startLine then name; absent when none
  hash?: string;       // b568: content hash of the whole file (parseCache addContentHashes); absent in old snapshots
}

/**
 * Phase 26 (T26-4): a describe block or a hook of a test file, by the lines of its callback. With the case elements
 * (kind 'test') it tells which `<module>` calls are setup of which case: a hook or describe-level call covers the
 * cases inside the innermost describe block holding it (the whole file when none does).
 */
export interface TestBlock {
  kind: 'describe' | 'beforeAll' | 'beforeEach' | 'afterAll' | 'afterEach';
  name: string;        // describe: its chain 'a › b' (the prefix of its case names); hook: the chain it sits in, '' at file level
  startLine: number;   // 1-based
  endLine: number;     // 1-based, inclusive
}

// ---------- Phase 8: function-level calls (TypeScript / JavaScript) ----------

/** One call site. `caller` is the nearest enclosing named element ('run', 'Order.total') or '<module>'. */
export interface RawCall {
  caller: string;
  line: number;           // 1-based
  callee: string | null;  // as written: 'foo', 'obj.m', 'this.m', 'a.b.c'; null when not a name chain
  /** b682: 1-based line and UTF-16 column of the called name (the last segment: `old` in `a.b.old()`); absent when
   *  callee is null. `line` stays the start of the call expression. */
  at?: { line: number; column: number };
}

/** `import { imported as local } from 'spec'`; imported is the exported name, 'default' or '*' (namespace). */
export interface ImportBinding {
  local: string;
  imported: string;
  spec: string;
  target?: string;        // internal import only: repo-relative file (set by the pipeline from the import resolver)
  external?: true;        // external package or node builtin (set by the pipeline)
  typeOnly?: true;        // Phase 26: `import type { X }` or `import { type X }`; never reach (D3)
  /** b682: 1-based line and UTF-16 column of the imported name as written (`old` in `import { old as x }`, the key in
   *  `const { old: x } = require()`); absent for 'default' and '*'. */
  at?: { line: number; column: number };
}

/** `const x = new Foo()` : x is an instance of the class Foo. */
export interface InstanceBinding { name: string; className: string; }

/**
 * Phase 26: a value use of an imported name outside callee position (`expect(fn)`, `new Foo()`, `{ fn }`). `name` is
 * written like RawCall.callee: the import's local name, or the member chain it heads (`ns.fn`). b682: the same shape
 * for value uses of the file's own names (FileCalls.ownUses); `column` (1-based, UTF-16) is the use's first identifier.
 */
export interface ImportUse { name: string; line: number; column: number; }

/** Phase 26 (D5): `jest.mock('spec')` / `vi.mock` / `jest.doMock`: the module a test replaces. */
export interface ImportMock {
  spec: string;           // first argument as written
  target?: string;        // internal module only: repo-relative file (set by the pipeline from the import resolver)
  line: number;           // 1-based
}

/**
 * Phase 26 (T26-8, D6/D17): a string literal that may name a repo file (`'viewer/panel.js'`, `'../viewer/panel.js'`):
 * it contains a `/` or ends in a file extension. The test attachment counts it as file reach only when it is exactly a
 * scanned path (as written from the repo root, or relative to the file's folder); no build-output mapping.
 * T26-8b (D22): and only when it goes into a file/path/process call (`call`), or into a test helper whose parameter
 * does (`args`, judged by the reader against FileCalls.pathParams). Neither set = a data string, never reach.
 */
export interface PathLiteral {
  value: string;
  line: number;
  /** The file/path/process call it is an argument of (`fs.readFileSync`, `path.join`, `child_process.spawnSync`,
   *  `require.resolve`), directly or through the variable it initialises. */
  call?: string;
  /** Otherwise: the calls it is argument `index` of (`callee` and `line` as in RawCall), directly or through its variable. */
  args?: { callee: string; line: number; index: number }[];
}

/** Phase 26 (T26-8b): parameter `index` of function or method `fn` (outline name) goes into file/path/process call `call`. */
export interface PathParam { fn: string; index: number; call: string; }

export interface FileCalls {
  file: string;
  bindings: ImportBinding[];
  instances: InstanceBinding[];
  calls: RawCall[];
  uses?: ImportUse[];     // Phase 26: set when there are some
  /** b682: value uses of the file's own top-level function and class names (same rules as `uses`, shadowing
   *  respected); set when there are some. Not read by the test attachment. */
  ownUses?: ImportUse[];
  mocks?: ImportMock[];   // Phase 26: set when there are some
  pathLiterals?: PathLiteral[];   // Phase 26 (T26-8): set when there are some
  pathParams?: PathParam[];       // Phase 26 (T26-8b): set when there are some
}

export type ImportKind = 'import' | 'export-from' | 'require' | 'dynamic';

export interface RawImport {
  spec: string;        // exactly as written: '../models/order', 'express'
  kind: ImportKind;
  line: number;        // 1-based
}

export type ImportStatus = 'internal' | 'external' | 'asset' | 'unresolved';

export interface ResolveResult {
  status: ImportStatus;
  target?: string;     // internal only: repo-relative file path
  /** internal only, when one spec means several files (C# `using N`: every file declaring N); sorted, `target` is the first.
   *  Never stored: the pipeline writes one ImportRecord (and one file edge) per target (storedResults). */
  targets?: string[];
  pkg?: string;        // external only: 'express', '@scope/name', 'fs'
  reason?: string;     // unresolved only: why, for the debug log and reason counts; never stored (runSnapshot drops it)
}

export interface ImportRecord extends RawImport, ResolveResult {}

export interface FileImports {
  file: string;
  language?: string;         // id of the language handler that read the file (set by the pipeline; file-only files have no entry)
  imports: ImportRecord[];   // sorted by line, then spec
}

export interface Container {
  id: string;          // 'task-service'
  name: string;        // 'Task Service'
  path: string;        // repo-relative dir; '.' when the repo root is the container
  tech: string;        // 'Node.js', 'Node.js / TypeScript', 'Python', ..., 'Unknown'
  manifest: string | null;
}

export interface Component {
  id: string;          // `${containerId}/${folderId}` or `${containerId}/_root`
  name: string;        // 'Services' or 'Root files'
  containerId: string;
  path: string;        // repo-relative dir the component covers
  files: string[];     // sorted
  mode?: 'folder' | 'claim';   // undefined treated as 'folder'
  claims?: Claim[];            // claim-mode only
  source?: string;             // .c4 file path this component was declared in; claim-mode only
  io?: IoCard;           // b128: IO view only; the card drawn inside this (leaf) node instead of a plain box
  meta?: { status?: string; owner?: string; sprint?: string; priority?: string; tags?: string };  // claim-mode only, from PlanElement.metadata
}

export interface FileEdge { from: string; to: string; }
export interface ComponentEdge { from: string; to: string; weight: number; }

export interface GitInfo { commit: string; branch: string; date: string; depth: number; }   // date = commit date, ISO 8601; depth = git rev-list --count <commit>

export interface SnapshotMeta {
  tool: string;        // TOOL_VERSION
  repoPath: string;    // absolute
  repoName: string;
  createdAt: string;   // ISO 8601; the only non-deterministic field
  git: GitInfo | null;
}

/** Phase 26: role of a scanned file. Written only for test files (config `tests.globs`); absent = source. */
export type FileRole = 'test';

export interface SnapshotFile extends FileOutline {
  componentId: string;   // claim owner / folder component; a role-test file keeps it, or 'unassigned' when in none (T26-14b)
  role?: FileRole;       // Phase 26: 'test' for test files only; absent = source (old snapshots have none)
}
export interface ExternalUse { pkg: string; usedBy: string[]; }   // component ids

export interface SnapshotStats {
  containers: number;
  components: number;
  files: number;
  codeElements: number;
  componentEdges: number;
  unresolvedImports: number;
}

export interface Snapshot {
  schemaVersion: 2;
  meta: SnapshotMeta;
  system: { id: string; name: string };
  containers: Container[];      // sorted by id
  components: Component[];      // sorted by id
  files: SnapshotFile[];        // sorted by file
  componentEdges: ComponentEdge[];  // sorted by from, then to
  fileEdges: FileEdge[];        // sorted by from, then to; file-level internal import edges (P6-T7b) — same-component edges included, unlike componentEdges which drops them
  externals: ExternalUse[];     // sorted by pkg
  stats: SnapshotStats;
  /** P8: raw call sites per file; set only when runSnapshot got collectCalls, never written to disk (snapshot.json, history).
   *  With collectCalls 'tests' (Phase 26) only role-test files have an entry: such a snapshot never feeds callsOf/callersOf. */
  calls?: FileCalls[];
  /** b467: every file's import records (line, spec, resolved target), for `deps --files`; in memory only, like `calls`:
   *  never written to snapshot.json or history. */
  imports?: FileImports[];
}

export interface BuildInput {
  meta: SnapshotMeta;
  containers: Container[];
  components: Component[];
  outlines: FileOutline[];
  imports: FileImports[];
  componentEdges: ComponentEdge[];
  fileEdges: FileEdge[];
  testFiles?: string[];   // Phase 26: repo-relative files with role 'test' (pipeline, config `tests.globs`); absent = none
}

// ---------- Phase 3: .c4 plans ----------

export type StubKind = 'empty' | 'todo' | 'throws' | 'returns-nothing';
export type PlanStatus = 'planned' | 'in-progress' | 'done' | 'abandoned';

/** b273: the three views. arch = architecture family, io = frontend family (screens, flows), storage = storage family (plan/kinds.ts). */
export type ViewName = 'arch' | 'io' | 'storage';

// file = repo-relative .c4 path. endLine (P13-T2b): PlanElement.source only -- the closing-brace line
// (== line for one-line elements). Optional so relations and hand-built fixtures stay valid.
export interface SourcePos { file: string; line: number; endLine?: number; }

export interface PlanLink {
  raw: string;                   // exactly as written: './index.ts#L6-L13'
  path: string;                  // repo-relative, resolved against the .c4 file's folder; folders end with '/'
  name: string | null;           // '#issueToken' → 'issueToken'; '#OrderService.create' → 'OrderService.create'
  lines: { start: number; end: number } | null;   // '#L6-L13'
  title: string | null;          // optional quoted title after the link
}

export interface PlanElement {
  id: string;                    // fully qualified: 'phofast.api.auth'
  kind: string;                  // 'person' | 'system' | 'container' | 'component' | any spec kind
  title: string;
  description: string | null;
  technology: string | null;
  links: PlanLink[];
  metadata: Record<string, string>;
  parent: string | null;         // fqn of parent element
  source: SourcePos;
  /** Phase 26 (T26-13, D16): `test` blocks of the element, in text order; absent when none (plan JSON stays byte-equal). */
  tests?: PlanTest[];
}

/**
 * Phase 26 (T26-13, D15/D16): a `test 'name' { [case '<id>'] }` block, an accessory of its parent element (no uid, no
 * tree node, no board link). `case` null = a test to write; else a hand link: a test case id (`file#describe › name`)
 * or a role-test helper file. `source` = the block's first and last line.
 */
export interface PlanTest { name: string; case: string | null; source: SourcePos }

export interface PlanRelation { from: string; to: string; label: string | null; source: SourcePos; }
export interface ParseIssue { file: string; line: number; message: string; }

export interface Plan {
  files: string[];               // repo-relative .c4 files, sorted
  elements: PlanElement[];       // sorted by id
  relations: PlanRelation[];     // in file order
  issues: ParseIssue[];
}

/**
 * One element that can be looked up (util/lookup.ts lookupElement; plan/planItems.ts). `uid` is optional (old plans may
 * not have it yet). b484: moved here from query/lookup.ts (now util/lookup.ts, b500), which re-exports it.
 */
export interface LookupItem {
  uid?: string;
  id: string;
  fqn?: string;
  title: string;
  level: string;
}

/**
 * Why a target names no single plan element (T4a, b698: moved from services/boardEdit.ts). resolvePlanTarget gives
 * none / ambiguous; board link adds no-plan and no-uid.
 */
export type UnresolvedTarget =
  | { kind: 'unresolved'; reason: 'no-plan' }
  | { kind: 'unresolved'; reason: 'none'; closest: LookupItem[] }
  | { kind: 'unresolved'; reason: 'ambiguous'; matches: LookupItem[] }
  | { kind: 'unresolved'; reason: 'no-uid'; item: LookupItem };

export interface ResolvedLink {
  elementId: string;
  link: PlanLink;
  exists: boolean;               // file or folder exists on disk
  target: 'file' | 'folder' | 'function' | 'lines';
  range: { start: number; end: number } | null;   // for function/lines links when resolvable
  found: boolean;                // function links: name found in the file's outline (false otherwise)
}

export interface PlanFinding {
  severity: Severity;
  rule: string;                  // §4
  id: string;                    // element fqn, or file path for unplanned-code
  message: string;
}

/**
 * plan move / rename: old -> new fqn of every moved or renamed root and of each of its descendants (prefix rule R1).
 * Built by c4/planMove.ts fqnMapOf. b512 (ARR-EN-1, row N5): moved here from c4/planMove.ts.
 */
export interface FqnMap {
  map: Map<string, string>;                 // old -> new: each root and every descendant
  rewrite(ref: string): string | null;      // prefix rule; null = not affected
}

/**
 * One wireframe file to rename and/or rewrite (c4/wireframeMove.ts); paths repo-relative. `from === to` = content edit
 * only. b512 (ARR-EN-1, row N5): moved here from c4/wireframeMove.ts.
 * W9 (b305): `create` = a new file (plan wireframe): `from === to`, `oldText` '', the file must not exist yet and
 * commitPlanEdit makes the io/ folder when it is missing.
 */
export interface WireframeEdit { from: string; to: string; oldText: string; newText: string; create?: true }

// ---------- Phase 2: comparison + history ----------

export type Severity = 'critical' | 'warning' | 'info';
export type ChangeType = 'health' | 'container' | 'component' | 'file' | 'element' | 'edge' | 'cycle' | 'external';
export type ChangeKind = 'added' | 'removed' | 'renamed' | 'modified';

// id per type: component id | file path | `${file}#${name}` | `${from} -> ${to}` | cycle key | package | health metric
export interface RawChange {
  type: ChangeType;
  kind: ChangeKind;
  id: string;
  renamedFrom?: string;       // kind 'renamed' only
  before?: number;            // lines (component/file/element), weight (edge), count (health)
  after?: number;
  elementKind?: ElementKind;  // type 'element' only
}

export interface Change extends RawChange {
  severity: Severity;
  rule: string;               // e.g. 'component-grew'
}

export interface DiffSummary {
  componentsAdded: number; componentsRemoved: number; componentsRenamed: number; componentsModified: number;
  filesAdded: number; filesRemoved: number; filesRenamed: number; filesModified: number;
  elementsAdded: number; elementsRemoved: number; elementsModified: number;
  edgesAdded: number; edgesRemoved: number;
  cyclesAdded: number; cyclesRemoved: number;
  linesBefore: number; linesAfter: number;
}

export interface DiffEndpoint {
  repoName: string;
  createdAt: string;
  commit: string | null;
  commitDate: string | null;
}

export interface SnapshotDiff {
  schemaVersion: 1;
  from: DiffEndpoint;
  to: DiffEndpoint;
  summary: DiffSummary;
  changes: Change[];          // sorted: SEVERITY_ORDER, then TYPE_ORDER, then id
}

export interface HistoryEntry {
  id: string;                 // `${compactDate}--${commit7 | 'nogit'}`
  file: string;               // `${id}.json`, relative to the history dir
  createdAt: string;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  depth: number | null;       // git rev-list --count <commit>; null if no git
  stats: SnapshotStats;
}

export interface Manifest {
  repoId: string;
  repoName: string;
  entries: HistoryEntry[];    // sorted by depth (entries with a depth first, ascending), then time (commitDate ?? createdAt), then id (saveLocked, history/store.ts)
}

/** The folders and files of one project (resolvePaths in src/paths.ts computes them; nothing here touches the disk). */
export interface ProjectPaths {
  anchor: string;
  internalDir: string;
  projectDir: string;
  dataDir: string;
  historyDir: string;
  planDir: string;
  exportDir: string;
  viewFile: string;
  configFile: string;
  repoId: string;
}

// ---------- Phase 4: config + languages ----------

export type FailOn = 'critical' | 'warning' | 'none';

export interface C4pmConfig {
  languages: string[];          // language ids from LANGUAGE_IDS; default ['typescript'] (covers .ts/.tsx/.js/.jsx/…)
  ignore: string[];             // repo-relative folder prefixes, e.g. 'test/fixtures'
  store: string | null;         // history store root; null → <cwd>/out
  sprint: string | null;        // current sprint for `check`, e.g. 'S15'
  failOn: FailOn;               // exit 1 when a finding/change at or above this severity exists
  architectureDir: string | null;   // repo-relative folder generate-c4 writes to by default when no --out given; null = today's out/<repoId>/c4 tool-output default
  viewOnCommit: boolean;        // post-commit hook also refreshes the exported page; read at run time
  fileOnlyExtensions?: string[];   // extensions listed without parsing when languages contains 'files'; undefined = FILE_ONLY_EXTENSIONS
  tests?: TestsConfig;          // Phase 26: test files and test runs; undefined = DEFAULT_TEST_GLOBS (importer/testMatch.ts), no ignoreReach, no command
  layers?: LayersConfig;        // b466: layer direction rules in `c4pm check`; undefined = layer-skip off
}

/** Config key `layers` (b466). */
export interface LayersConfig {
  skip?: boolean;          // turns on the opt-in rule layer-skip in `c4pm check` (off by default; env C4PM_LAYERS_SKIP)
}

/** Config key `tests` (Phase 26). Patterns use the ignore syntax (folder prefix, file path or glob * ** ?), repo-relative. */
export interface TestsConfig {
  globs?: string[];        // files that are tests; replaces the defaults when set (env C4PM_TESTS, flag --tests)
  ignoreReach?: string[];  // files whose calls never lift a test case to a higher c-item (D3)
  command?: string;        // run-command template with {file}, {name}, {nameRegex}; wins over the detected runner (D12, T26-9)
  noTests?: boolean;       // T26-13 (D11): turn on the info rule no-tests in `c4pm check` (off by default)
}

/** Phase 26 (T26-9): how to run one test case: a shell command, run in `cwd` (repo-relative container root, '.' = repo root). */
export interface RunCommand { command: string; cwd: string }

export interface LanguageHandler {
  id: string;                   // 'typescript' | 'python'
  extensions: string[];
  parse(code: string, file: string): import('tree-sitter').Tree;
  outline(tree: import('tree-sitter').Tree, file: string, code: string): FileOutline;
  imports(tree: import('tree-sitter').Tree): RawImport[];
  /** P8: call sites of one file, from its outline (optional: Python has none). */
  calls?(tree: import('tree-sitter').Tree, outline: FileOutline): FileCalls;
  /** Phase 26: the outline of a role-test file with its test cases added (kind 'test'); run only on role-test files. */
  tests?(tree: import('tree-sitter').Tree, outline: FileOutline): FileOutline;
  createResolver(repoRoot: string, sourceFiles: string[]): (fromFile: string, spec: string) => ResolveResult;
}

// ---------- Phase 5: viewer ----------

export type ViewKind = 'context' | 'system' | 'container' | 'subregion' | 'component' | 'file' | 'function' | 'class' | 'method' | 'type' | 'test' | 'slice' | 'shared' | 'unassigned' | 'person' | 'external' | 'screen' | 'store' | 'record' | 'field';   // store/record/field: storage view only (STOR-5 b338); context: the C1 map root (C1-CTX), not a plan element; subregion: was 'layer' (b456)
export type DriftMark = 'added' | 'grew' | 'shrank' | 'changed' | 'renamed';

/** b142: one kind's words in the viewer (the table is view/kindWords.ts buildKindWords). */
export interface KindWord {
  /** Short chip: left tree row, panel breadcrumb. */
  tag: string;
  /** Region header on the map. Absent = the kind draws no level word there (code kinds). */
  region?: string;
  /** HUD level label. */
  hud: string;
  /** Legend label. Absent = the kind has no legend swatch. */
  legend?: string;
  /** Colour key: a CSS variable name without `--` (c1, c2, subregion, c3, file, fn, cls, person, external, screen, drift-renamed), or 'unassigned' (red fill). */
  color: string;
  /** C1 A1 (b828): a holder kind (the C1 'context'): the viewer never draws it, never hits it, and the tree and breadcrumb show no row for it; its children are the top level. Absent = false. */
  holder?: boolean;
  /**
   * C1 A2 (b829): the kind's KIND_TABLE `needsCode` (src/plan/kinds.ts), on the arch rows of the element kinds. False (subregion,
   * person, external): a plan-only node of the kind shows no "planned (no code yet)" (tree, panel). Absent = true.
   */
  needsCode?: boolean;
}
export type KindWords = Record<ViewName, Record<string, KindWord>>;

export interface ViewFinding { severity: Severity; rule: string; message: string; }

/** P14-T4a: where a system/container/subregion/component box comes from. */
export interface ViewOrigin {
  kind: 'scanned' | 'plan' | 'both' | 'synthetic';
  folder?: string; manifest?: string;                 // scanned side ('.' = repo root)
  planFile?: string; planLine?: number; planEndLine?: number;   // plan side (SourcePos)
  rule?: string;                                      // plain-text explanation
}

/** b128: a generic IO card (a screen today; CLI/API/MCP surfaces later). Rows are data; the viewer draws them. */
export interface IoRow {
  id: string;           // the part's fqn
  kind: string;         // 'region' | 'control' | 'state' on a screen; options | flag | arg | body | param on a command, route or tool (b266); open string
  title: string;
  status?: string;
  depth: number;        // 0 = direct child of the card; indent level
  word?: string;        // b266: display word when the parent kind changes it (a param under a body is 'Field'); absent = the kind's own word
  meta?: Record<string, string>;   // b266: in, type, required of the part, only keys that are set; a param gets `in` by its parent when not set (route: query, body: body)
  nav?: { to: string; label?: string };   // to = target screen fqn; label only when the relation had its own label
}
export interface IoCard {
  kind: string;         // b266: entry kind: screen | command | route | tool
  device?: 'web' | 'phone';   // b266: screens only; absent = a plain card (no device frame)
  method?: string;      // b266: route only: HTTP method (metadata.method, else the title's first word), upper case; absent when unknown
  design?: string;      // metadata.design, untouched (URL or image path)
  viewport?: { w: number; h: number; source: 'device' | 'metadata' };   // W6 (b302): screens only; the frame's layout size (navLayout.ts viewportOf)
  rows: IoRow[];
}

/**
 * Phase 26 (T26-10): the tests of a map node, as indexes into `ViewModel.tests.cases` (C31: ids and counts only).
 * Same lists as `testsOf(ix, id, { children: true, touches: true })` (c4/testAttach.ts) for a c-item of the attachment
 * tree; a grouping node (slice, shared, unassigned, file, subregion) gets the union of the nodes below it, with no `ids`.
 */
export interface ViewTests {
  count: number;         // ids + children: the badge
  ids: number[];         // attached to this node
  children?: number[];   // attached below it; absent when none
  touches?: number[];    // attached elsewhere, touching it or something below it; absent when none
  toWrite?: number[];    // T26-12: tests to write (D16) of the node's plan element and its plan descendants that no case
                          // matches (testsReport), indexes into ViewTestTable.toWrite; nodes with a uid and subregions; absent when none
}

/** Phase 26 (T26-12): a planned test to write: its name and the fqn of the plan element whose `test` block it is. */
export interface ViewPlannedTest { name: string; parent: string }

/** Phase 26 (T26-10): one attached test case of the page (cases with level 'none' are left out). */
export interface ViewTestCase {
  id: string;            // `file#name` (D13); a test file whose cases are not found: the file
  line: number;
  level: 'element' | 'component' | 'container' | 'system';
  runner: number;        // index into ViewTestTable.runners (the container root and language of the test file)
  run?: string;          // command run in that runner's cwd (languages/testRunner.ts); absent when the runner is unknown
}
/** Phase 26 (T26-10): one of the two: `cwd` = container root the commands run in, or `reason` = why there is no command. */
export interface ViewTestRunner { cwd?: string; reason?: string }
export interface ViewTestTable { cases: ViewTestCase[]; runners: ViewTestRunner[]; toWrite?: ViewPlannedTest[] }   // toWrite: absent when none

/**
 * STOR-5 (b338): what a storage-view node carries (ViewNode.storage). origin: plan = the plan lists it and no code matches it (or
 * the store was not read), code = only the code has it, both = matched; a store is always 'plan'. tech: store nodes only, the
 * technology key (storageTechOf), absent for an unknown technology. pk / nullable / unique / fk / onDelete: field nodes, from the
 * code when the code has the field, else from the plan metadata; fk = the FK text `record.field`, kept also when no edge could be
 * drawn. diff: the field-drift kinds of the field, the same union as FieldDiffKind (src/storage/fieldDiff.ts; repeated here because
 * Foundation imports nothing). indexes / checks: record nodes, the code's when the code has the record, else the plan metadata
 * (index.* / check.*); absent when none. Every other key: absent = not set.
 */
export interface ViewStorage {
  origin: 'plan' | 'code' | 'both';
  tech?: string;
  pk?: true;
  nullable?: true;
  unique?: true;
  fk?: string;
  onDelete?: string;
  diff?: ('missing' | 'extra' | 'type' | 'nullable' | 'fk')[];
  indexes?: { name: string; unique: boolean; columns: string[]; where: string | null }[];
  checks?: { name: string; expr: string | null }[];
}

export interface ViewNode {
  id: string;          // 'system' | container id | component id | file path | `${file}#${elementName}`
  kind: ViewKind;
  name: string;          // label: 'Api', 'Services', 'orderService.ts', 'OrderService.create' → shown as 'create' inside its class
  detail: string;        // subtitle: 'Node.js / TypeScript', 'api/src/services', '36 lines'
  weight: number;        // lines of code, >= 1; used for sort order and parent sums only; no longer drives box size (uniform-grid layout since P7-T2)
  children: ViewNode[];  // sorted by weight desc, then id
  subregions?: ViewNode[];   // Phase 28 LK-G: a container's plan subregions in declaration order (first = top): kind 'subregion' nodes with
                          // no children, drawn as a labelled frame around their components. Notation, not a level: they are not
                          // in `children` (walks that want them use nodesBelow, view/tree.ts). Absent when the container has none.
                          // SR2 (b457): an auto frame (no `placed`) has x,y,w,h 0 from the layout and is fitted around its
                          // components by the viewer (edit.js placeFrames); a placed frame gets its rect from layoutTree.
  subregion?: string;    // Phase 28 LK-G: a component child of a container with `subregions`: the id of the subregion it sits in; absent otherwise
  sharedColumn?: true;   // b454: a subregion whose plan element has metadata `shared 'true'` (every other subregion may use it directly):
                          // laid out as a side column right of the stack (arrangeStack), its frame as tall as the stack
                          // (edit.js placeFrames). Only the first shared subregion of a container is the column. Absent otherwise
  x: number; y: number; w: number; h: number;   // world units, filled by layout (0 before). This is the REGION:
                          // the blueprint area this node opens into (children are laid out inside it)
  bubble?: { x: number; y: number; w: number; h: number };   // the small closed shape drawn when the node
                          // is not open, world units, inside the region; filled by layout (Phase 9)
  file?: string;         // repo-relative file (file/function/class/method nodes)
  line?: number;         // start line (function/class/method nodes)
  planId?: string;       // B14: folder mode: fqn of the plan component this scanned component stands for; absent otherwise
  uid?: string;          // P14-T8: plan element metadata uid; system/container/subregion/component nodes only; absent when none
                          // (b130 / STOR-5 b338: also IO-view entries and parts, storage-view stores, records and fields)
  boardCount?: number;   // P16-B17: number of board items (non-archived boards, own links) that link this node; absent when 0
  tests?: ViewTests;     // Phase 26 (T26-10): tests attached to this node or below it, or touching it; absent when none
  stub?: StubKind;
  drift?: DriftMark;
  findings?: ViewFinding[];
  io?: IoCard;           // b128: IO view only; the card drawn in this (leaf) node instead of a plain box
  storage?: ViewStorage; // STOR-5 (b338): storage-view store / record / field nodes only; absent elsewhere
  word?: string;         // b266: IO view app node only: ioContainerWord(technology), 'CLI' | 'API' | 'MCP' | 'App'. A part node (below) carries the word its parent kind gives it ('Field')
  meta?: { status?: string; owner?: string; sprint?: string; priority?: string; tags?: string; in?: string; type?: string; required?: string; shape?: string;
          role?: string };   // role: b908, a component's plan role ('foundation' only; attachFoundation)
                          // shape: C1 C2 (b834), a person's plan `shape` ('robot': a square head; render.js shapePath)
                          // in / type / required: IO view part nodes only (a part is a ViewNode of the entry: id = its fqn, kind = its part kind, name = its title)
                          // STOR-5 (b338) storage view: status = the plan element's status; type = a field's type (the code's when the code has the field)
                          // P13-T2c: claim mode only, only keys present on the plan element's metadata (never invented);
                          // system/container/component nodes. Folder mode: none (tech lives in `detail`)
  savedLayout?: { bx?: number; by?: number; rx: number; ry: number; rw: number; rh: number };
                          // P10-T3: hand-placed layout from the plan element's `layout` metadata, claim mode and
                          // system/container/component nodes only. All values are world units relative to the
                          // PARENT region's top-left (root: absolute); bx/by absent = bubble not hand-placed.
                          // Consumed by layout.ts's applySavedLayout.
                          // P14-I5a: from the two-phase layout on, values are PARENT-LOCAL units (world units divided by the parent's scale), not world units.
                          // SR2 (b457): subregion: rx,ry = top-left of the SLOT centred on the frame, rw,rh = frame size, both
                          // container-local; no bx,by. Read in folder mode too (Q6); a component's only in claim mode.
  autoLayout?: { rx: number; ry: number; rw: number; rh: number };
                          // SR3 (b693): the auto rect (where the layout puts the node with no saved layout anywhere): same
                          // units as savedLayout (parent-local) but not rounded. Set only when it differs from the drawn
                          // rect; absent = the load rect is the auto rect. system/container/component nodes with a parent,
                          // only when the plan has some saved layout (layout.ts attachAutoLayouts). Read by the viewer's Auto arrange.
  bubbleMoved?: boolean; // P10-T3: true when the bubble position came from a saved layout (same meaning as the
                          // viewer's edit.js flag: user-placed, so it is not re-centred on resize)
  placed?: true;         // SR2 (b457): subregion only: hand-placed frame (saved layout or dragged); placeFrames leaves it alone
  headerH?: number;      // world units; header band height layoutNode reserved for this node's
                          // children (only set on nodes with children) — map.js reads this instead
                          // of recomputing its own header-height fraction, so the two can't drift apart.
                          // Phase 28 LK-G: on a subregion, the label band of its frame above its components' slots
  scale?: number;       // P14-I1: world units per local unit of this node's own frame (K_N); absent = 1. Set by layoutTree; read by camera.js (relative zoom) and edit.js
                          // SR2 (b457): a subregion carries its container's scale (its frame is in the container's frame)

  // ---------- Phase 7: viewer v0.3 panel content ----------
  claims?: (Pick<Claim, 'kind' | 'path' | 'fn'> & { ownedCount?: number })[];   // component/slice nodes only, mirrors Component.claims
                          // (the builder currently also leaves elementId/claimIndex on the entries; display uses only the Pick)
                          // P13-T2c ownedCount: functions this claim won (each owned function is counted once, under the
                          // most specific claim of the same component that matches it; ties -> first claim in file order)
  lostClaims?: { path: string; fn: string | null; lostTo: string }[];
                          // P13-T2c: component nodes, claim mode only, only when non-empty. One entry per
                          // OwnershipConflict naming this component as a loser: path = conflict.file,
                          // fn = conflict.fn, lostTo = conflict.winner (an elementId)
  endLine?: number;      // P13-T2c: last line (function/method/class nodes; pairs with `line`)
  source?: string;       // .c4 file path, component nodes only, mirrors Component.source
  code?: string[];       // source lines, function/method nodes only, populated by P7-T3/T4
  history?: { commit: string; date: string; message: string }[];   // component nodes only, populated by P7-T3/T4
  planBlock?: { file: string; startLine: number; endLine: number; lines: string[] };
                          // P13-T2b: the node's own .c4 element text (claim mode, system/container/component nodes
                          // with exactly one plan element); a nested element includes its children's text; lines
                          // capped at 200 (endLine is then the last line included)
  planOnly?: true;       // P14-T44a: plan element with no code yet (folder mode: plan container/component with no scanned match); absent otherwise
                          // storage view (STOR-5w b609, b611): a record or field only in the plan, and a store with no code
                          // (storeHasNoCode, checkStorage's missing-store; a store that could not be read is not)
  planned?: { status: string; signature?: string; purpose?: string; source: SourcePos };   // P14-L4-1: plan annotation on a function/class/method/type node (filled by P14-L4-4-i / 4-ii)
  builtState?: 'planned' | 'built' | 'stub';   // P14-L4-1: whether the code behind this node exists yet (set by P14-L4-4-i / 4-ii)
  origin?: ViewOrigin;   // P14-T4a: system/container/subregion/component nodes only: scanned, plan, or both (a subregion is always 'plan')
  usedBy?: string[];     // P13-T2d: children of the 'shared' node only (claim mode): ids of the components that call
                          // this function (SharedCode.users); [] when none known
  usedByCount?: number;   // b908: a component with meta.role 'foundation' only: distinct component nodes with an edge into it (ViewModel.edges, code + plan relations); absent otherwise
  origins?: { folder: string; files: string[] }[];   // P14-T6b: shared/unassigned nodes: distinct files of the contents grouped by folder ('.' = repo root); folders and files sorted
  emptyFiles?: string[]; // P14-T6b: unassigned node only: source files with 0 parsed functions (never ownable), sorted
  importedBy?: { file: string; owner: string }[];   // P14-T6b: children of the shared node: FILE-level importers that have a claimed owner (component id); differs from `usedBy` (component ids rolled up from SharedCode.users)
  fileOnly?: true;       // P14-T29a: file nodes and claim-mode file slices of files listed without parsing (FileOutline.fileOnly); absent otherwise
  callsAvailable: boolean;   // NOT optional — always false until Phase 8 ships function-level call
                          // tracking; every function/method ViewNode must set this explicitly so the
                          // panel can show an honest placeholder instead of silently having no calls data
}

export interface ViewEdge {
  from: string; to: string; weight: number;   // component ids (IO view: screen fqns; storage view, STOR-5 b338: field ids, from = the FK field)
                          // storage view: label = the FK's onDelete action, absent when none
  label?: string;       // b128: IO view: the distinct labelled nav labels of the pair, joined with ', '. C1 D1 (b835): arch view,
                        // an edge with a person or external (or what one holds) at either end: its first plan relation label
  labelled?: true;      // b128: present only when `label` came from a relation's own label (never the control-title fallback)
  labels?: string[];    // C1 D1 (b835): arch actor edge with more than one distinct label: all of them in plan order (labels[0] = label)
}

/** P13-T2a: one row of the left panel's Files tab. Computed in view/model.ts, never in the browser. */
export interface ViewFile {
  path: string;                  // repo-relative (SnapshotFile.file / Plan.files entry; plan files may start with '../')
  kind: 'source' | 'plan';
  owners: string[];              // ViewNode ids owning code in this file (first-seen order, de-duplicated); [] for plan files
  flag?: 'split' | 'shared' | 'unassigned' | 'test-only' | 'c4';   // Phase 26: 'test-only' = only test-only code (Ownership.testOnly)
  role?: FileRole;               // Phase 26 (T26-10): 'test' for a test file (SnapshotFile.role); absent = source
  lines?: string[];              // P13-T2d: kind 'plan' only, when the caller supplied the file text; capped (Decision 11)
  truncated?: number;            // P13-T2d: lines omitted from `lines` (present only when > 0)
  noFunctions?: true;            // P14-T6b: claim mode source files with 0 parsed functions (such a file can never be owned)
  fileOnly?: true;               // P14-T29a: file listed without parsing (FileOutline.fileOnly)
}

/** P13-T2d: one declared plan relation whose endpoints both resolved to component/container node ids. */
export interface ViewRelation { from: string; to: string; label: string | null; file: string; line: number; }

/** Phase 20 wireframes (C1): one ref of a wireframe file after resolving (data contract WireRef; resolved by c4/wireframeRefs.ts). */
export interface WireRef { ref: string; fqn: string | null; problem?: 'unknown' | 'ambiguous'; candidates?: string[] }

/** Phase 20 wireframes (W1): the rule table the viewer receives (ViewModel.wireframeRules; built by c4/wireframeHtml.ts wireframeRules()). */
export interface WireframeRules {
  css: string[];
  base: string;
  keepTags: string[];
  keepAttrs: string[];
}

/**
 * W6 (b302): the wireframe of one screen, resolved on the server (c4/wireframeRefs.ts wireframeOf). file = repo-relative path;
 * html = the file text with its sheets inlined, absent when the file cannot be used; error = why it cannot be used (then refs is
 * empty and missing lists every region and control of the screen); missing = fqns of regions and controls no ref reached, plan order.
 */
export interface NavWireframe { file: string; html?: string; error?: string; refs: WireRef[]; missing: string[] }

/** P20-T4 (b126): IO view data. Groups, screens and parts follow declaration order. */
export interface NavPart { fqn: string; uid: string | null; kind: string; title: string; status: string | null; parts: NavPart[]; meta?: Record<string, string>; }   // b266: meta = the IO_META_KEYS set on the element
export interface NavEntry {
  kind: string; fqn: string; uid: string | null; title: string; status: string | null; rank: number; order: number; parent: string | null; parts: NavPart[]; description?: string; metadata?: Record<string, string>;
  wireframe?: NavWireframe;   // W6 (b302): screens only, when the screen has a wireframe file; absent = no file
  column?: number;            // navigation column of a screen, set by navColumns (W14); absent = use rank
}   // description = PlanElement.description when set. b128: metadata = the entry element's metadata (screen: device, design; route: method), filled by buildNav. b266: kind = screen | command | route | tool. parent = fqn of the nearest ancestor that is an entry too (a subcommand's command), else null
export interface NavGroup { fqn: string; title: string; technology: string | null; word: string; entries: NavEntry[]; }   // b266: word = ioContainerWord(technology); entries (was screens) = screens, commands, routes, tools of the container
/** from/to = screen fqns; via = the control/region/state fqn that navigates (null for screen -> screen). */
export interface NavEdge { from: string; to: string; label: string | null; labelled?: true; via: string | null; self?: true; crossGroup?: true; }
/**
 * b130 (T8): a plan relation from a screen (or one of its parts) to a non-frontend element: "calls / implemented by".
 * from = screen fqn; via = the part fqn (null when the screen itself is the origin); toComponent = the target when it
 * is a component, else its nearest component ancestor (null when none); label = the relation's own label only.
 * W6 (b302): toTitle = the target element's title (a planned function has no map node, the Calls chip shows this).
 */
export interface NavCall { from: string; via: string | null; to: string; toKind: string; toTitle: string; toUid: string | null; toComponent: string | null; label: string | null; }
export interface NavModel { groups: NavGroup[]; edges: NavEdge[]; calls: NavCall[]; }

export interface ViewModel {
  schemaVersion: 1;
  title: string;                 // the system's name: repo name; on the page (C1 A3, planTitle) the plan system's title when one maps
  subtitle: string;             // 'a41c9e2 · 2026-09-30' or 'no git · <createdAt date>'
  summary: string;               // same text as the snapshot command's Summary line (without 'Summary: ')
  repoPath: string;              // absolute, for vscode:// links
  root: ViewNode;                // kind 'system'; C1-CTX: kind 'context' (persons, our system, externals; a holder that is never drawn, C1 A1) when the plan has an actor
  edges: ViewEdge[];             // component edges (the map rolls them up to what is visible)
  fileEdges?: ViewEdge[];   // b896: imports file -> file whose two file/slice boxes share one parent; absent when none
  drift: { from: string; summary: string; removed: { kind: string; id: string; lines: number }[] } | null;
  planFindings: ViewFinding[];   // findings that don't sit on a file (plan elements), for the panel
  files: ViewFile[];             // P13-T2a: every scanned source file + the plan's .c4 files, sorted by path
  relations?: ViewRelation[];    // P13-T2d: declared plan relations in file order (any mode, only when a plan is given)
  nav?: NavModel;                // P20-T4: only when the plan has screens
  navView?: { root: ViewNode; edges: ViewEdge[] };   // P20-T5-0 (b254): laid-out IO-view tree (groups > screens), built by buildNavView (T5-A); only when nav is present
  storageView?: { root: ViewNode; edges: ViewEdge[] };   // STOR-5 (b338): storage-view tree (zones > stores > records > fields, FK edges field to field),
                          // built by buildStorageView (view/storageModel.ts); only when the plan has a store
  kindWords?: KindWords;   // b142: set when the page is rendered (html.ts), not by buildViewModel
  wireframeRules?: WireframeRules;   // W6 (b302): set by renderViewHtml (W10) like kindWords, not by buildViewModel
  board?: ViewBoard;             // P16-B17: absent when the repo has no board file
  tests?: ViewTestTable;         // Phase 26 (T26-10): attached test cases, when the page was built with tests (view/viewTests.ts); absent otherwise
  sims?: ViewSim[];              // Phase 25 (S4): resolved s-items, absent when the repo has none (view/simModel.ts buildViewSims)
}

// ---------- Phase 6: claim-based ownership ----------

export type ClaimKind = 'folder' | 'file' | 'function';

export interface Claim {
  kind: ClaimKind;
  path: string;             // repo-relative; folder claims end with '/'
  fn: string | null;        // function/method name; only set when kind === 'function'
  elementId: string;        // the PlanElement.id (component fqn) this claim belongs to
  claimIndex: number;       // index of this claim within that element's links[], in file order
}

export interface OwnershipConflict {
  file: string;
  fn: string | null;        // null = the conflict is at file/folder level, not a specific function
  winner: string;           // elementId
  losers: string[];         // elementId[]
  reason: 'specificity' | 'plan-order';   // specificity = winner's claim was more specific; plan-order = same specificity, winner came first
}

export interface SharedCode {
  fn: string;                // `${file}#${name}`
  users: string[];           // elementId[] of components that call it (via existing file-level edges, rolled up)
}

/** Unassigned function whose file is imported by unclaimed code only: who imports it, and which of those failed to parse. */
export interface UnassignedInfo {
  importers: string[];       // file paths, sorted
  unverified: string[];      // subset of importers with parseError: their imports may be incomplete
}

export interface Ownership {
  owner: Record<string, string>;        // `${file}#${name}` -> elementId | 'shared-auto' | 'unassigned'
  conflicts: OwnershipConflict[];
  shared: SharedCode[];
  unassigned: string[];                 // `${file}#${name}` with no owner, no claim, no caller
  unassignedInfo?: Record<string, UnassignedInfo>;   // `${file}#${name}` -> importers, only for unassigned entries that have any
  fileOwner?: Record<string, string>;   // file path -> elementId, only files with 0 parsed functions and a file/folder claim
  testOnly?: string[];                  // Phase 26 (T26-2): `${file}#${name}` unclaimed, no non-test user, its file reached from a test file through imports (directly or through unclaimed files)
}

// ---------- Phase 16: boards ----------
export interface BoardItem {
  id: string;                 // short stable id, 'b12'; never reused
  title: string;
  kind: string;               // one of BOARD_KINDS; a string because the parser keeps an unknown value as written and `checkBoard` reports it (B4, B8)
  status: string;             // one of BOARD_STATUSES
  owner?: string;
  parent?: string;            // id of another item (nesting); absent = top level
  dependsOn: string[];        // item ids this item waits for
  links: string[];            // uids of plan elements of any element kind (plan/kinds.ts isElementKind)
  tags: string[];
  sprint?: string;            // 'S15'
  priority?: string;          // high | medium | low
  start?: string;             // 'YYYY-MM-DD', typed by a person (K approved 2026-10-21; the Roadmap view needs it)
  due?: string;               // 'YYYY-MM-DD', typed by a person
  created?: string;           // 'YYYY-MM-DD', set by the CLI on `board add` (K approved 2026-10-21)
  updated?: string;           // set by the CLI on every `board set`
  closed?: string;            // set by the CLI when status becomes done
  group?: string;             // custom Kanban group id; absent = the group of its status (question 12)
  description?: string;       // free multi-line plain text, kept as written; limit BOARD_DESCRIPTION_MAX (checkBoard)
  docs?: BoardDoc[];          // references to documents; absent = none (an empty list is never stored)
  outcome?: string;           // how it ended (commit hash, verified-by note); plain text; limit BOARD_OUTCOME_MAX
  size?: string;              // one of BOARD_SIZES; kept as written, checkBoard judges it
  extra?: Record<string, unknown>;   // unknown keys of a newer file, kept as written and re-written after the known keys (parser is tolerant)
}
export interface BoardDoc { label?: string; path?: string; url?: string; }   // exactly one of path (repo-relative) or url (http/https); checkBoard judges it
export interface BoardGroup { id: string; name: string; status?: string; }   // status absent = custom group
export interface Board { id: string; name: string; archived?: boolean; groups?: BoardGroup[]; items: BoardItem[]; }   // one board; its b-items are its children; groups absent = Planned / In progress / Done
export interface BoardFile { schemaVersion: 1; boards: Board[]; }                                            // the whole file `board/board.json`

// What the viewer receives as `ViewModel.board` (P16-B17; shape fixed in PHASE_16_TASKS.md section 3b).
export interface ViewBoardLink {
  uid: string; nodeId: string; name: string; kind: ViewKind; status?: string; owner?: string;
  state: 'planned-no-code' | 'has-code'; findingCount: number;
}
export interface ViewBoardItem extends BoardItem { linked: ViewBoardLink[]; deadLinks: string[]; }   // deadLinks = uids with no ViewNode
export interface ViewBoardEntry { id: string; name: string; archived?: boolean; groups: BoardGroup[]; items: ViewBoardItem[]; }   // groups ALWAYS filled (default three if the file has none)
export interface ViewBoard { statuses: string[]; kinds: string[]; priorities?: string[]; sizes?: string[]; boards: ViewBoardEntry[]; findings: PlanFinding[]; }   // statuses = BOARD_STATUSES, kinds = BOARD_KINDS, priorities = PLAN_PRIORITIES, sizes = BOARD_SIZES (b645: the panel's Edit selects)

// ---------- Phase 25: simulations in the page ----------
// What the viewer receives as `ViewModel.sims` (S4, Document/Roadmap/Phase25/UI_TASKS.md B1). Everything is resolved on
// the server (view/simModel.ts buildViewSims): the viewer only has the tree of the current view.

/** One step target, resolved in the three view trees. */
export interface ViewSimTarget {
  ref: string;              // the stored target (uid, fqn or path#name), for the panel tooltip and a missing target
  uid: string | null;       // the plan uid when the element has one
  nodeId: string | null;    // the node id in the tree of `view`; null = not drawn (missing target, or no node in that tree)
  view: ViewName;           // the tree the node is in; for a missing target the step's view
  name: string;             // display name: function/method 'Owner.name' (owner = its component); control 'Screen › Control'
                            // with a trailing ' button' cut; else node.name; ref when missing
  kind: string;             // node.kind ('' when missing)
  entryId: string | null;   // io only: the entry (screen | command | route | tool) that holds it (itself for an entry); null elsewhere
  lane: string | null;      // ViewSimLane.id the target runs in (its container in the arch tree); null when unknown
}
/** The sample rows of one record after a step. */
export interface ViewSimRows {
  ref: string;              // the stored rows key (record uid, Q3)
  recordId: string | null;  // storage-view node id of the record; null = not found (then not drawn, the check reports it)
  name: string;             // record name ('orders'), for captions; the ref when not found
  pk: string[];             // its PK column names (storage-view field nodes with storage.pk), to pair rows across steps; [] = first column
  rows: Record<string, unknown>[];   // the record's rows AFTER the step (the whole sample table, not a delta)
}
/** The arrow of a step (arch map + sequence); QF1. */
export interface ViewSimCall {
  from: string; to: string;          // arch node ids (a person, a container, a component, a function) or a lane id
  fromLane: string; toLane: string;  // ViewSimLane ids
  label: string;                      // '' when none
  reply: boolean;                     // drawn as a reply (muted, dashed, open head)
}
/** b853: the flow depths, C4 levels top to bottom ('code' = the steps as written). */
export type SimDepth = 'context' | 'container' | 'component' | 'code';
/** A step at one depth (b853): its boxes and its arrow as lane ids of ViewSim.depth[d].lanes; key null = never merges. */
export interface ViewSimAt { boxes: string[]; from: string; to: string; key: string | null }
/** An s-item at one depth (b853): groups = the original step indexes of each flow step, consecutive; lanes = rankLanes' order. */
export interface ViewSimDepth { groups: number[][]; lanes: ViewSimLane[] }
/** One step in play order (a journey's flow stage plays that flow's steps inline). */
export interface ViewSimStep {
  i: number; n: number;              // 0-based index and 1-based number in play order
  view: ViewName | 'outside';
  targets: ViewSimTarget[];          // [] for an outside step
  outside?: { text: string; from: string | null; channel: string | null };   // QF2
  stage: number;                     // 0-based stage index (0 for every step of a flow)
  flow?: string; inFlow?: number;    // journey: the flow stage's s-id and the 1-based step inside that flow
  goal?: string;                     // journey: the stage's goal (copied on each step of the stage)
  state?: string; caption?: string; durationSec?: number;
  rows?: ViewSimRows[];
  call: ViewSimCall | null;
  at: Record<SimDepth, ViewSimAt>;   // b853: the step at each flow depth (at.container.from / to = call.fromLane / toLane)
  unverified?: string;               // message of a sim-step-unverified finding on the pair (i-1, i)
  unconnected?: string;              // message of a sim-step-unconnected finding on the pair (i-1, i) (panel note only)
  missing?: string[];                // refs of targets / rows keys / call ends that resolve to nothing (sim-target-missing)
}
/** A journey stage: its steps are steps[firstStep .. firstStep + stepCount - 1]. */
export interface ViewSimStage { kind: 'flow' | 'outside' | 'step'; name: string; goal?: string; flow?: string; firstStep: number; stepCount: number }
/** A sequence lane. */
export interface ViewSimLane { id: string; name: string; sub: string; kind: 'person' | 'container' | 'external' | 'outside' | 'system' | 'component' | 'code' | 'record'; rank: number }   // system / component / code / record: depth lanes only (b853)
/** One s-item as the page shows it. */
export interface ViewSim {
  id: string; kind: SimKind; title: string; description?: string;
  person?: { text: string; nodeId: string | null };   // QF3: nodeId = the arch person node when the text names a plan person
  file: string;                      // repo-relative path of the s-item file ('.c4pm/projects/shop/sim/s-1.json')
  steps: ViewSimStep[];              // ONE flat list in play order
  stages?: ViewSimStage[];           // journey only
  lanes: ViewSimLane[];              // sorted by rank: person 0, outside 1, containers 2.. in the order the steps first reach them, then externals the same way
  depth: Record<SimDepth, ViewSimDepth>;   // b853: merge groups and lanes per flow depth (depth.container.lanes = lanes, save Shared / Unassigned boxes)
  views: ViewName[];                // views the steps use, in IO, arch, storage order
}

// ---------- Phase 25: simulations ----------
// One s-item per file `<projectDir>/sim/s-<N>.json` (Document/Roadmap/PHASE_25_SIMULATIONS.md section 1).
// `extra` everywhere = unknown keys of a newer file, kept as written and re-written after the known keys (parser is tolerant).
export type SimKind = 'flow' | 'journey';
export type SimRows = Record<string, Record<string, unknown>[]>;   // key = record uid (Q3); value = sample rows
export interface SimCall { from?: string; to?: string; label?: string; reply?: boolean; extra?: Record<string, unknown> }   // QF1: the arrow of a step; absent = derived
export interface SimStep { target: string[]; view: ViewName; call?: SimCall; state?: string; rows?: SimRows; caption?: string; durationSec?: number; extra?: Record<string, unknown> }
export type SimStage =
  | { name?: string; flow: string; goal?: string; extra?: Record<string, unknown> }
  | { name?: string; outside: string; goal?: string; from?: string; channel?: string; state?: string; caption?: string; durationSec?: number; extra?: Record<string, unknown> }
  | (SimStep & { name?: string; goal?: string });       // inline step (Q2)
export interface SimItem { schemaVersion: 1; id: string; kind: SimKind; title: string; person?: string; description?: string; steps?: SimStep[]; stages?: SimStage[]; extra?: Record<string, unknown> }
export interface SimFileIssue { file: string; message: string }   // file = 's-3.json'

// ---------- Phase 18: neutral graph (plan tree, board tree) ----------

/**
 * Neutral graph: what `tree` (plan elements) and `board tree` (board items) both build, and what the
 * renderers (src/query/mermaid.ts) draw. Pure data, no rendering decisions.
 */
export interface GraphNode {
  id: string;            // unique inside the graph (a plan fqn, a board item id, ...)
  label: string;         // title shown on the node
  kind: string;          // 'system' | 'container' | 'component' | 'function' | ... | 'external'
  status?: string;       // planned | in-progress | done | abandoned (anything else gets no colour)
  owner?: string;
  parent?: string;       // id of the node this one is nested in; absent = top level
  outside?: boolean;     // P20-T9: a stub for an element outside the view (kind stays its real kind: person, external, ...)
}

export interface GraphEdge {
  from: string;          // node id
  to: string;            // node id
  label?: string;
  dashed?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
