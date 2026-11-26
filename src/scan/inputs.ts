import * as path from 'path';
import { boardFileFor } from '../board/load';
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from '../constants';
import { log } from '../log';
import { tryResolveProject } from '../outputs';
import { scanExtensions } from '../pipeline';
import { findPlanFiles } from '../plan/files';
import { simDirFor } from '../sim/load';
import type { C4pmConfig } from '../types';
import type { InputRoot } from '../watch';

/**
 * b679 (SV3): every folder a page build reads, with its extensions: the one list the fingerprint (fingerprint.ts) and
 * the watcher (startProjectWatch, watchRoots) use. The first root is always the repo itself (scanned sources, `.c4`
 * and `extraExtensions`, recursive); then the plan folder (`.c4`, `.html`, `.css`: plan and wireframes), the board
 * folder and the s-item folder (`.json`), the anchor config file and `<repo>/.c4pmrc.json`. Without an anchor only the
 * repo, the plan folder and `.c4pmrc.json`. Never `data/`, `history/` or the `C4PM/` export folder. The file filter of a
 * root (inputDropReason) lives with the watcher in src/watch.ts.
 */
export function projectInputRoots(repoRoot: string, config: C4pmConfig, extraExtensions: string[] = []): InputRoot[] {
  const repo = path.resolve(repoRoot);
  const roots: InputRoot[] = [
    { dir: repo, extensions: [...new Set([...scanExtensions(config), '.c4', ...extraExtensions])], recursive: true },
  ];
  const planDir = findPlanFiles(repo, config).dir;
  if (planDir) roots.push({ dir: planDir, extensions: ['.c4', '.html', '.css'], recursive: true });
  const project = tryResolveProject(repo);
  if (project) {
    roots.push({ dir: path.dirname(boardFileFor(project)), extensions: ['.json'], recursive: false });
    roots.push({ dir: simDirFor(project), extensions: ['.json'], recursive: false });
    roots.push({ dir: path.dirname(project.configFile), extensions: ['.json'], recursive: false, files: [path.basename(project.configFile)] });
  }
  roots.push({ dir: repo, extensions: [path.extname(CONFIG_FILE)], recursive: false, files: [CONFIG_FILE, LEGACY_CONFIG_FILE] });
  log('inputs', 'projectInputRoots', roots.map(r => r.dir));
  return roots;
}
