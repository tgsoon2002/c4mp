import * as fs from 'fs';
import * as path from 'path';
import { listSourceFiles } from './importer/walk';
import { findContainers } from './grouper/containers';
import { languageDefaultIgnores, languageIgnorePatterns } from './languages/registry';
import { testFilesOf } from './importer/testMatch';
import { groupComponents } from './grouper/components';
import { rollupEdges, edgesWithoutTestImporters } from './grouper/rollup';
import { readMeta } from './history/meta';
import { buildSnapshot } from './snapshot/build';
import { toId } from './names';
import { getHandlers, handlerExtensions, handlerFor, wantsFileOnly } from './languages';
import {
  extractParsed, getCachedParse, storeParse, parseCacheStats, beginParseGeneration, endParseGeneration,
  loadParseCacheDisk, saveParseCacheDisk,
} from './parseCache';
import { storedResults } from './languages/resolveKit';
import { markTestFiles } from './languages/testCases';
import { FILE_ONLY_EXTENSIONS } from './constants';
import { log, timed, timeStart } from './log';
import { DEFAULT_CONFIG } from './config';
import { writeAtomic, writeError } from './util/fsAtomic';
import {
  Snapshot,
  FileOutline,
  FileImports,
  FileEdge,
  ComponentEdge,
  ImportRecord,
  Container,
  Component,
  SnapshotMeta,
  C4pmConfig,
  Plan,
  FileCalls,
  ResolveResult,
} from './types';

export interface SnapshotOptions {
  repo: string;
  out?: string;
  // Fallback dir used only when `out` is absent; beats the cwd/out/<repoId> fallback.
  defaultOut?: string;
  write?: boolean;
  quiet?: boolean;
  meta?: Partial<SnapshotMeta>;
  config?: Partial<C4pmConfig>;
  // P6-T11: optional parsed Plan, threaded through to buildSnapshot so a claim-mode plan
  // (per isClaimModePlan) builds Component[] from the plan's component elements instead of
  // today's folder-mode groupComponents output. Omitted/undefined => today's exact behavior.
  plan?: Plan;
  // P8: also collect the raw call sites of each file into Snapshot.calls (in memory only, never written).
  collectCalls?: CollectCalls;
  parseCacheDir?: string | null;   // QS-2: disk parse cache folder (queries only)
}

/**
 * Which files get their call sites in Snapshot.calls: true = every file (calls / callers queries), 'tests' = role-test
 * files only (Phase 26: what the test attachment needs on every page build, at a fraction of the cost).
 */
export type CollectCalls = boolean | 'tests';

/** File-only extensions (languages contains 'files'): listed without parsing. Empty otherwise. */
export function fileOnlyExtensionsFor(config: C4pmConfig): string[] {
  return wantsFileOnly(config.languages) ? (config.fileOnlyExtensions ?? FILE_ONLY_EXTENSIONS) : [];
}

/** Every extension the snapshot scan walks: handlers' extensions plus file-only ones. */
export function scanExtensions(config: C4pmConfig): string[] {
  return [...new Set([...handlerExtensions(config.languages), ...fileOnlyExtensionsFor(config)])];
}

/** Everything the scan finds, before any plan is applied. Plan independent, so one core serves many plans. */
export interface ScanCore {
  repoRoot: string;
  config: C4pmConfig;
  files: string[];
  testFiles: string[];   // Phase 26: the files config `tests.globs` marks as tests (role 'test'), sorted like `files`
  outlines: FileOutline[];
  imports: FileImports[];
  fileEdges: FileEdge[];
  containers: Container[];
  components: Component[];
  componentEdges: ComponentEdge[];
  meta: SnapshotMeta;
  // Present only when collectCalls was set; sorted by file.
  calls?: FileCalls[];
  warnings: string[];
  // TODO(STOR-2): storeFiles (files a storage reader needs); not collected here.
}

export interface ScanCoreOptions {
  collectCalls?: CollectCalls;
  parseCacheDir?: string | null;   // QS-2: disk parse cache folder (queries only)
  // Progress lines [1/7]..[6/7]; absent => silent.
  say?: (msg: string) => void;
  // false: meta.git is null without calling git, for a caller whose meta override sets git (runSnapshot with
  // opts.meta.git, e.g. the history scan of an export dir). Default true.
  readGit?: boolean;
}

