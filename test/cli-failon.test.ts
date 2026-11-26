import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from './helpers/runCli';

// P6-T3 (d): `check --fail-on` used to read the raw `opts.failOn` CLI flag directly, ignoring the
// merged `cliConfig.failOn` that `loadConfig` builds from `.c4pmrc.json` (file < env < CLI
// precedence). This builds a temp repo with a `.c4` plan that produces a critical `missing-code`
// finding (a component with status 'done' whose link points at a file that doesn't exist on disk),
// and runs `check` through the real CLI via ts-node, matching this project's existing CLI test
// convention (see test/cli-phase4.test.ts).

const projectRoot = path.resolve(__dirname, '..');

function buildTempRepo(withConfig: boolean): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-failon-'));
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
    missing = component 'Missing Feature' {
      technology 'TypeScript'
      link ./does-not-exist.ts 'Entrypoint'
      metadata {
        status 'done'
      }
    }
  }
}
`
  );

  fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

  if (withConfig) {
    fs.writeFileSync(
      path.join(tmpDir, '.c4pmrc.json'),
      JSON.stringify({ failOn: 'critical' }, null, 2)
    );
  }

  return tmpDir;
}

function runCheck(repo: string) {
  return runCli(['check', '--repo', repo], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('CLI check --fail-on reads merged config, not just the raw flag', () => {
  it('exits 1 when .c4pmrc.json sets failOn: critical, even with no --fail-on flag', () => {
    const repo = buildTempRepo(true);
    try {
      const result = runCheck(repo);
      expect(result.stdout).toContain('missing-code');
      expect(result.status).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 with no config file and no --fail-on flag (unchanged default)', () => {
    const repo = buildTempRepo(false);
    try {
      const result = runCheck(repo);
      expect(result.stdout).toContain('missing-code');
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
