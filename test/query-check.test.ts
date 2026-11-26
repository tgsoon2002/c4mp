import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCheck } from '../src/query/check';
import { checkPlan, compareFindings } from '../src/c4/check';
import { checkWireframes } from '../src/c4/wireframeCheck';
import { loadWireframes } from '../src/c4/wireframeFiles';
import { runSnapshot } from '../src/pipeline';
import { loadConfig } from '../src/config';
import { configOptsFor, pickScanConfig } from '../src/outputs';

const FIX = path.join(__dirname, 'fixtures');

function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-check-'));
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  return fs.realpathSync(dir);
}

describe('runCheck', () => {
  let phofast: string;
  beforeAll(() => {
    phofast = copyFixture('phofast');
  });

  it('returns config, plan, snapshot, findings and the repo name for a repo with .c4 files', () => {
    const r = runCheck(phofast, {}, {});
    expect(r).not.toBeNull();
    expect(r!.repoName).toBe('phofast');   // package.json name, not the tmp folder's name
    expect(r!.plan.elements.length).toBeGreaterThan(0);
    expect(r!.snapshot.files.length).toBeGreaterThan(0);
    expect(r!.config.languages.length).toBeGreaterThan(0);
    expect(r!.findings.length).toBeGreaterThan(0);
  });

  it('matches checkPlan run by hand with the plan-aware snapshot', () => {
    const r = runCheck(phofast, {}, {})!;
    const config = loadConfig(phofast, {}, configOptsFor(phofast));
    const snapshot = runSnapshot({ repo: phofast, write: false, quiet: true, config: pickScanConfig(config), plan: r.plan });
    expect(r.findings).toEqual(checkPlan(r.plan, snapshot, phofast, {}));
  });

  it('W7: with an io/ folder, the findings are checkPlan and checkWireframes of the plan folder, sorted together (b615; never inside checkPlan, T3)', () => {
    const shop = copyFixture('io-shop');
    const r = runCheck(shop, {}, {})!;
    const config = loadConfig(shop, {}, configOptsFor(shop));
    const snapshot = runSnapshot({ repo: shop, write: false, quiet: true, config: pickScanConfig(config), plan: r.plan });
    const plain = checkPlan(r.plan, snapshot, shop, {});
    expect(plain.some(f => f.rule.startsWith('wireframe-'))).toBe(false);
    const screens = r.plan.elements.filter(e => e.kind === 'screen').map(e => e.id);
    const wire = checkWireframes(r.plan, loadWireframes(shop, path.join(shop, 'c4'), screens));
    expect(wire.length).toBeGreaterThan(0);
    expect(r.findings).toEqual([...plain, ...wire].sort(compareFindings));
  });

  it('returns null when the repo has no .c4 files', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-check-empty-'));
    fs.writeFileSync(path.join(empty, 'a.ts'), 'export const a = 1;\n');
    expect(runCheck(empty, {}, {})).toBeNull();
  });

  it('minSeverity hides findings below the level', () => {
    const all = runCheck(phofast, {}, {})!.findings;
    const warn = runCheck(phofast, {}, { minSeverity: 'warning' })!.findings;
    const crit = runCheck(phofast, {}, { minSeverity: 'critical' })!.findings;
    expect(warn.every(f => f.severity !== 'info')).toBe(true);
    expect(crit.every(f => f.severity === 'critical')).toBe(true);
    expect(warn).toEqual(all.filter(f => f.severity !== 'info'));
    expect(crit).toEqual(all.filter(f => f.severity === 'critical'));
    expect(crit.length).toBeLessThanOrEqual(warn.length);
    expect(warn.length).toBeLessThanOrEqual(all.length);
  });

  it('sprint option reaches checkPlan (opts.sprint and cli.sprint agree)', () => {
    const base = runCheck(phofast, {}, {})!.findings;
    const viaOpts = runCheck(phofast, {}, { sprint: 'S99' })!.findings;
    const viaCli = runCheck(phofast, { sprint: 'S99' }, {})!.findings;
    expect(viaCli).toEqual(viaOpts);
    // a far-future current sprint can only add `late` findings
    expect(viaOpts.length).toBeGreaterThanOrEqual(base.length);
  });
});
