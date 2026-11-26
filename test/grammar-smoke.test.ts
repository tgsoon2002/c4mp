import { spawnSync } from 'child_process';
import path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'grammar-smoke.js');
const LANGUAGES = ['typescript', 'tsx', 'python', 'rust', 'c-sharp', 'php', 'cpp', 'swift'];

describe('scripts/grammar-smoke.js', () => {
  it('runs with plain node, prints one PASS line per language and exits 0', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    const lines = run.stdout.split('\n');
    expect(run.status).toBe(0);
    for (const language of LANGUAGES) {
      expect(lines.filter((line) => line.startsWith(`PASS ${language} (`))).toHaveLength(1);
    }
    expect(lines.filter((line) => line.startsWith('SKIP '))).toEqual([]);
    expect(run.stdout).toMatch(/ABI \(process\.versions\.modules\): \d+/);
  });
});
