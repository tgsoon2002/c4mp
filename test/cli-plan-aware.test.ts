import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli as spawnCli } from './helpers/runCli';

// P14-T24: `check`, `status`, `stubs` and `resolve-link` build the snapshot with the parsed plan,
// exactly as `view` does (src/page/html.ts buildView). Before the fix they ran runSnapshot without
// the plan, so a claim-mode plan's components were missing from their snapshot.

const projectRoot = path.resolve(__dirname, '..');
const sampleDir = path.resolve(__dirname, 'fixtures/sample');

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

/** Claim-mode plan: one container with one component whose link names a function. */
function buildClaimModeRepo(status = 'in-progress'): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4mp-t24-'));
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
    api = container 'API' { technology 'Node' }
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
        status '${status}'
      }
    }
  }
}
`
  );

  fs.writeFileSync(
    path.join(srcDir, 'orders.ts'),
    'export function placeOrder(id: string): string {\n  return id;\n}\n'
  );

  return tmpDir;
}

/** The component count from the `Snapshot: ...` line that `status` prints. */
function statusComponentCount(stdout: string): number {
  const match = stdout.match(/Snapshot: .*?(\d+) components/);
  if (!match) throw new Error(`no component count in status output: ${stdout}`);
  return Number(match[1]);
}

describe('P14-T24: check/status/stubs/resolve-link are plan-aware', () => {
  it('status and view report the same component count on a claim-mode repo', () => {
    const repo = buildClaimModeRepo();
    const outFile = path.join(repo, 'view.html');
    try {
      const status = runCli(['status', '--repo', repo]);
      expect(status.status).toBe(0);
      const statusCount = statusComponentCount(status.stdout);

      const view = runCli(['view', '--repo', repo, '--out', outFile]);
      expect(view.status).toBe(0);
      const data = extractViewData(fs.readFileSync(outFile, 'utf8'));
      const viewCount = Number(data.summary.match(/(\d+) components/)[1]);

      expect(statusCount).toBe(1);
      expect(viewCount).toBe(statusCount);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('check on the sample fixture (no .c4 plan) prints the stored message', () => {
    const result = runCli(['check', '--repo', sampleDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('no .c4 files found; run c4mp plan generate to start a plan\n');
  });

  it('b566: check --format json with no plan prints [] on stdout and the message on stderr', () => {
    const result = runCli(['check', '--repo', sampleDir, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('[]\n');
    expect(JSON.parse(result.stdout)).toEqual([]);
    // toContain: the fixture sits inside this repo, whose anchor holds the c4mp project, so stderr also has the b564 note.
    expect(result.stderr).toContain('no .c4 files found; run c4mp plan generate to start a plan\n');
  });

  it('check on a claim-mode repo with a done component finds its code (no missing-code)', () => {
    const repo = buildClaimModeRepo('done');
    try {
      const result = runCli(['check', '--repo', repo, '--format', 'json']);
      expect(result.status).toBe(0);
      const findings = JSON.parse(result.stdout);
      const missing = findings.filter((f: any) => f.rule === 'missing-code');
      expect(missing).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('resolve-link still resolves a function link on a claim-mode repo', () => {
    const repo = buildClaimModeRepo();
    try {
      const result = runCli(['plan', 'resolve-link', 'src/orders.ts#placeOrder', '--repo', repo]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('placeOrder');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
