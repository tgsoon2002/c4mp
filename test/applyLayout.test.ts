import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { formatApplyLayoutReport, parseLayoutFile, readLayoutFile, mapNodeToElement } from '../src/c4/applyLayout';
import type { LayoutFile } from '../src/c4/applyLayout';
import { applyLayoutService } from '../src/services/planFileEdits';
import { listC4Files } from '../src/plan/files';
import { parsePlan } from '../src/plan/parser';
import { runCli } from './helpers/runCli';

const projectRoot = path.resolve(__dirname, '..');

const ARCH = `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' { technology 'Node' }
    web = container 'Web' { technology 'React' }
  }
}
`;
const FEATURE = `model {
  extend app.api {
    orders = component 'Orders' {
      technology 'TypeScript'
      metadata {
        status 'in-progress'
      }
    }
  }
  extend app.web {
    checkout = component 'Checkout' {
      technology 'React'
    }
  }
}
`;

// SV2 (b678): apply-layout goes through the plan write gate; these plans sit in <dir>/c4/ (outside .c4pm/), so force.
const applyLayout = (dir: string, layout: LayoutFile, dryRun: boolean) =>
  applyLayoutService(dir, layout, { yes: !dryRun, force: true }).report;

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-applylayout-'));
  fs.mkdirSync(path.join(dir, 'c4'));
  fs.writeFileSync(path.join(dir, 'c4', 'architecture.c4'), ARCH);
  fs.writeFileSync(path.join(dir, 'c4', 'feature.c4'), FEATURE);
  return dir;
}
function snapshotBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listC4Files(dir)) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return out;
}
function plan(dir: string) {
  return parsePlan(dir, listC4Files(dir));
}

const LAYOUT = {
  version: 2 as const,
  nodes: {
    'app.api.orders': { bx: 300, by: 200, rx: 1200, ry: 860, rw: 33178, rh: 23922 },
    'app.web.checkout': { rx: 10, ry: 20, rw: 30, rh: 40 },
    web: { rx: 1, ry: 2, rw: 3, rh: 4 }, // bare container id -> app.web
    app: { rx: 0, ry: 0, rw: 100, rh: 100 }, // system id
    'app.api.ghost': { rx: 1, ry: 1, rw: 1, rh: 1 },
    'app.api.orders::slice::x.ts': { rx: 1, ry: 1, rw: 1, rh: 1 },
  },
};

describe('applyLayout', () => {
  test('writes layout metadata; rest of plan unchanged; unknown ids skipped', () => {
    const dir = makeRepo();
    const before = plan(dir);
    const r = applyLayout(dir, LAYOUT, false);
    expect(r.applied).toBe(4);
    expect(r.unchanged).toBe(0);
    expect(r.failed).toEqual([]);
    expect(r.skipped.map(s => s.nodeId).sort()).toEqual(
      ['app.api.ghost', 'app.api.orders::slice::x.ts']
    );
    expect(r.files.map(f => f.file).sort()).toEqual(['c4/architecture.c4', 'c4/feature.c4']);

    const after = plan(dir);
    const layouts: Record<string, string | undefined> = {};
    for (const e of after.elements) layouts[e.id] = e.metadata.layout;
    expect(layouts).toEqual({
      app: ';0,0,100,100',
      'app.api': undefined,
      'app.web': ';1,2,3,4',
      'app.api.orders': '300,200;1200,860,33178,23922',
      'app.web.checkout': ';10,20,30,40',
    });
    // Everything except the layout key is identical.
    const strip = (p: ReturnType<typeof plan>) =>
      p.elements.map(e => {
        const { layout, ...metadata } = e.metadata as Record<string, string>;
        return { ...e, metadata, source: undefined };
      });
    expect(strip(after)).toEqual(strip(before));
    expect(after.relations).toEqual(before.relations);
    expect(after.issues).toEqual(before.issues);
  });

  test('dry run changes nothing on disk but reports the same edits', () => {
    const dir = makeRepo();
    const bytes = snapshotBytes(dir);
    const r = applyLayout(dir, LAYOUT, true);
    expect(snapshotBytes(dir)).toEqual(bytes);
    expect(r.dryRun).toBe(true);
    expect(r.applied).toBe(4);
    expect(r.files.length).toBe(2);
  });

  test('second run is a no-op', () => {
    const dir = makeRepo();
    applyLayout(dir, LAYOUT, false);
    const bytes = snapshotBytes(dir);
    const r = applyLayout(dir, LAYOUT, false);
    expect(r.applied).toBe(0);
    expect(r.unchanged).toBe(4);
    expect(r.files).toEqual([]);
    expect(snapshotBytes(dir)).toEqual(bytes);
  });

  test('values are rounded to integers; bx without by fails that node only', () => {
    const dir = makeRepo();
    const r = applyLayout(
      dir,
      {
        version: 2,
        nodes: {
          'app.api.orders': { rx: 1.4, ry: 2.6, rw: 3, rh: 4 },
          'app.web.checkout': { bx: 5, rx: 1, ry: 1, rw: 1, rh: 1 },
        },
      },
      false
    );
    expect(r.applied).toBe(1);
    expect(r.failed.map(f => f.nodeId)).toEqual(['app.web.checkout']);
    const el = plan(dir).elements.find(e => e.id === 'app.api.orders')!;
    expect(el.metadata.layout).toBe(';1,3,3,4');
  });

  test('ambiguous bare container id is skipped, not guessed', () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(dir, 'c4', 'architecture.c4'),
      ARCH.replace("web = container 'Web' { technology 'React' }\n  }", "web = container 'Web' { technology 'React' }\n  }\n  other = system 'Other' {\n    web = container 'Web2' { technology 'x' }\n  }")
    );
    const m = mapNodeToElement(plan(dir), 'web');
    expect('reason' in m && m.reason).toMatch(/ambiguous/);
  });
});

