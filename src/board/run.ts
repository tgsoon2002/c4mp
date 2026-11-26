import * as fs from 'fs';
import * as path from 'path';
import type { BoardFile, Plan, PlanFinding, ProjectPaths } from '../types';
import { compareFindings } from '../c4/check';
import { loadBoard } from './load';
import { checkBoard, BOARD_FILE_ID } from './check';

/**
 * The ONE entry point that loads and checks the board. Only `collectFindings` (src/check/collect.ts) calls it, so
 * CLI, MCP, status and the page cannot disagree. `project`: the repo's project folders (null without an anchor), found
 * by the caller. No board file: `{data: null, findings: []}`. Parse issues
 * become `board-parse` warnings (id 'board.json'); when the file still yielded data, the meaning rules run on
 * it too. Findings are sorted by severity, rule, id.
 */
export function boardForView(
  repoRoot: string,
  project: ProjectPaths | null,
  plan: Plan | null,
  today: string,
): { data: BoardFile | null; findings: PlanFinding[] } {
  const loaded = loadBoard(project);
  const findings: PlanFinding[] = [...loaded.issues, ...loaded.notes].map((i) => ({
    severity: 'warning' as const,
    rule: 'board-parse',
    id: BOARD_FILE_ID,
    message: i.message,
  }));
  if (loaded.data) {
    // doc paths are repo-relative: relative to the folder that holds `.c4pm/` (the anchor, normally the git root),
    // which is NOT the scanned folder when a sub-folder such as `Project/` is scanned. A path found under either is
    // fine; one found under neither is reported as info.
    const anchor = project?.anchor;
    const fileExists = (rel: string): boolean =>
      fs.existsSync(path.join(repoRoot, rel)) || (anchor !== undefined && fs.existsSync(path.join(anchor, rel)));
    findings.push(...checkBoard(loaded.data, plan, { today, fileExists }));
  }

  findings.sort(compareFindings);
  return { data: loaded.data, findings };
}
