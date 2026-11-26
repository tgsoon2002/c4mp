/**
 * b472 (ARR-CL-P, rows P1, P2 of Document/Roadmap/ARROWS_COMMAND_LINE.md): the Plan editing functions behind
 * `c4pm plan generate`. generatePlan drafts or refreshes the plan from a scan and writes it at once (the old arch
 * generate, moved from bin/cli.ts); generateStorageView adds a store for every reader hit no plan store covers and goes
 * through the write gate (runWrite; moved from src/cli/generateView.ts). The Command Line only parses options and prints.
 * L3: imports nothing from src/cli/ (that would be an upward import).
 */
import * as fs from 'fs';
import * as path from 'path';
import { generateC4 as draftC4 } from '../c4/generate';
import type { KeptCounts } from '../c4/generate';
import { listC4Files as listPlanFiles } from '../plan/files';
import { parsePlan as parsePlanFiles } from '../plan/parser';
import { c4ElementId } from '../names';
import { writeAtomic } from '../util/fsAtomic';
import { addTargetOf } from '../c4/editAdd';
import { addStoreText, freeId, ownerContainer } from '../c4/storeGenerate';
import type { NewStore } from '../c4/storeGenerate';
import { scanStoreHits, listStoreFiles, readPlanStores, storeCovers } from '../schema/storeScan';
import type { StoreHit } from '../schema/storeScan';
import { findPlan, scanWithPlan } from '../scan/planScan';
import { openProject } from '../scan/project';
import type { C4pmConfig, Plan } from '../types';
import { cmdError, failedReport, loadPlanState, resolveTarget, runWrite } from './planState';
import type { PlanState, WriteReport } from './planState';

// --- plan generate (arch) ------------------------------------------------------------------------------------

export interface GeneratePlanOptions {
  /** Folder for the .c4 files (resolved from the working folder); default: config architectureDir, else the project plan/ folder. */
  out?: string;
  /** Called with the absolute path of each .c4 file right after it is written. */
  onWritten?: (file: string) => void;
}

export interface GeneratePlanResult {
  /** Absolute paths of the .c4 files written, in write order. */
  files: string[];
  /** What the refresh kept from the existing plan (all 0 for a first draft). */
  kept: KeptCounts;
}

/**
 * `c4pm plan generate`: draft a plan from a scan of the repo, or refresh the existing one (keeps titles, components and
 * relations added by hand). Output folder: `out` > config architectureDir (repo-relative) > the project's plan/ folder
 * (throws AnchorNotFoundError, init hint, before anything is written). Writes the files at once. Errors are thrown.
 */
export function generatePlan(repo: string, cli: Partial<C4pmConfig>, opts: GeneratePlanOptions = {}): GeneratePlanResult {
  const repoRoot = path.resolve(repo);
  const { config, project: planProject } = openProject(repoRoot, cli);

  // Determine output directory. Precedence: --out flag > config.architectureDir (P6-T11,
  // repo-relative) > planDir (<anchor>/.c4pm/projects/<repoId>/plan; P12-T9).
  // Without an anchor, openProject with requireAnchor throws AnchorNotFoundError (init hint) before anything is written.
  let outDir: string;
  if (opts.out) {
    outDir = path.resolve(opts.out);
  } else if (config.architectureDir) {
    outDir = path.join(repoRoot, config.architectureDir);
  } else {
    outDir = (planProject ?? openProject(repoRoot, cli, { requireAnchor: true }).project).planDir;
  }
  // Links inside the .c4 files are relative to their own folder: tell generateC4 where that is
  // (relative to the scan target), instead of the old hard-coded 'c4'.
  const linkBase = path.relative(repoRoot, outDir).split(path.sep).join('/') || '.';

  // Create output directory (planDir is under .c4pm: Project & scan makes sure .c4pm/.gitignore exists first)
  openProject(repoRoot, cli, { writeTo: outDir });
  fs.mkdirSync(outDir, { recursive: true });

  // Load existing plan if it exists in the output directory
  let existingPlan: Plan | null = null;
  const existingC4Files = listPlanFiles(outDir).map(f =>
    f.startsWith(outDir) ? path.relative(outDir, f) : f
  );

  if (existingC4Files.length > 0) {
    existingPlan = parsePlanFiles(outDir, existingC4Files);
  } else {
    // Try to load from the repo's .c4 files (Project & scan finds and parses them)
    existingPlan = findPlan(repoRoot, config).plan ?? null;
  }

  // Get snapshot: the quiet, write-free scan of Project & scan, without a plan (the draft comes from the code)
  const snapshot = scanWithPlan(repoRoot, config, undefined);

  // Generate C4 files
  let kept: KeptCounts = { titles: 0, components: 0, relations: 0 };
  const c4Files = draftC4(snapshot, existingPlan, {
    linkBase, repoRoot, onKept: k => { kept = k; },
    planText: file => fs.readFileSync(path.join(existingC4Files.length > 0 ? outDir : repoRoot, file), 'utf-8'),
  });

  // Write files
  const files: string[] = [];
  for (const [filename, content] of Object.entries(c4Files)) {
    const filepath = path.join(outDir, filename);
    writeAtomic(filepath, content);   // b724: temp + rename, a kill never leaves a cut file
    files.push(filepath);
    opts.onWritten?.(filepath);
  }
  return { files, kept };
}

// b475 (ARR-CL-A1): the old library names (src/index.ts) for drafting and reading a plan, kept as deprecated aliases.

/** @deprecated Use generatePlan: scans the repo, keeps what the existing plan adds by hand and writes the .c4 files. */
export const generateC4: typeof draftC4 = draftC4;

