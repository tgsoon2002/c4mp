import * as fs from 'fs';
import * as path from 'path';
import { loadSims, simDirFor, simFileFor } from '../src/sim/load';
import { parseSim } from '../src/sim/parse';
import { serializeSim } from '../src/sim/serialize';
import { applySimWrites, planSimWrites, SimWriteError } from '../src/sim/write';
import { requireProject } from '../src/outputs';
import { listing, makeRepo } from './helpers/planEditHarness';
import type { ProjectPaths, SimItem } from '../src/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'sim');
const fixture = (id: string): { text: string; item: SimItem } => {
  const text = fs.readFileSync(path.join(FIXTURES, `${id}.json`), 'utf8');
  return { text, item: parseSim(text, `${id}.json`).data as SimItem };
};
const flow = (id: string, title: string): SimItem => ({ schemaVersion: 1, id, kind: 'flow', title, steps: [] });

function repo(): { root: string; project: ProjectPaths; dir: string } {
  const { root } = makeRepo('c4pm-sim-write-', {});
  const project = requireProject(root);
  return { root, project, dir: simDirFor(project) };
}
/** A repo whose sim folder holds the s-1 and s-2 fixtures. */
function repoWithSims(): { root: string; project: ProjectPaths; dir: string } {
  const r = repo();
  fs.mkdirSync(r.dir, { recursive: true });
  for (const id of ['s-1', 's-2']) fs.writeFileSync(simFileFor(r.project, id), fixture(id).text);
  return r;
}
const thrown = (fn: () => void): SimWriteError => {
  try { fn(); } catch (e) { return e as SimWriteError; }
  throw new Error('did not throw');
};

describe('planSimWrites', () => {
  it('one entry per change: path, before = the loaded text, after = serializeSim (null for a removal), changed', () => {
    const { project } = repo();
    const s1 = fixture('s-1');
    const plan = planSimWrites(project, [
      { id: 's-1', next: s1.item, loadedText: s1.text },
      { id: 's-2', next: { ...s1.item, id: 's-2', title: 'New' }, loadedText: null },
      { id: 's-3', next: null, loadedText: 'old' },
    ]);
    expect(plan.files).toEqual([
      { path: simFileFor(project, 's-1'), before: s1.text, after: s1.text, changed: false },
      { path: simFileFor(project, 's-2'), before: null, after: serializeSim({ ...s1.item, id: 's-2', title: 'New' }), changed: true },
      { path: simFileFor(project, 's-3'), before: 'old', after: null, changed: true },
    ]);
  });

  it.each([
    ['an id that is not s-<N> (a path outside sim/)', [{ id: '../board/board', next: null, loadedText: 'x' }], /'\.\.\/board\/board' is not an s-item id/],
    ['an id changed twice', [{ id: 's-1', next: null, loadedText: 'x' }, { id: 's-1', next: null, loadedText: 'x' }], /s-1 is changed twice/],
    ['content whose id differs', [{ id: 's-1', next: flow('s-2', 'T'), loadedText: null }], /the content for s-1 has id 's-2'/],
  ])('throws for %s', (_label, changes, message) => {
    const { project } = repo();
    expect(() => planSimWrites(project, changes)).toThrow(message);
  });
});

