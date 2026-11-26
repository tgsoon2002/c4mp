import * as fs from 'fs';
import * as path from 'path';
import type { CodeElement, FileOutline, LanguageHandler } from '../types';
import type { TestCasePattern } from './define';
import { LANGUAGES } from './registry';
import { handlerFor } from './index';
import { log } from '../log';

// Phase 26 (T26-5): test cases of the tree-sitter languages. A language says in its descriptor (`testCases`)
// how a test case looks; the scan marks the matching functions and methods of role-test files as kind 'test'
// (name and line range unchanged, so the id stays `file#name`). A source file is never marked: a `test_x`
// helper outside the test globs stays a function. The pattern type, `TestCasePattern`, is in define.ts.

const CASE_KINDS = new Set(['function', 'method']);
// A line that only annotates the next declaration: attribute, decorator or comment (trimmed). Also src/edit/span.ts.
export const ANNOTATION_LINE = /^(?:@|#\[|\[|\/\/|\/\*|\*)/;

/** The header text of an element (`lines` are the file's lines; element lines are 1-based). */
function headerOf(lines: string[], el: CodeElement): string {
  let top = el.startLine - 1;
  while (top > 0 && ANNOTATION_LINE.test(lines[top - 1].trim())) top--;
  let decl = el.startLine - 1;
  while (decl < el.endLine - 1 && ANNOTATION_LINE.test(lines[decl].trim())) decl++;
  return lines.slice(top, decl + 1).join('\n');
}

/** Mark the test cases of one test file's outline as kind 'test', in place. Returns how many were marked. */
export function markTestCases(outline: FileOutline, code: string, pattern: TestCasePattern): number {
  const lines = pattern.marks ? code.split('\n') : [];
  let marked = 0;
  for (const el of outline.elements) {
    if (!CASE_KINDS.has(el.kind)) continue;
    if (pattern.names?.test(el.name) || (pattern.marks && pattern.marks.test(headerOf(lines, el)))) {
      el.kind = 'test';
      marked++;
    }
  }
  return marked;
}

/** The test-case pattern of a language, if it has one. */
export function testCasePattern(languageId: string): TestCasePattern | undefined {
  return LANGUAGES.handlers[languageId]?.testCases;
}

/**
 * Scan step: mark the test cases of every role-test file (`testFiles`) whose language has a pattern, in place.
 * `outlines` are the scan's own copies (the parse cache clones in and out), so marking never reaches the cache.
 */
export function markTestFiles(repoRoot: string, outlines: FileOutline[], testFiles: string[], handlers: LanguageHandler[]): void {
  const isTest = new Set(testFiles);
  let files = 0;
  let cases = 0;
  for (const outline of outlines) {
    if (!isTest.has(outline.file)) continue;
    const handler = handlerFor(outline.file, handlers);
    const pattern = handler && testCasePattern(handler.id);
    if (!pattern) continue;
    const code = pattern.marks ? fs.readFileSync(path.join(repoRoot, outline.file), 'utf8') : '';
    cases += markTestCases(outline, code, pattern);
    files++;
  }
  log('pipeline', 'test-cases', { files, cases });
}
