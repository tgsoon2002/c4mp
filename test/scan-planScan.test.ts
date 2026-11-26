import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../src/config';
import { findPlan, planFor } from '../src/scan/planScan';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-findplan-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const C4 = "model {\n  shop = system 'Shop' {\n  }\n}\n";

/** findPlan: the plan files as found, their folder and the parsed plan; planFor gives the same plan. */
describe('findPlan', () => {
  test.each([
    { name: 'no .c4 files', files: [] as string[], architectureDir: null as string | null, want: { files: [] as string[], dir: null as string | null } },
    { name: 'legacy c4/ folder', files: ['c4/a.c4'], architectureDir: null, want: { files: ['c4/a.c4'], dir: 'c4' } },
    { name: 'config architectureDir wins over c4/', files: ['c4/a.c4', 'arch/b.c4'], architectureDir: 'arch', want: { files: ['arch/b.c4'], dir: 'arch' } },
    { name: 'repo-wide fallback', files: ['docs/plan.c4'], architectureDir: null, want: { files: ['docs/plan.c4'], dir: null } },
  ])('$name', ({ files, architectureDir, want }) => {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.writeFileSync(path.join(tmp, f), C4);
    }
    const config = { ...DEFAULT_CONFIG, architectureDir };
    const found = findPlan(tmp, config);
    expect(found.files).toEqual(want.files);
    expect(found.dir).toBe(want.dir === null ? null : path.join(tmp, want.dir));
    expect(found.plan?.elements.map((e) => e.id) ?? null).toEqual(want.files.length > 0 ? ['shop'] : null);
    expect(planFor(tmp, config)).toEqual(found.plan);
  });
});
