import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { depsOf } from '../src/query/deps';
import type { DepsFileGroup } from '../src/query/deps';
import { getModel } from '../src/query/elements';
import { formatDeps } from '../src/query/format';
import { runSnapshot } from '../src/pipeline';
import { historyDir, saveToHistory } from '../src/history/store';

// b467: `c4pm deps <element> --files` = the import lines behind each arrow (usesFiles / usedByFiles).

const FIX = path.join(__dirname, 'fixtures');
const tmps: string[] = [];
afterAll(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

function copy(name: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qdfiles-'));
  tmps.push(tmp);
  const repo = path.join(tmp, name);   // the folder name is the repo name (pyshop's container id)
  fs.cpSync(path.join(FIX, name), repo, { recursive: true });
  return repo;
}

const PLAN = `specification {
  element system
  element container
  element component
}

model {
  shop = system 'Shop' {
    api = container 'API'
    web = container 'Web'
  }
  shop.api -> shop.web 'calls'
}
`;

/** sample + web -> api/lib (one import line) + a test file importing the same target + a container-level plan relation. */
function sampleCtx(): QueryContext {
  const repo = copy('sample');
  fs.writeFileSync(path.join(repo, 'web/src/components/Api.ts'), "import { log } from '../../../api/src/lib/log';\nexport const x = log;\n");
  fs.writeFileSync(path.join(repo, 'web/src/components/Api.test.ts'), "import { log } from '../../../api/src/lib/log';\nlog('t');\n");
  fs.writeFileSync(path.join(repo, 'architecture.c4'), PLAN);
  return loadQueryContext(repo);
}

const API_LINE = {
  file: 'web/src/components/Api.ts', line: 1, spec: '../../../api/src/lib/log', kind: 'import',
  target: 'api/src/lib/log.ts', names: ['log'],
};
const edgesOf = (groups: DepsFileGroup[] | undefined): { id: string; title: string; weight: number }[] =>
  (groups ?? []).map(({ imports: _i, ...e }) => e);
const pairs = (g: DepsFileGroup): number => new Set(g.imports.map((i) => `${i.file}>${i.target}`)).size;

/** Every container, layer and component of the map. */
function boxes(ctx: QueryContext): { id: string; kind: string }[] {
  const out: { id: string; kind: string }[] = [];
  const walk = (n: any): void => {
    if (['container', 'subregion', 'component'].includes(n.kind)) out.push({ id: n.id, kind: n.kind });
    [...(n.subregions ?? []), ...n.children].forEach(walk);
  };
  walk(getModel(ctx).root);
  return out;
}

describe('depsOf with files (b467)', () => {
  const ctx = sampleCtx();

  it('the import line behind a cross-container arrow, with the names the file binds; the test file importing it is left out', () => {
    const web = depsOf(ctx, 'web', { files: true });
    expect(web.usesFiles!.find((g) => g.id === 'api')!.imports).toEqual([API_LINE]);
    // used by: the same line seen from api (the line is in the other box, the target in this one)
    const api = depsOf(ctx, 'api', { files: true });
    expect(api.usedByFiles!.find((g) => g.id === 'web')!.imports).toEqual([API_LINE]);
    // api -> web exists only as a plan relation: the arrow is listed, with no lines
    expect(api.usesFiles).toEqual([{ id: 'web', title: 'Web', weight: 1, imports: [] }]);
  });

  it('the groups are the arrows (same ids, titles, weights, order); file pairs = weight for every component (no relation there)', () => {
    let lines = 0;
    for (const { id, kind } of boxes(ctx)) {
      const r = depsOf(ctx, id, { files: true });
      expect(edgesOf(r.usesFiles)).toEqual(r.uses);
      expect(edgesOf(r.usedByFiles)).toEqual(r.usedBy);
      for (const g of [...r.usesFiles!, ...r.usedByFiles!]) {
        expect(g.imports.length).toBeGreaterThanOrEqual(pairs(g));
        if (kind === 'component') expect(pairs(g)).toBe(g.weight);
        lines += g.imports.length;
        for (const i of g.imports) expect(i.file.endsWith('.test.ts')).toBe(false);
      }
    }
    expect(lines).toBeGreaterThan(0);
  });

  it('without files the result has no usesFiles / usedByFiles keys (JSON as before)', () => {
    const plain = depsOf(ctx, 'web');
    expect(Object.keys(plain)).not.toContain('usesFiles');
    expect(Object.keys(plain)).not.toContain('usedByFiles');
    const withFiles = depsOf(ctx, 'web', { files: true });
    const { usesFiles: _u, usedByFiles: _b, ...rest } = withFiles;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  });

  it('text: each line indented under its arrow as file:line -> target { names }', () => {
    const text = formatDeps(depsOf(ctx, 'web', { files: true }));
    expect(text).toContain('uses:\n  api  Api  x1\n    web/src/components/Api.ts:1  -> api/src/lib/log.ts { log }\n');
  });

  it('claim mode with layers: component and layer, arrow weight 2 (import + plan relation) over one line', () => {
    const layered = loadQueryContext(copy('layers-claim'));
    const pages = depsOf(layered, 'shop.web.pages', { files: true });
    expect(pages.usesFiles).toEqual([{
      id: 'shop.api.logic.orders', title: 'Orders', weight: 2,
      imports: [{ file: 'web/src/page.ts', line: 1, spec: '../../api/src/orders', kind: 'import', target: 'api/src/orders.ts', names: ['placeOrder'] }],
    }]);
    const logic = depsOf(layered, 'shop.api.logic', { files: true });
    expect(logic.usesFiles!.map((g) => [g.id, g.imports.map((i) => `${i.file}:${i.line} -> ${i.target}`)])).toEqual([
      ['shop.api.data', ['api/src/orders.ts:1 -> api/src/store.ts']],
    ]);
  });

  it('a language without import bindings (PHP): lines with no names', () => {
    const php = loadQueryContext(copy('phpshop'), { cli: { languages: ['php'] } });
    const r = depsOf(php, 'phpshop/models', { files: true });
    expect(r.usesFiles).toEqual([{
      id: 'phpshop/util', title: 'Util', weight: 1,
      imports: [{ file: 'src/Models/Order.php', line: 6, spec: 'Shop\\Util\\Money', kind: 'import', target: 'src/Util/Money.php', names: [] }],
    }]);
  });

  it('Python has import bindings since b592: `from shop import create_app` names create_app', () => {
    const py = loadQueryContext(copy('pyshop'), { cli: { languages: ['python'] } });
    const r = depsOf(py, 'pyshop/_root', { files: true });
    expect(r.usesFiles).toEqual([{
      id: 'pyshop/shop', title: 'Shop', weight: 1,
      imports: [{ file: 'run.py', line: 1, spec: 'shop', kind: 'import', target: 'shop/__init__.py', names: ['create_app'] }],
    }]);
  });
});

describe('Snapshot.imports stays in memory (b467)', () => {
  it('runSnapshot has it; snapshot.json and a history save do not', () => {
    const repo = copy('sample');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qdfiles-out-'));
    tmps.push(out);
    const snap = runSnapshot({ repo, out, quiet: true });
    expect(snap.imports!.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'snapshot.json'), 'utf8'))).not.toHaveProperty('imports');
    const entry = saveToHistory(out, snap);
    expect(JSON.parse(fs.readFileSync(path.join(historyDir(out, snap.system.id), entry.file), 'utf8'))).not.toHaveProperty('imports');
  });
});
