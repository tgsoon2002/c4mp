import * as fs from 'fs';
import * as path from 'path';
import { privatePlanDir } from './helpers/privateRepo';
import { parsePlan } from '../src/plan/parser';
import { listC4Files } from '../src/plan/files';
import { loadWireframes, type WireframeFile } from '../src/c4/wireframeFiles';
import { wireframeOf } from '../src/c4/wireframeRefs';
import { buildNav } from '../src/view/navModel';
import type { NavEntry, NavModel, Plan } from '../src/types';

// W6 (b302): screen entries carry their resolved wireframe (wireframeOf, the one resolver, C1); NavCall.toTitle.

const entriesOf = (nav: NavModel): NavEntry[] => nav.groups.flatMap(g => g.entries);
const screensOf = (plan: Plan): string[] => plan.elements.filter(e => e.kind === 'screen').map(e => e.id);
function filesOf(repo: string, planDir: string, plan: Plan): Map<string, WireframeFile> {
  const load = loadWireframes(repo, planDir, screensOf(plan));
  if (load.status !== 'ok') throw new Error('expected ok, got ' + load.status);
  return load.files;
}

describe('buildNav with wireframes: io-shop', () => {
  const repo = path.resolve(__dirname, 'fixtures', 'io-shop');
  const plan = parsePlan(repo, listC4Files(repo));
  const files = filesOf(repo, path.join(repo, 'c4'), plan);
  const nav = buildNav(plan, files)!;
  const byFqn = new Map(entriesOf(nav).map(e => [e.fqn, e]));

  it('home has its wireframe: 9 refs, no problem, nothing missing', () => {
    const wf = byFqn.get('shop.web.home')!.wireframe!;
    expect(wf.file).toBe('c4/io/shop.web.home.html');
    expect(wf.html).toBe(files.get('shop.web.home')!.html);
    expect(wf.error).toBeUndefined();
    expect(wf.refs).toHaveLength(9);
    expect(wf.refs.filter(r => r.problem)).toEqual([]);
    expect(wf.missing).toEqual([]);
  });

  it('screens without a file, and commands, routes and tools, have no wireframe key', () => {
    for (const fqn of ['shop.web.login', 'shop.web.products', 'shop.web.cart']) expect(byFqn.get(fqn)).not.toHaveProperty('wireframe');
    for (const e of entriesOf(nav)) if (e.kind !== 'screen') expect(e).not.toHaveProperty('wireframe');
  });

  it('a file c4pm cannot use stays an error entry: no refs, every region and control missing (plan order, no states)', () => {
    const bad: WireframeFile = { fqn: 'shop.web.login', file: 'c4/io/shop.web.login.html', error: 'over the size cap', inlined: [], badLinks: [] };
    expect(wireframeOf(plan, 'shop.web.login', bad)).toEqual({
      file: 'c4/io/shop.web.login.html', error: 'over the size cap', refs: [],
      missing: plan.elements.filter(e => e.id.startsWith('shop.web.login.') && (e.kind === 'region' || e.kind === 'control')).map(e => e.id),
    });
    expect(wireframeOf(plan, 'shop.web.login', bad).missing).toHaveLength(8);   // 3 regions, 5 controls; 2 states left out
  });

  it('without wireframes: no entry has the key; every call carries its target title', () => {
    const bare = buildNav(plan)!;
    expect(entriesOf(bare).some(e => 'wireframe' in e)).toBe(false);
    const titleOf = new Map(plan.elements.map(e => [e.id, e.title]));
    for (const c of bare.calls) expect(c.toTitle).toBe(titleOf.get(c.to));
    expect(JSON.stringify({ ...nav, groups: nav.groups.map(g => ({ ...g, entries: g.entries.map(({ wireframe: _w, ...e }) => e) })) })).toBe(JSON.stringify(bare));
  });
});

// Private plan only: the public tree has no ../.c4mp, so the block is skipped there and its body is not built (b963).
(privatePlanDir() ? describe : describe.skip)('buildNav with wireframes: C4PM plan', () => {
  const root = privatePlanDir();
  if (!root) { it('needs the private ../.c4mp plan', () => undefined); return; }
  const plan = parsePlan(root, listC4Files(root));
  const files = filesOf(root, root, plan);
  const nav = buildNav(plan, files)!;
  const ioFiles = fs.readdirSync(path.join(root, 'io')).filter(f => f.endsWith('.html'));

  it('3 screens have a wireframe, every ref resolves, nothing missing; ref counts come from the files (T5)', () => {
    const withWf = entriesOf(nav).filter(e => e.wireframe);
    expect(withWf.map(e => e.fqn).sort()).toEqual(ioFiles.map(f => f.replace(/\.html$/, '')).sort());
    expect(withWf).toHaveLength(3);
    for (const e of withWf) {
      const wf = e.wireframe!;
      expect(wf.error).toBeUndefined();
      expect(wf.refs.filter(r => r.problem)).toEqual([]);
      expect(wf.missing).toEqual([]);
      const distinct = new Set([...fs.readFileSync(path.join(root, 'io', e.fqn + '.html'), 'utf-8').matchAll(/data-c4="([^"]+)"/g)].map(m => m[1]));
      expect(wf.refs).toHaveLength(distinct.size);
    }
  });
});
