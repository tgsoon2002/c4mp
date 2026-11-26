import * as fs from 'fs';
import * as path from 'path';
import { buildView, renderDataHtml } from './html';
import { log } from '../log';
import { todayIso } from '../util/dates';
import { openProject } from '../scan/project';
import type { C4pmConfig } from '../types';
import { writeAtomic, writeError } from '../util/fsAtomic';
import { CMD_NAME } from '../constants';

/**
 * The one "build the page and write it" path, shared by the `view` command and the git hooks.
 * outFile: explicit file (no anchor needed) or, when absent, `<anchor>/C4MP/<repoId>/c4mpView.html`
 * (throws AnchorNotFoundError with the init hint when there is no anchor).
 * Store: explicit > config.store > default store when an anchor exists; else undefined.
 * b507 (row G6): Project & scan opens the project (config, anchor and export folder when outFile is absent, store
 * 'known' with the explicit store as the cli store). Errors in the same order: config, anchor.
 * b643: the page is written with writeAtomic (temp + rename, mode kept) after the build, so a killed run or a failed
 * build leaves the old page whole; a failed write reads `cannot write <file>: <reason>` (writeError).
 * Returns the absolute path written.
 */
export function writeProjectView(
  repoRoot: string,
  opts: {
    cliConfig?: Partial<C4pmConfig>;
    outFile?: string;
    from?: string | null;
    store?: string;
    sprint?: string | null;
    noSource?: boolean;
  } = {},
): string {
  const cliConfig = opts.cliConfig ?? {};
  // the explicit store beats config.store (cli > env > file), so it goes in as the cli store; 'known' = explicit >
  // config.store > the default store when an anchor exists, else none
  const opened = openProject(repoRoot, opts.store ? { ...cliConfig, store: opts.store } : cliConfig, {
    store: 'known',
    exportDir: !opts.outFile,
  });

  let outFile: string;
  if (opts.outFile) {
    outFile = path.resolve(opts.outFile);
    log('viewExport', 'explicit outFile', { outFile });
  } else {
    outFile = opened.project!.viewFile; // exportDir threw the init hint when there is no anchor
    log('viewExport', 'default export file', { outFile });
  }

  const store = opened.store ?? undefined;
  log('viewExport', 'store', { store });

  const result = buildView({ repo: repoRoot, config: cliConfig, from: opts.from, store, sprint: opts.sprint }, { noSource: opts.noSource });
  // b643: temp + rename (writeAtomic) after the build, so a killed run (view, a hook) never leaves a half-written page
  writePageFile(outFile, result.html);
  return outFile;
}

/** b914: the one way to write a page file (view, the hooks, serve's Export): the folder made, then temp + rename (b643). */
export function writePageFile(file: string, html: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    throw writeError(path.dirname(file), err as NodeJS.ErrnoException);   // b723: `cannot write <dir>: permission denied`
  }
  writeAtomic(file, html);
  log('viewExport', 'written', { file, bytes: html.length });
}

/** b914: what the live page's Export gets back. */
export interface PageExport {
  /** Absolute path of the page file written (the anchor's C4MP/<repoId>/c4mpView.html). */
  file: string;
  /** The download name: c4pm-<repoId>-<YYYY-MM-DD>.html (todayIso, local date). */
  name: string;
  /** The page to download: the file's bytes, or without source when noSource. */
  html: string;
}

/**
 * b914: the live page Export. Renders the full page and the copy from the live page data (no second scan), then writes
 * the anchor's view file atomically; both renders come before the write, so a render that throws writes nothing.
 * Throws the init-hint AnchorNotFoundError (before any render) when there is no anchor.
 */
export function exportPageData(repoRoot: string, cliConfig: Partial<C4pmConfig>, dataJson: string, opts: { noSource: boolean }): PageExport {
  const { project } = openProject(repoRoot, cliConfig, { exportDir: true });
  const full = renderDataHtml(dataJson);
  const html = opts.noSource ? renderDataHtml(dataJson, { noSource: true }) : full;
  writePageFile(project!.viewFile, full);
  return { file: project!.viewFile, name: `${CMD_NAME}-${project!.repoId}-${todayIso()}.html`, html };
}
