import { findCycles } from '../src/compare/cycles';
import path from 'path';
import { execSync } from 'child_process';
import { CLI_JS } from './helpers/runCli';

// Helper to load snapshot and get component edges
function getComponentEdges(fixtureDir: string) {
  const samplePath = path.join(__dirname, 'fixtures', fixtureDir);
  const snapshotPath = path.join(samplePath, 'snapshot.json');

  // Build the snapshot first if not present
  if (!require('fs').existsSync(snapshotPath)) {
    execSync(`node "${CLI_JS}" snapshot --repo "${samplePath}" --out /tmp/test-cycles-${fixtureDir}`, {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
    });
    const jsonPath = `/tmp/test-cycles-${fixtureDir}/snapshot.json`;
    return require(jsonPath).componentEdges;
  }

  return require(snapshotPath).componentEdges;
}

describe('cycles', () => {
  it('v1 fixture has cycle web/_root <-> web/components', () => {
    const edges = getComponentEdges('sample').map((e: any) => ({
      from: e.from,
      to: e.to,
    }));
    const cycles = findCycles(edges);
    expect(cycles).toEqual(['web/_root <-> web/components']);
  });

  it('v2 fixture has cycle api/routes <-> api/services', () => {
    const edges = getComponentEdges('sample-v2').map((e: any) => ({
      from: e.from,
      to: e.to,
    }));
    const cycles = findCycles(edges);
    expect(cycles).toEqual(['api/routes <-> api/services']);
  });

  it('detects multi-node cycle a->b->c->a', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'c', to: 'd' },
    ];
    const cycles = findCycles(edges);
    expect(cycles).toEqual(['a <-> b <-> c']);
  });

  it('returns empty array for acyclic graph', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
    ];
    const cycles = findCycles(edges);
    expect(cycles).toEqual([]);
  });

  it('returns multiple cycles sorted', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'x', to: 'y' },
      { from: 'y', to: 'z' },
      { from: 'z', to: 'x' },
    ];
    const cycles = findCycles(edges);
    expect(cycles).toContain('a <-> b');
    expect(cycles).toContain('x <-> y <-> z');
    expect(cycles.length).toBe(2);
  });

  it('returns empty array for empty edge list', () => {
    const cycles = findCycles([]);
    expect(cycles).toEqual([]);
  });
});
