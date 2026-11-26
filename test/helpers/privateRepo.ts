import * as fs from 'fs';
import * as path from 'path';

// The private repo keeps this project's own plan in ../.c4mp/projects/c4mp (next to Project/). The public tree has no such folder,
// so tests that read the real plan use privatePlanDir() to skip there (b963).

/** Absolute path of the private plan folder (.c4mp/projects/c4mp/plan), or null when it is missing (public tree). */
export function privatePlanDir(): string | null {
  const dir = path.resolve(__dirname, '..', '..', '..', '.c4mp', 'projects', 'c4mp', 'plan');
  return fs.existsSync(dir) ? dir : null;
}
