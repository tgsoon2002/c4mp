import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INTERNAL_DIR } from '../../src/paths';

/** True when a .git or .c4pm folder sits at or above the OS temp dir: then a temp folder always has an anchor. */
export function markerAboveTmp(): boolean {
  let d = fs.realpathSync(os.tmpdir());
  for (;;) {
    if (fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, INTERNAL_DIR))) return true;
    const u = path.dirname(d);
    if (u === d) return false;
    d = u;
  }
}