describe('layout file validation', () => {
  test.each([
    ['not json {', /not valid JSON/],
    ['{"version":1,"nodes":{}}', /unsupported layout version/],
    ['{"nodes":{}}', /unsupported layout version/],
    ['{"version":2}', /no "nodes"/],
  ])('rejects %s', (text, re) => {
    expect(() => parseLayoutFile(text)).toThrow(re);
  });
  test('missing file', () => {
    expect(() => readLayoutFile('/nonexistent/layout.json')).toThrow(/cannot read/);
  });
});

describe('apply-layout CLI', () => {
  function run(args: string[]) {
    return runCli(['plan', 'apply-layout', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
  }

  test('applies, then is idempotent; dry-run writes nothing; bad files exit non-zero', () => {
    const dir = makeRepo();
    const lf = path.join(dir, 'layout.json');
    fs.writeFileSync(lf, JSON.stringify(LAYOUT));
    const bytes = snapshotBytes(dir);

    const refused = run(['--repo', dir, '--file', lf, '--dry-run']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('error: outside-c4pm: outside .c4mp/ (use --force):');
    expect(snapshotBytes(dir)).toEqual(bytes);

    const dry = run(['--repo', dir, '--file', lf, '--dry-run', '--force']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would write c4/feature.c4');
    expect(snapshotBytes(dir)).toEqual(bytes);

    const first = run(['--repo', dir, '--file', lf, '--force']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('applied 4, unchanged 0, skipped 2, failed 0');
    expect(first.stdout).toContain('skipped app.api.ghost');
    const second = run(['--repo', dir, '--file', lf, '--force']);
    expect(second.stdout).toContain('applied 0, unchanged 4, skipped 2, failed 0');

    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{oops');
    expect(run(['--repo', dir, '--file', bad, '--force']).status).not.toBe(0);
    fs.writeFileSync(bad, '{"version":1,"nodes":{}}');
    const v1 = run(['--repo', dir, '--file', bad, '--force']);
    expect(v1.status).not.toBe(0);
    expect(v1.stderr).toContain('unsupported layout version');
    expect(run(['--repo', dir, '--force']).status).not.toBe(0);
  }, 60000);
});

describe('applyLayout null entry', () => {
  const LAYOUT_NULL = { version: 2 as const, nodes: { 'app.api.orders': null, 'app.web.checkout': null } };

  test('null removes layout, keeps other metadata, dry run writes nothing, second run unchanged', () => {
    const dir = makeRepo();
    applyLayout(dir, LAYOUT, false);
    const withLayout = snapshotBytes(dir);

    const dry = applyLayout(dir, LAYOUT_NULL, true);
    expect(snapshotBytes(dir)).toEqual(withLayout);
    expect(dry.applied).toBe(2);

    const r = applyLayout(dir, LAYOUT_NULL, false);
    expect(r.applied).toBe(2);
    expect(r.failed).toEqual([]);
    const els = plan(dir).elements;
    expect(els.find(e => e.id === 'app.api.orders')!.metadata).toEqual({ status: 'in-progress' });
    expect(els.find(e => e.id === 'app.web.checkout')!.metadata.layout).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'c4', 'feature.c4'), 'utf8')).not.toContain('layout');

    const again = applyLayout(dir, LAYOUT_NULL, false);
    expect(again.applied).toBe(0);
    expect(again.unchanged).toBe(2);
    expect(again.files).toEqual([]);
  });

  test('report says layout removed', () => {
    const dir = makeRepo();
    applyLayout(dir, LAYOUT, false);
    const out = formatApplyLayoutReport(applyLayout(dir, LAYOUT_NULL, true));
    expect(out).toContain('app.api.orders  layout removed');
  });
});
