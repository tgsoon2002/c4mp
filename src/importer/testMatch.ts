// Phase 26 (T26-1): which scanned files are tests, and which files never lift a test case (tests.ignoreReach).
// The ONE place for config `tests` patterns. Patterns use the ignore syntax (../ignoreMatch.ts: folder prefix, file
// path or glob with * ** ?; a path matches when it or a parent folder does), so a folder pattern `**/test/` marks
// every file below a folder named `test`.

import type { TestsConfig } from '../types';
import { createIgnoreMatcher } from '../ignoreMatch';

/** Default `tests.globs`: the usual test file and test folder names of the supported languages, at any depth. */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*', '**/*.spec.*',
  '**/test/', '**/tests/', '**/Tests/', '**/__tests__/',
  '**/test_*.py', '**/*_test.*',
  '**/*Test.php', '**/*Tests.cs', '**/*Test.cs',
];

/** The patterns that mark test files: config `tests.globs` when set (an empty list = no test files), else the defaults. */
export const testGlobs = (tests: TestsConfig | undefined): string[] => [...(tests?.globs ?? DEFAULT_TEST_GLOBS)];

/** Predicate: is this repo-relative path ('/' separators) a test file? */
export function testFileMatcher(tests: TestsConfig | undefined): (relPath: string) => boolean {
  const m = createIgnoreMatcher(testGlobs(tests));
  return (relPath) => m.matches(relPath);
}

/** The test files among `files` (same order). */
export function testFilesOf(files: string[], tests: TestsConfig | undefined): string[] {
  const isTest = testFileMatcher(tests);
  return files.filter(isTest);
}

/** Predicate: does config `tests.ignoreReach` list this file (its calls never lift a test case)? No default. */
export function ignoreReachMatcher(tests: TestsConfig | undefined): (relPath: string) => boolean {
  const m = createIgnoreMatcher(tests?.ignoreReach);
  return (relPath) => m.matches(relPath);
}
