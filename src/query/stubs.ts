import { openProject } from '../scan/project';
import { planFor, scanWithPlan } from '../scan/planScan';
import type { C4pmConfig, StubKind } from '../types';

/** One function whose body is not implemented yet (StubKind: empty, todo, throws, returns-nothing). */
export interface StubRow {
  /** Repo-relative file. */
  file: string;
  name: string;
  startLine: number;
  stub: StubKind;
}

/**
 * `c4pm plan stubs`: every stub function the scan finds, in scan order (files, then elements by line).
 * The scan is built with the plan, as `view` does. Read-only.
 */
export function findStubs(repoRoot: string, cli: Partial<C4pmConfig>): StubRow[] {
  const { config } = openProject(repoRoot, cli);
  const snapshot = scanWithPlan(repoRoot, config, planFor(repoRoot, config));
  const stubs: StubRow[] = [];
  for (const file of snapshot.files) {
    for (const elem of file.elements) {
      if (elem.stub) stubs.push({ file: file.file, name: elem.name, startLine: elem.startLine, stub: elem.stub });
    }
  }
  return stubs;
}
