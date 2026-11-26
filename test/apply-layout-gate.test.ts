import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyLayoutService, checkLayout } from '../src/services/planFileEdits';
import { loadPlanState, runWrite } from '../src/services/planState';
import { planLayoutEdits } from '../src/c4/applyLayout';
import type { LayoutFile } from '../src/c4/applyLayout';
import { textStamp } from '../src/util/stamp';
import { makeRepo } from './helpers/planEditHarness';

// SV2 (b678): apply-layout through the plan write gate.
const PLAN = [
  'specification {',
  '  element system',
  '  element container',
  '}',
  '',
  'model {',
  "  app = system 'App' {",
  "    api = container 'Api' { metadata { uid 'u-api' } }",
  '  }',
  '}',
  '',
].join('\n');

const L: LayoutFile = { version: 2, nodes: { 'app.api': { bx: 1, by: 2, rx: 3, ry: 4, rw: 5, rh: 6 } } };
const LAYOUT_LINE = "layout ';1,2,3,4'";
const L2: LayoutFile = { version: 2, nodes: { 'app.api': { rx: 1, ry: 2, rw: 3, rh: 4 } } };

const read = (f: string): string => fs.readFileSync(f, 'utf8');
const stampOnDisk = (root: string): string => textStamp(loadPlanState(root)!.texts);

describe('apply-layout through the plan write gate', () => {
  it('writes the layout, reports written and the stamp of the new plan', () => {
    const { root, files } = makeRepo('c4pm-alg1-', { 'plan.c4': PLAN });
    const r = applyLayoutService(root, L2, { yes: true });
    expect(r.write.ok).toBe(true);
    expect(r.write.written).toBe(true);
    expect(r.report.dryRun).toBe(false);
    expect(read(files['plan.c4']!)).toContain(LAYOUT_LINE);
    expect(r.stamp).toBe(stampOnDisk(root));
    expect(r.text).toContain('wrote ');
    const again = applyLayoutService(root, L2, { yes: true });
    expect(again.write.written).toBe(false);
    expect(again.report.dryRun).toBe(false);
    expect(again.text).not.toContain('(dry run)');
  });

  it('changes and removes an existing layout line (the gate lets layout lines go, uid stays)', () => {
    const { root, files } = makeRepo('c4pm-alg1b-', { 'plan.c4': PLAN });
    expect(applyLayoutService(root, L2, { yes: true }).write.written).toBe(true);
    expect(applyLayoutService(root, L, { yes: true }).write.written).toBe(true);
    expect(read(files['plan.c4']!)).toContain("layout '1,2;3,4,5,6'");
    const gone = applyLayoutService(root, { version: 2, nodes: { 'app.api': null } }, { yes: true });
    expect(gone.write.written).toBe(true);
    expect(read(files['plan.c4']!)).toBe(PLAN);
  });

  it('refuses another plan stamp (changed, nothing written) and writes with the right one', () => {
    const { root, files } = makeRepo('c4pm-alg2-', { 'plan.c4': PLAN });
    const bad = applyLayoutService(root, L2, { yes: true, expectStamp: 'x' });
    expect(bad.write.error?.code).toBe('changed');
    expect(bad.write.written).toBe(false);
    expect(read(files['plan.c4']!)).toBe(PLAN);
    const good = applyLayoutService(root, L2, { yes: true, expectStamp: stampOnDisk(root) });
    expect(good.write.written).toBe(true);
    expect(read(files['plan.c4']!)).toContain(LAYOUT_LINE);
  });

  it('refuses a plan outside .c4pm/ without force, writes it with force', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-alg3-')));
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'c4'));
    const file = path.join(root, 'c4', 'plan.c4');
    fs.writeFileSync(file, PLAN);
    const refused = applyLayoutService(root, L2, { yes: true });
    expect(refused.write.error?.code).toBe('outside-c4pm');
    expect(refused.write.written).toBe(false);
    expect(read(file)).toBe(PLAN);
    const forced = applyLayoutService(root, L2, { yes: true, force: true });
    expect(forced.write.written).toBe(true);
    expect(read(file)).toContain(LAYOUT_LINE);
  });

  it('rolls back when the plan changed on disk between load and write; the outside edit is kept', () => {
    const { root, files } = makeRepo('c4pm-alg4-', { 'plan.c4': PLAN });
    const state = loadPlanState(root)!;
    const { newTexts } = planLayoutEdits(state.plan, state.texts, L2);
    const outside = PLAN + '// edited elsewhere\n';
    fs.writeFileSync(files['plan.c4']!, outside);
    const w = runWrite({ command: 'plan apply-layout', opts: { yes: true }, state, target: null, newTexts, notes: [], post: () => null });
    expect(w.error?.code).toBe('rolled-back');
    expect(w.error?.message).toContain('changed on disk since it was read');
    expect(read(files['plan.c4']!)).toBe(outside);
  });

  it('a dry run writes nothing and lists "would write"', () => {
    const { root, files } = makeRepo('c4pm-alg5-', { 'plan.c4': PLAN });
    const r = applyLayoutService(root, L, { yes: false });
    expect(r.report.dryRun).toBe(true);
    expect(r.write.dryRun).toBe(true);
    expect(r.write.written).toBe(false);
    expect(r.text).toContain('would write ');
    expect(read(files['plan.c4']!)).toBe(PLAN);
    expect(r.stamp).toBe(stampOnDisk(root));
  });

  it('checkLayout rejects an unsupported version', () => {
    expect(() => checkLayout({ version: 1, nodes: {} })).toThrow('unsupported layout version: 1 (expected 2)');
    expect(checkLayout(L)).toEqual(L);
  });

  it('no plan: no-plan error, no stamp', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-alg7-')));
    fs.mkdirSync(path.join(root, '.git'));
    const r = applyLayoutService(root, L2, { yes: true });
    expect(r.write.error?.code).toBe('no-plan');
    expect(r.stamp).toBeNull();
  });
});