/** Steps 1-6 of the scan: walk, parse, resolve imports, containers, components, rollup, plus repo meta. */
export function scanCore(repoRoot: string, config: C4pmConfig, opts: ScanCoreOptions = {}): ScanCore {
  repoRoot = path.resolve(repoRoot);
  const warnings: string[] = [];
  const say = opts.say ?? (() => {});

  // Get language handlers
  const handlers = getHandlers(config.languages);

  const fileOnlyExts = fileOnlyExtensionsFor(config);
  const extensions = scanExtensions(config);

  // [1/7] Walk source files
  const sourceFiles = timed('walk files', () => listSourceFiles(repoRoot, {
    extensions,
    ignore: config.ignore,
    languageIgnores: languageIgnorePatterns(config.languages),
    onUnmatchedIgnore: (patterns) => patterns.forEach((p) => warnings.push(`ignore pattern matched nothing: ${p}`)),
  }));
  const testFiles = testFilesOf(sourceFiles, config.tests);
  say(`[1/7] walk: ${sourceFiles.length} source files`);
  for (const d of languageDefaultIgnores(config.languages)) {
    say(`  default ignores for ${d.language}: ${d.dirs.join(', ')}`);
  }

  // [2/7] Parse files and extract outlines + imports
  const outlines: FileOutline[] = [];
  const rawImportsByFile: Map<string, RawImportRecord[]> = new Map();
  const callsByFile: Map<string, FileCalls> = new Map();
  let totalElements = 0;
  let parseErrors = 0;
  let fileOnlyCount = 0;

  const endParse = timeStart('parse files');
  beginParseGeneration();
  if (opts.parseCacheDir) loadParseCacheDisk(opts.parseCacheDir);
  const testSet = new Set(testFiles);
  for (const file of sourceFiles) {
    const role = testSet.has(file) ? 'test' as const : undefined;   // Phase 26: a test file's outline gets its test cases
    const wantCalls = opts.collectCalls === true || (opts.collectCalls === 'tests' && role === 'test');
    const absPath = path.join(repoRoot, file);
    const handler = handlerFor(file, handlers);
    const fileOnly = !handler && fileOnlyExts.includes(path.extname(file));

    // b620: every file is read (the cache key is its content); warning order stays `unreadable`, then `no handler`.
    let code: string;
    try {
      code = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      warnings.push(`unreadable ${file}`);
      continue;
    }
    if (!handler && !fileOnly) {
      warnings.push(`no handler ${file}`);
      continue;
    }
    let parsed = getCachedParse(file, code, handler, wantCalls, role);
    if (!parsed) {
      parsed = extractParsed(handler, file, code, wantCalls, role);
      storeParse(file, code, handler, parsed, role);
    }

    outlines.push(parsed.outline);
    if (!handler) {
      fileOnlyCount++;
      continue;
    }
    totalElements += parsed.outline.elements.length;
    if (parsed.outline.parseError) {
      parseErrors++;
      warnings.push(`parse error ${file}`);
    }
    rawImportsByFile.set(file, parsed.rawImports ?? []);
    if (wantCalls && parsed.calls) callsByFile.set(file, parsed.calls);
  }
  endParseGeneration();   // only reached when the loop finished: a throw leaves the cache as it was
  if (opts.parseCacheDir) saveParseCacheDisk(opts.parseCacheDir);
  markTestFiles(repoRoot, outlines, testFiles, handlers);   // Phase 26: test cases of role-test files get kind 'test'
  const cacheStats = parseCacheStats();
  endParse(`${sourceFiles.length} files (${cacheStats.hits} cached)`);
  log('pipeline', 'file-only', { count: fileOnlyCount });
  say(`[2/7] parse: ${sourceFiles.length} files, ${totalElements} code elements, ${parseErrors} parse errors`);

  // [3/7] Resolve imports - create one resolver per handler
  const fileImportsArray: FileImports[] = [];
  const internalEdges: Set<string> = new Set();
  let internalCount = 0,
    externalCount = 0,
    assetCount = 0,
    unresolvedCount = 0;

  // Create resolvers for each handler
  const resolversByHandler: Map<string, (fromFile: string, spec: string) => ResolveResult> = new Map();
  const handlerFiles = sourceFiles.filter((f) => handlerFor(f, handlers));
  for (const handler of handlers) {
    const resolver = handler.createResolver(repoRoot, handlerFiles);
    resolversByHandler.set(handler.id, resolver);
  }

  for (const file of sourceFiles) {
    const rawImports = rawImportsByFile.get(file) || [];
    const imports: ImportRecord[] = [];

    // Get handler for this file
    const handler = handlerFor(file, handlers);
    if (!handler) {
      continue;
    }

    const resolver = resolversByHandler.get(handler.id);
    if (!resolver) {
      continue;
    }

    for (const raw of rawImports) {
      // `reason` (unresolved only) is for the resolver's debug log and reason counts; it is not stored.
      // A spec with several targets (C# `using N`) is stored as one record and one edge per target.
      for (const resolved of storedResults(resolver(file, raw.spec))) {
        const record: ImportRecord = {
          ...raw,
          ...resolved,
        };
        imports.push(record);

        // Track internal edges (from file to target)
        if (resolved.status === 'internal' && resolved.target) {
          const edgeKey = `${file}|${resolved.target}`;
          internalEdges.add(edgeKey);
          internalCount++;
        } else if (resolved.status === 'external') {
          externalCount++;
        } else if (resolved.status === 'asset') {
          assetCount++;
        } else if (resolved.status === 'unresolved') {
          unresolvedCount++;
          warnings.push(`unresolved ${file}:${raw.line} '${raw.spec}'`);
        }
      }
    }

    fileImportsArray.push({ file, language: handler.id, imports });

    // P8: each imported name gets the verdict of the import resolver for its specifier (no second resolver).
    const fileCalls = callsByFile.get(file);
    if (fileCalls) {
      for (const b of fileCalls.bindings) {
        const rec = imports.find((i) => i.spec === b.spec);
        if (rec?.status === 'internal' && rec.target) b.target = rec.target;
        else if (rec?.status === 'external') b.external = true;
      }
      // Phase 26 (D5): a mocked specifier is not an import; the same resolver gives its file.
      for (const m of fileCalls.mocks ?? []) {
        const hit = storedResults(resolver(file, m.spec)).find((r) => r.status === 'internal' && r.target);
        if (hit) m.target = hit.target;
      }
    }
  }

  // Convert internal edges back to FileEdge[]
  const fileEdges: FileEdge[] = Array.from(internalEdges).map((edge) => {
    const [from, to] = edge.split('|');
    return { from, to };
  });

  say(
    `[3/7] imports: ${fileImportsArray.reduce((sum, fi) => sum + fi.imports.length, 0)} specifiers → ${internalCount} internal, ${externalCount} external, ${assetCount} asset, ${unresolvedCount} unresolved`
  );

  // [4/7] Find containers
  // Phase 26 (T26-14b, D9): a folder or manifest folder holding only test files forms no component or container; a test
  // file in no component gets componentId 'unassigned' (snapshot/build.ts).
  const containers = findContainers(repoRoot, sourceFiles, { ignore: config.ignore, languages: config.languages, extraManifests: wantsFileOnly(config.languages), testFiles });
  const containerIds = containers.map((c) => c.id).sort();
  say(`[4/7] containers: ${containers.length} (${containerIds.join(', ')})`);

  // [5/7] Group components
  const components = groupComponents(sourceFiles, containers, testFiles);
  say(`[5/7] components: ${components.length}`);

  // [6/7] Rollup file edges to component edges
  const fileToComponent: Record<string, string> = {};
  for (const component of components) {
    for (const file of component.files) {
      fileToComponent[file] = component.id;
    }
  }
  const componentEdges: ComponentEdge[] = rollupEdges(edgesWithoutTestImporters(fileEdges, testFiles), fileToComponent);
  say(`[6/7] edges: ${fileEdges.length} file edges → ${componentEdges.length} component edges`);

  const meta = readMeta(repoRoot, undefined, { git: opts.readGit !== false });

  const calls = opts.collectCalls
    ? [...callsByFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    : undefined;

  return {
    repoRoot,
    config,
    files: sourceFiles,
    testFiles,
    outlines,
    imports: fileImportsArray,
    fileEdges,
    containers,
    components,
    componentEdges,
    meta,
    calls,
    warnings,
  };
}

/** Step 7 (build half): apply a plan and optional meta override to a core. The core is not modified. */
export function snapshotFromCore(core: ScanCore, plan?: Plan, metaOverride?: Partial<SnapshotMeta>): Snapshot {
  // Shallow merge with provided meta options
  const meta = metaOverride ? { ...core.meta, ...metaOverride } : core.meta;

  const snapshot = timed('build snapshot', () => buildSnapshot(
    {
      meta,
      containers: core.containers,
      components: core.components,
      outlines: core.outlines,
      imports: core.imports,
      componentEdges: core.componentEdges,
      fileEdges: core.fileEdges,
      testFiles: core.testFiles,
    },
    plan
  ));

  if (core.calls) snapshot.calls = core.calls;
  snapshot.imports = core.imports;   // b467: in memory only (deps --files); runSnapshot and saveToHistory drop it
  return snapshot;
}

export function runSnapshot(opts: SnapshotOptions): Snapshot {
  const repoRoot = path.resolve(opts.repo);
  const write = opts.write !== false;  // default true
  const quiet = opts.quiet ?? false;   // default false

  // Merge config with defaults
  const config: C4pmConfig = { ...DEFAULT_CONFIG, ...opts.config };

  // Local function to handle console output respecting quiet flag
  const say = (msg: string) => {
    if (!quiet) {
      console.log(msg);
    }
  };

  // The override's git (any value, even null) replaces the core's in snapshotFromCore: no need to read it.
  const readGit = !(opts.meta && 'git' in opts.meta);
  const core = scanCore(repoRoot, config, { collectCalls: opts.collectCalls, parseCacheDir: opts.parseCacheDir, say, readGit });
  const snapshot = snapshotFromCore(core, opts.plan, opts.meta);
  const { meta, outlines, containers, components, componentEdges, warnings } = core;
  const fileImportsArray = core.imports;

  // Determine output directory using merged repoName
  const outDir =
    opts.out || opts.defaultOut || path.join(process.cwd(), 'out', toId(meta.repoName));

  if (write) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      throw writeError(outDir, err as NodeJS.ErrnoException);   // b723: `cannot write <dir>: permission denied`
    }

    // Write 4 JSON files
    const outlineJson = outlines;
    const importsJson = fileImportsArray;
    const componentsJson = {
      containers,
      components,
      componentEdges,
    };

    // b724: temp + rename (writeAtomic), so a kill never leaves a cut JSON file.
    writeAtomic(path.join(outDir, 'outline.json'), JSON.stringify(outlineJson, null, 2));
    writeAtomic(
      path.join(outDir, 'imports.json'),
      JSON.stringify(importsJson, null, 2)
    );
    writeAtomic(
      path.join(outDir, 'components.json'),
      JSON.stringify(componentsJson, null, 2)
    );
    writeAtomic(path.join(outDir, 'snapshot.json'), JSON.stringify({ ...snapshot, calls: undefined, imports: undefined }, null, 2));

    say(`[7/7] wrote ${outDir}/{outline,imports,components,snapshot}.json`);
  } else {
    say(`[7/7] snapshot built (not written)`);
  }

  // Print summary
  const stats = snapshot.stats;
  const unresolvedImportCount = warnings.filter((w) => w.startsWith('unresolved')).length;
  say(
    `Summary: ${meta.repoName} — ${stats.containers} containers, ${stats.components} components, ${stats.files} files, ${stats.codeElements} code elements, ${stats.componentEdges} component edges, ${unresolvedImportCount} unresolved import${unresolvedImportCount !== 1 ? 's' : ''}`
  );

  if (warnings.length > 0) {
    say('Warnings:');
    for (const warning of warnings) {
      say(`  ${warning}`);
    }
  }

  return snapshot;
}

interface RawImportRecord {
  spec: string;
  kind: 'import' | 'export-from' | 'require' | 'dynamic';
  line: number;
}
