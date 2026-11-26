import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  historyDir,
  entryId,
  saveToHistory,
  loadManifest,
  loadFromHistory,
  resolveRef,
} from '../src/history/store';
import { Snapshot } from '../src/types';

// Create a temporary store directory
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-store-'));
console.log(`[try-store] storeRoot: ${storeRoot}`);

// Create 3 synthetic snapshots
const snapshot1: Snapshot = {
  schemaVersion: 2,
  meta: {
    tool: 'c4pm@0.1.0',
    repoPath: '/tmp/repo',
    repoName: 'sample-shop',
    createdAt: '2026-01-03T10:00:00.000Z',  // Latest createdAt, no git
    git: null,
  },
  system: { id: 'sample-shop', name: 'Sample Shop' },
  containers: [
    { id: 'api', name: 'API', path: 'api', tech: 'Node.js', manifest: null },
  ],
  components: [],
  files: [],
  componentEdges: [],
  fileEdges: [],
  externals: [],
  stats: {
    containers: 3,
    components: 7,
    files: 8,
    codeElements: 12,
    componentEdges: 7,
    unresolvedImports: 1,
  },
};

const snapshot2: Snapshot = {
  schemaVersion: 2,
  meta: {
    tool: 'c4pm@0.1.0',
    repoPath: '/tmp/repo',
    repoName: 'sample-shop',
    createdAt: '2026-01-01T11:00:00.000Z',
    git: {
      commit: 'bbbbbbb2222222222',
      branch: 'main',
      date: '2026-01-02T10:00:00Z',  // Second date
      depth: 2,
    },
  },
  system: { id: 'sample-shop', name: 'Sample Shop' },
  containers: [],
  components: [],
  files: [],
  componentEdges: [],
  fileEdges: [],
  externals: [],
  stats: {
    containers: 3,
    components: 7,
    files: 7,
    codeElements: 11,
    componentEdges: 6,
    unresolvedImports: 1,
  },
};

const snapshot3: Snapshot = {
  schemaVersion: 2,
  meta: {
    tool: 'c4pm@0.1.0',
    repoPath: '/tmp/repo',
    repoName: 'sample-shop',
    createdAt: '2026-01-01T10:00:00.000Z',
    git: {
      commit: 'aaaaaaa1111111111',
      branch: 'main',
      date: '2026-01-01T10:00:00Z',  // Earliest date
      depth: 1,
    },
  },
  system: { id: 'sample-shop', name: 'Sample Shop' },
  containers: [],
  components: [],
  files: [],
  componentEdges: [],
  fileEdges: [],
  externals: [],
  stats: {
    containers: 3,
    components: 6,
    files: 6,
    codeElements: 10,
    componentEdges: 5,
    unresolvedImports: 0,
  },
};

// Save snapshots in mixed order
console.log('\n[try-store] Saving snapshots...');
const entry1 = saveToHistory(storeRoot, snapshot1);
console.log(`[try-store] Saved snapshot 1: ${entry1.id}`);

const entry2 = saveToHistory(storeRoot, snapshot2);
console.log(`[try-store] Saved snapshot 2: ${entry2.id}`);

const entry3 = saveToHistory(storeRoot, snapshot3);
console.log(`[try-store] Saved snapshot 3: ${entry3.id}`);

// Load and display manifest
const manifest = loadManifest(storeRoot, 'sample-shop');
console.log('\n[try-store] Manifest:');
console.log(JSON.stringify(manifest, null, 2));

// Test resolveRef with various forms
console.log('\n[try-store] Testing resolveRef:');

const testRefs = [
  'latest',
  'oldest',
  'prev',
  entry3.id,  // exact id
  'aaaa',      // commit prefix
  'bbbb',      // commit prefix
  '2026-01-01',  // date
  '2026-01-02',  // date
  '2026-01-03',  // date
];

for (const ref of testRefs) {
  try {
    const result = resolveRef(manifest, ref);
    console.log(`[try-store] resolveRef('${ref}') → ${result.id}`);
  } catch (err) {
    console.log(`[try-store] resolveRef('${ref}') → ERROR: ${(err as Error).message}`);
  }
}

// Test date after all snapshots (should return latest)
console.log(`[try-store] resolveRef('2026-12-31') → ${resolveRef(manifest, '2026-12-31').id} (returns latest because date is after all snapshots)`);

// Test error cases
console.log('\n[try-store] Testing error cases:');

const errorRefs = [
  'unknown-ref',
  'zzzz',  // unknown commit prefix
  '2025-12-31',  // date before all snapshots
];

for (const ref of errorRefs) {
  try {
    resolveRef(manifest, ref);
    console.log(`[try-store] resolveRef('${ref}') → UNEXPECTED SUCCESS`);
  } catch (err) {
    console.log(`[try-store] resolveRef('${ref}') → ERROR: ${(err as Error).message}`);
  }
}

// Test prev with single entry
console.log('\n[try-store] Testing prev with single entry:');
const singleEntryManifest = { ...manifest, entries: manifest.entries.slice(0, 1) };
try {
  resolveRef(singleEntryManifest, 'prev');
  console.log(`[try-store] resolveRef('prev') on single entry → UNEXPECTED SUCCESS`);
} catch (err) {
  console.log(`[try-store] resolveRef('prev') on single entry → ERROR: ${(err as Error).message}`);
}

// Test saving same commit again (upsert)
console.log('\n[try-store] Testing upsert (save same commit again):');
const manifest2 = loadManifest(storeRoot, 'sample-shop');
console.log(`[try-store] Entries before re-save: ${manifest2.entries.length}`);

saveToHistory(storeRoot, snapshot3);  // Save snapshot3 again
const manifest3 = loadManifest(storeRoot, 'sample-shop');
console.log(`[try-store] Entries after re-save: ${manifest3.entries.length}`);

// Test loading a snapshot
console.log('\n[try-store] Testing loadFromHistory:');
const loaded = loadFromHistory(storeRoot, 'sample-shop', entry3);
console.log(`[try-store] Loaded snapshot: ${loaded.meta.repoName}`);
console.log(`[try-store] Loaded stats: ${JSON.stringify(loaded.stats)}`);

// Cleanup
fs.rmSync(storeRoot, { recursive: true, force: true });
console.log(`\n[try-store] Cleaned up ${storeRoot}`);
