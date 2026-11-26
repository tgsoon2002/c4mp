import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { toId } from '../src/names';
import { runCli as spawnCli } from './helpers/runCli';

// P6-T11: CLI wiring.
//
// (1) `view` command: buildView (src/page/html.ts, landed P6-T9) parses a repo's .c4 plan and
// threads it into buildViewModel, so a claim-mode plan's containers render with the plan's
// title/technology. But P6-T9's own runSnapshot call never passed that parsed plan into
// buildSnapshot (src/snapshot/build.ts) -- confirmed by an actual `view` CLI run against a
// plan-only fixture before this task's fix: the plan's declared *component* never appeared in
// the rendered tree at all (snapshot.components stayed empty, folder-mode, since
// groupComponents found zero files), even though the plan's *container* rendered correctly via
// buildViewModel's own container-union logic. This task threads the parsed plan through
// runSnapshot -> buildSnapshot so claim-mode components reach the Snapshot in production CLI
// use, not just in direct buildSnapshot(input, plan)/buildViewModel(snapshot, summary, plan)
// unit tests.
//
// (2) `generate-c4` command: when no `--out` is given, default output directory is now
// `<repoRoot>/<config.architectureDir>` when that's configured, else (P12-T9) the .c4mp planDir.

const projectRoot = path.resolve(__dirname, '..');

function runCli(args: string[]) {
  return spawnCli([...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

/** Extract the embedded `window.C4PM_DATA = {...};` payload from a rendered view HTML file. */
function extractViewData(html: string): any {
  const match = html.match(/window\.C4PM_DATA = (.*);<\/script>/);
  if (!match) {
    throw new Error('window.C4PM_DATA not found in rendered HTML');
  }
  return JSON.parse(match[1]);
}

describe('CLI view: claim-mode plan reaches the rendered tree end-to-end (P6-T11)', () => {
  function buildPlanOnlyRepo(): string {
    // A plan-only fixture: the .c4 plan declares a container + a claim-mode component (one
    // function-level link), but the linked file (src/orders.ts) does not exist on disk -- so the
    // snapshot has zero source files, matching the roadmap's "zero or minimal src files" test
    // shape. Only src/index.ts exists, unrelated to the plan, so container/component weights stay
    // at their zero-code placeholder.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-t11-view-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'architecture.c4'),
      `specification {
  element system
  element container
  element component
}

model {
  app = system 'App' {
    api = container 'API' { technology 'Node, Telegram bot' }
  }
}
`
    );

    fs.writeFileSync(
      path.join(srcDir, 'feature.c4'),
      `model {
  extend app.api {
    orders = component 'Orders' {
      technology 'TypeScript'
      link ./orders.ts#placeOrder 'Entry'
      metadata {
        status 'in-progress'
      }
    }
  }
}
`
    );

    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const unrelated = 1;\n');

    return tmpDir;
  }

  it('produces an HTML whose embedded data has the plan\'s container and component, not an empty system', () => {
    const repo = buildPlanOnlyRepo();
    const outFile = path.join(repo, 'view.html');
    try {
      const result = runCli(['view', '--repo', repo, '--out', outFile]);
      expect(result.status).toBe(0);

      const html = fs.readFileSync(outFile, 'utf8');
      const data = extractViewData(html);

      // Before the fix: summary read "0 components" and no 'app.api.orders' node existed anywhere
      // in the tree -- the plan's container rendered (via buildViewModel's own union logic) but
      // with zero children, because snapshot.components was built folder-mode (empty) regardless
      // of the plan.
      expect(data.summary).toContain('1 components');

      const findNode = (node: any, id: string): any => {
        if (node.id === id) return node;
        for (const child of node.children ?? []) {
          const found = findNode(child, id);
          if (found) return found;
        }
        return null;
      };

      const container = findNode(data.root, 'app.api');
      expect(container).toBeTruthy();
      expect(container.name).toBe('API');
      expect(container.detail).toBe('Node, Telegram bot');

      const component = findNode(data.root, 'app.api.orders');
      expect(component).toBeTruthy();
      expect(component.name).toBe('Orders');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('CLI generate-c4: architectureDir default output (P6-T11)', () => {
  function buildRepo(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-t11-gen-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export function foo() {}\n');
    return tmpDir;
  }

  it('writes under <repoRoot>/<architectureDir> when configured and no --out is given', () => {
    const repo = buildRepo();
    try {
      fs.writeFileSync(
        path.join(repo, '.c4pmrc.json'),
        JSON.stringify({ architectureDir: 'Documents/C4' }, null, 2)
      );

      const result = runCli(['plan', 'generate', '--repo', repo]);
      expect(result.status).toBe(0);

      const expectedDir = path.join(repo, 'Documents', 'C4');
      expect(fs.existsSync(path.join(expectedDir, 'architecture.c4'))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('defaults to the .c4mp planDir (P12-T9, was out/<repoId>/c4) when architectureDir is not configured', () => {
    const repo = buildRepo();
    // The tmp repo has no anchor of its own; a .git marker makes it the anchor (P12-T9).
    fs.mkdirSync(path.join(repo, '.git'));
    const repoId = toId(path.basename(repo));
    const planDir = path.join(repo, '.c4mp', 'projects', repoId, 'plan');
    try {
      const result = runCli(['plan', 'generate', '--repo', repo]);
      expect(result.status).toBe(0);

      expect(fs.existsSync(path.join(planDir, 'architecture.c4'))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
