import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseC4 } from '../src/plan/parser';
import { runSnapshot } from '../src/pipeline';
import { buildViewModel } from '../src/view/model';
import type { Plan, ViewNode } from '../src/types';

// Phase 34 F1 (b933): c4pm runs from the git root. A scanned (manifest) container whose folder a plan container links,
// or where its components claim code, is that plan container: drawn once. A scanned container with no code and no plan
// element is not drawn. Folder-mode plans keep their scanned containers.
const C4_FILE = '.c4pm/projects/t/plan/arch.c4';

const CLAIM_PLAN = [
  'model {',
  "  sys = system 'Sys' {",
  "    prog = container 'Program' {",
  '      link ../../../../app/',
  "      core = component 'Core' {",
  '        link ../../../../app/src/core.ts#run',
  '      }',
  '    }',
  "    backend = container 'Service' {",
  '      link ../../../../svc/',
  "      api = component 'Api' {",
  '        link ../../../../svc/src/main.rs',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const FOLDER_PLAN = [
  'model {',
  "  sys = system 'Sys' {",
  "    prog = container 'Program' {",
  "      core = component 'Core'",
  '    }',
  '  }',
  '}',
].join('\n');

function planFrom(text: string): Plan {
  const r = parseC4(text, C4_FILE);
  return { files: [C4_FILE], elements: r.elements.sort((a, b) => a.id.localeCompare(b.id)), relations: r.relations, issues: r.issues };
}

function containersOf(root: ViewNode): ViewNode[] {
  const out: ViewNode[] = [];
  const walk = (n: ViewNode): void => {
    if (n.kind === 'container') out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

describe('a scanned container merges into the plan container that links or claims it (Phase 34 F1)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-found-merge-'));
    fs.mkdirSync(path.join(repo, 'app', 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'svc', 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'package.json'), '{"name":"app"}\n');
    fs.writeFileSync(path.join(repo, 'app', 'src', 'core.ts'), 'export function run() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(repo, 'app', 'src', 'loose.ts'), 'export function unclaimed() {\n  return 2;\n}\n');
    fs.writeFileSync(path.join(repo, 'svc', 'Cargo.toml'), '[package]\nname = "svc"\n');
    fs.writeFileSync(path.join(repo, 'svc', 'src', 'main.rs'), '');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const view = (plan: Plan) => {
    const snapshot = runSnapshot({ repo, write: false, quiet: true, config: { languages: ['typescript', 'rust'] }, plan });
    return { snapshot, model: buildViewModel(snapshot, 's', plan) };
  };

  it('claim mode: exactly the plan containers, no scanned duplicate, unclaimed code stays visible as unassigned', () => {
    const { snapshot, model } = view(planFrom(CLAIM_PLAN));
    expect(snapshot.containers.map((c) => c.path).sort()).toEqual(['app', 'svc']);   // the scan still finds both
    const cs = containersOf(model.root);
    expect(cs.map((c) => c.id).sort()).toEqual(['sys.backend', 'sys.prog']);
    expect(cs.some((c) => c.detail === 'no parsed code')).toBe(false);
    const ids = JSON.stringify(model.root);
    expect(ids).toContain('unclaimed');
  });

  it('plan-only copy (no code, only the plan): no stray scanned container', () => {
    fs.rmSync(path.join(repo, 'app'), { recursive: true });
    fs.rmSync(path.join(repo, 'svc'), { recursive: true });
    const { model } = view(planFrom(CLAIM_PLAN));
    expect(containersOf(model.root).map((c) => c.id).sort()).toEqual(['sys.backend', 'sys.prog']);
  });

  it('a scanned container with no code and no plan element is not drawn in claim mode', () => {
    fs.mkdirSync(path.join(repo, 'other'));
    fs.writeFileSync(path.join(repo, 'other', 'package.json'), '{"name":"other"}\n');
    const { snapshot, model } = view(planFrom(CLAIM_PLAN));
    expect(snapshot.containers.some((c) => c.path === 'other')).toBe(true);
    expect(containersOf(model.root).map((c) => c.id).sort()).toEqual(['sys.backend', 'sys.prog']);
  });

  it('a scanned container two plan containers link is not merged (still not drawn when it has no code)', () => {
    const plan = planFrom(CLAIM_PLAN.replace("api = component 'Api' {\n        link ../../../../svc/src/main.rs", "api = component 'Api' {\n        link ../../../../app/src/loose.ts#unclaimed"));
    const { model } = view(plan);
    expect(containersOf(model.root).map((c) => c.id).sort()).toEqual(['sys.backend', 'sys.prog']);
  });

  it('folder mode (no function claim): scanned containers are drawn as before', () => {
    const { model } = view(planFrom(FOLDER_PLAN));
    const names = containersOf(model.root).map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names).toEqual(expect.arrayContaining(['app', 'svc'].map((n) => expect.stringMatching(new RegExp(n, 'i')))));
  });
});
