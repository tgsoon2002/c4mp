// Phase 26 (D13, D16): ids of detected test cases and what a hand link (`case '<id>'` of a plan `test` block) may name.
// L0 (src/util): read by the plan engines (src/c4) and by the plan commands (src/cli) without a skip-layer import. It
// imports nothing (not even types.ts, whose type imports reach src/view): the part of a Snapshot it reads is below.

/** The part of a Snapshot (types.ts) these helpers read. */
interface ScannedFiles { files: { file: string; role?: string; elements: { kind: string; name: string }[] }[] }

/** A test case id (D13): `file#name`, name = the outline name (`describe › it`). */
export const testCaseId = (file: string, name: string): string => `${file}#${name}`;

/** Every detected test case of a snapshot (elements of kind 'test' in role-test files), in file order. */
export function casesOfSnapshot(snapshot: ScannedFiles): { id: string; file: string; name: string }[] {
  return snapshot.files
    .filter(f => f.role === 'test')
    .flatMap(f => f.elements.filter(e => e.kind === 'test').map(e => ({ id: testCaseId(f.file, e.name), file: f.file, name: e.name })));
}

/** True when `id` is a detected test case id or a role-test file (a helper) of the snapshot: what a `case` may name. */
export function isTestRef(snapshot: ScannedFiles, id: string): boolean {
  return snapshot.files.some(f => f.role === 'test' && f.file === id) || casesOfSnapshot(snapshot).some(c => c.id === id);
}
