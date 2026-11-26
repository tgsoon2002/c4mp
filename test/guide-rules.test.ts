import * as fs from 'fs';
import * as path from 'path';
import { WIREFRAME_CSS } from '../src/c4/wireframeHtml';

// b141: every check rule id the code can emit must appear in the rule tables of both guides.
const PROJECT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(PROJECT, p), 'utf8');

// check.ts and validate.ts emit the plan-check findings; wireframeCheck.ts the wireframe findings (W7, T4);
// checkStorage.ts the storage findings (STOR-3); layerCheck.ts the layer direction findings (b466); sim/check.ts the
// s-item findings and sim/run.ts their sim-parse (Phase 25 T7).
const ruleIds = [...new Set(['src/c4/check.ts', 'src/c4/validate.ts', 'src/c4/wireframeCheck.ts', 'src/storage/checkStorage.ts', 'src/c4/layerCheck.ts',
  'src/c4/foundationCheck.ts', 'src/sim/check.ts', 'src/sim/run.ts']
  .flatMap((f) => [...read(f).matchAll(/rule: '([a-z-]+)'/g)].map((m) => m[1])))];

describe('guide rule lists match the code', () => {
  it('finds the rules in the code', () => {
    expect(ruleIds.length).toBeGreaterThan(15);
  });
  it.each(['guide/c4.md', 'guide/ai.md'])('%s lists every check rule', (g) => {
    const text = read(g);
    expect(ruleIds.filter((id) => !text.includes('`' + id + '`'))).toEqual([]);
  });
  // C2 (PHASE_20_WIREFRAMES.md): the property list between the wireframe:css markers of guide/c4.md is WIREFRAME_CSS, in order.
  it('the guide lists exactly WIREFRAME_CSS', () => {
    const text = read('guide/c4.md');
    const open = '<!-- wireframe:css -->';
    const close = '<!-- /wireframe:css -->';
    const from = text.indexOf(open);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(open, from + open.length)).toBe(-1);
    const to = text.indexOf(close, from);
    expect(to).toBeGreaterThan(from);
    const listed = [...text.slice(from + open.length, to).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(listed).toEqual([...WIREFRAME_CSS]);
  });
  // The Document folder is private: the test skips in the public tree (b963).
  (fs.existsSync(path.join(PROJECT, '../Document/C4MP-C4-Guide.md')) ? it : it.skip)('the guide copies in Document are identical', () => {
    expect(read('../Document/C4MP-C4-Guide.md')).toBe(read('guide/c4.md'));
    expect(read('../Document/C4MP-AI-Guide.md')).toBe(read('guide/ai.md'));
  });
});