/** @deprecated Use loadPlanState (src/services/planState.ts): its c4Files are the plan files the config finds. */
export const listC4Files: typeof listPlanFiles = listPlanFiles;

/** @deprecated Use loadPlanState (src/services/planState.ts): its plan is the parsed plan of the repo. */
export const parsePlan: typeof parsePlanFiles = parsePlanFiles;

// --- plan generate --view storage ----------------------------------------------------------------------------

const MAX_LISTED_FILES = 10;

const filesNote = (files: string[]): string =>
  files.slice(0, MAX_LISTED_FILES).join(', ') + (files.length > MAX_LISTED_FILES ? `, ... ${files.length - MAX_LISTED_FILES} more` : '');

/** The store to add for a hit: id and title from the reader and the last part of the source (`drizzle schema` -> drizzle_schema). */
function newStoreFor(hit: StoreHit, usedIds: Set<string>): NewStore {
  const last = hit.source === null ? '' : hit.source.split('/').pop()!.replace(/\.[^.]+$/, '');
  const title = last === '' ? hit.reader : `${hit.reader} ${last}`;
  return { id: freeId(c4ElementId(title), usedIds), title, technology: hit.tech, reader: hit.reader, source: hit.source, records: hit.model.records };
}

/**
 * `c4pm plan generate --view storage` (b273, D6): add a store (with its records and fields) for every reader hit that no
 * plan store covers, from the code only, under `opts.container` or the container whose components own most of its
 * files. Goes through the write gate like `plan add`: dry run unless `opts.yes`, atomic, rolled back on a problem.
 * Never touches an existing store. `opts` = the command's options (container, yes, force, check).
 */
export function generateStorageView(repo: string, cli: Partial<C4pmConfig>, opts: Record<string, unknown>): WriteReport {
  const fail = (e: ReturnType<typeof cmdError>) => failedReport('generate', opts, e);
  const state: PlanState | null = loadPlanState(repo, cli);
  if (!state) return fail(cmdError('no-plan', 'no .c4 files found; run c4mp plan generate to start a plan (a store needs a container to go under)'));

  const forced = typeof opts.container === 'string' ? resolveTarget(state, opts.container) : null;
  if (forced) {
    if (!forced.ok) return fail(forced.error);
    if (forced.el.kind !== 'container') return fail(cmdError('invalid', `--container must name a container, '${opts.container}' is a ${forced.el.kind}`));
  }

  const repoFiles = listStoreFiles(state.repoRoot, state.config);
  const hits = scanStoreHits(state.repoRoot, repoFiles);
  const existing = readPlanStores(state.plan, state.repoRoot, repoFiles);
  const notes: string[] = existing.filter(s => s.error).map(s => `store ${s.element.id}: ${s.error}`);
  if (hits.length === 0) notes.push('nothing to generate: no reader finds records in this repo');

  let texts = state.texts;
  const added: { fqn: string; records: number }[] = [];
  const usedByContainer = new Map<string, Set<string>>();
  for (const hit of hits) {
    const where = hit.source ?? '.';
    const covering = existing.find(s => storeCovers(s, hit));
    if (covering) {
      notes.push(`skipped ${hit.reader} (${where}): store ${covering.element.id} already covers it`);
      continue;
    }
    const owner = forced?.ok ? forced.el : ownerContainer(state.plan, hit.files)?.container;
    if (!owner) {
      notes.push(`skipped ${hit.reader} (${where}): no component owns its files (${filesNote(hit.files)}); run again with --container <target>`);
      continue;
    }
    let used = usedByContainer.get(owner.id);
    if (!used) {
      used = new Set(state.plan.elements.filter(e => e.parent === owner.id).map(e => e.id.slice(owner.id.length + 1)));
      usedByContainer.set(owner.id, used);
    }
    // W5 (b301, C13): the file (and extend block) that holds the container's stores; computed on the ORIGINAL texts,
    // whose lines match state.plan. A store inserted earlier in this run adds no extend block, so the index still holds.
    const target = addTargetOf(state.plan, state.texts, owner.id, 'store');
    const file = target.file;
    const fileText = texts.get(file);
    if (fileText === undefined) return fail(cmdError('invalid', `the file of ${owner.id} is not a plan file read by this command: ${file}`));
    let made: ReturnType<typeof addStoreText>;
    try {
      made = addStoreText(fileText, owner.id, newStoreFor(hit, used), target.extendIndex !== null ? { extendIndex: target.extendIndex } : undefined);
    } catch (err) {
      return fail(cmdError('invalid', `${hit.reader} (${where}): ${err instanceof Error ? err.message : String(err)}`));
    }
    texts = new Map(texts).set(file, made.text);
    added.push({ fqn: made.fqn, records: made.records });
    notes.push(`store ${made.fqn}: ${made.records} records, ${made.fields} fields (reader ${hit.reader}, source ${where}, ${hit.files.length} files)`);
  }

  return runWrite({
    command: 'generate',
    opts,
    state,
    target: null,
    newTexts: texts,
    notes,
    post: plan => {
      for (const a of added) {
        const stores = plan.elements.filter(e => e.id === a.fqn);
        if (stores.length !== 1 || stores[0].kind !== 'store') return `${a.fqn} should exist once as a store after the edit, found ${stores.length}`;
        const records = plan.elements.filter(e => e.kind === 'record' && e.parent === a.fqn).length;
        if (records !== a.records) return `${a.fqn} has ${records} records after the edit, wanted ${a.records}`;
      }
      return null;
    },
  });
}