describe('applySimWrites', () => {
  it('creates the sim folder and new files; edits and removes in one write', () => {
    const { project, dir } = repoWithSims();
    const s1 = fixture('s-1');
    const s2 = fixture('s-2');
    applySimWrites(project, planSimWrites(project, [
      { id: 's-1', next: { ...s1.item, title: 'Buy two' }, loadedText: s1.text },
      { id: 's-2', next: null, loadedText: s2.text },
      { id: 's-3', next: flow('s-3', 'Third'), loadedText: null },
    ]));
    const loaded = loadSims(project);
    expect(loaded.issues).toEqual([]);
    expect(loaded.items.map((i) => `${i.id} ${i.title}`)).toEqual(['s-1 Buy two', 's-3 Third']);
    expect(fs.readdirSync(dir).sort()).toEqual(['s-1.json', 's-3.json']);

    const fresh = repo();
    applySimWrites(fresh.project, planSimWrites(fresh.project, [{ id: 's-1', next: flow('s-1', 'T'), loadedText: null }]));
    expect(fs.readFileSync(simFileFor(fresh.project, 's-1'), 'utf8')).toBe(serializeSim(flow('s-1', 'T')));
  });

  it('nothing changed: nothing is written, not even the sim folder', () => {
    const { root, project } = repo();
    const before = listing(root);
    applySimWrites(project, planSimWrites(project, [{ id: 's-4', next: null, loadedText: null }]));
    expect(listing(root)).toEqual(before);
    const withSims = repoWithSims();
    const s1 = fixture('s-1');
    const mtime = fs.statSync(simFileFor(withSims.project, 's-1')).mtimeMs;
    applySimWrites(withSims.project, planSimWrites(withSims.project, [{ id: 's-1', next: s1.item, loadedText: s1.text }]));
    expect(fs.statSync(simFileFor(withSims.project, 's-1')).mtimeMs).toBe(mtime);
  });

  it('b899: extra files are written in the same set; a failing extra check rolls every file back', () => {
    const one = (project: ProjectPaths) => planSimWrites(project, [{ id: 's-1', next: flow('s-1', 'T'), loadedText: null }]);
    const a = repo();
    const pa = path.join(a.root, 'extra.c4');
    fs.writeFileSync(pa, 'old');
    applySimWrites(a.project, one(a.project), { files: [{ path: pa, before: 'old', after: 'new' }], verify: () => null });
    expect(fs.existsSync(simFileFor(a.project, 's-1'))).toBe(true);
    expect(fs.readFileSync(pa, 'utf8')).toBe('new');

    const b = repo();
    const pb = path.join(b.root, 'extra.c4');
    fs.writeFileSync(pb, 'old');
    const files = [{ path: pb, before: 'old', after: 'new' }];
    expect(thrown(() => applySimWrites(b.project, one(b.project), { files, verify: () => 'bad' })).message).toMatch(/^rolled back: .*extra\.c4: bad/);
    expect(fs.existsSync(simFileFor(b.project, 's-1'))).toBe(false);
    expect(fs.readFileSync(pb, 'utf8')).toBe('old');

    const c = repo();
    const pc = path.join(c.root, 'extra.c4');
    fs.writeFileSync(pc, 'old');
    applySimWrites(c.project, planSimWrites(c.project, [{ id: 's-4', next: null, loadedText: null }]), { files: [{ path: pc, before: 'old', after: 'new' }], verify: () => null });
    expect(fs.readFileSync(pc, 'utf8')).toBe('new');
    expect(fs.existsSync(c.dir)).toBe(false);
  });

  it.each([
    ['a path outside the sim folder', (p: ProjectPaths) => path.join(p.projectDir, 'board', 's-1.json')],
    ['a file in sim/ that is not s-<N>.json', (p: ProjectPaths) => path.join(simDirFor(p), 'notes.json')],
    ['the sim file of another project', (p: ProjectPaths) => path.join(p.projectDir, '..', 'other', 'sim', 's-1.json')],
  ])('refuses %s; nothing is written', (_label, where) => {
    const { root, project } = repoWithSims();
    const before = listing(root);
    const plan = planSimWrites(project, [{ id: 's-3', next: flow('s-3', 'T'), loadedText: null }, { id: 's-5', next: flow('s-5', 'T'), loadedText: null }]);
    plan.files[1].path = where(project);
    const err = thrown(() => applySimWrites(project, plan));
    expect(err).toBeInstanceOf(SimWriteError);
    expect(err.message).toMatch(/^refusing to write .*: c4mp writes s-items only to .*s-<N>\.json$/);
    expect(listing(root)).toEqual(before);
  });

  it('a file changed since it was read, or created meanwhile: refused, nothing written', () => {
    const { root, project } = repoWithSims();
    const s1 = fixture('s-1');
    const plan = planSimWrites(project, [
      { id: 's-3', next: flow('s-3', 'New'), loadedText: null },
      { id: 's-1', next: { ...s1.item, title: 'Mine' }, loadedText: s1.text },
    ]);
    fs.writeFileSync(simFileFor(project, 's-1'), s1.text.replace('Buy a product', 'Theirs'));
    const before = listing(root);
    expect(thrown(() => applySimWrites(project, plan)).message).toBe(`${simFileFor(project, 's-1')} changed since it was read; nothing was written. Run the command again.`);
    expect(listing(root)).toEqual(before);

    const race = planSimWrites(project, [{ id: 's-3', next: flow('s-3', 'Mine'), loadedText: null }]);
    fs.writeFileSync(simFileFor(project, 's-3'), serializeSim(flow('s-3', 'Theirs')));
    expect(thrown(() => applySimWrites(project, race)).message).toMatch(/s-3\.json was created meanwhile; nothing was written/);
    expect(loadSims(project).items.find((i) => i.id === 's-3')?.title).toBe('Theirs');
  });

  it('a written file that would not parse: every file of the write gets its old text back, the issues are listed', () => {
    const { root, project } = repoWithSims();
    const s1 = fixture('s-1');
    const s2 = fixture('s-2');
    const before = listing(root);
    const plan = planSimWrites(project, [
      { id: 's-1', next: { ...s1.item, title: 'Changed' }, loadedText: s1.text },
      { id: 's-3', next: flow('s-3', 'New'), loadedText: null },
      { id: 's-2', next: { ...s2.item, title: 'Changed too' }, loadedText: s2.text },
    ]);
    plan.files[2].after = (plan.files[2].after as string).replace('"journey"', '"saga"');
    const err = thrown(() => applySimWrites(project, plan));
    expect(err.message.split('\n')).toEqual([
      `rolled back: ${simFileFor(project, 's-2')}: would not parse (1 issue); nothing was changed`,
      '  s-2.json: kind: must be flow or journey (found "saga")',
    ]);
    expect(err.issues).toHaveLength(1);
    expect(listing(root)).toEqual(before);
    expect(fs.readFileSync(simFileFor(project, 's-1'), 'utf8')).toBe(s1.text);
  });
});
