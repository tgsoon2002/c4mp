import * as fs from 'fs';
import { findStubs } from '../src/query/stubs';
import { resolveLink } from '../src/query/resolveLink';
import { makeRepo, writeSource } from './helpers/planEditHarness';
import type { C4pmConfig } from '../src/types';

// b471 (C1/P3/P4): the Query functions behind `c4pm plan stubs` and `c4pm plan resolve-link`.
// A claim-mode repo: the plan claims src/orders.ts#placeOrder; two stub functions in two files.
describe('findStubs and resolveLink (Query layer)', () => {
  let root: string;
  beforeAll(() => {
    const repo = makeRepo('c4pm-query-plan-code-', {});
    root = repo.root;
    const link = writeSource(root, repo.planDir, 'src/orders.ts',
      'export function placeOrder(id: string): string {\n  return id;\n}\n\nexport function todo(): void {}\n');
    writeSource(root, repo.planDir, 'src/later.ts', "export function later(): number {\n  throw new Error('not implemented');\n}\n");
    fs.writeFileSync(`${repo.planDir}/arch.c4`,
      `model {\n  app = system 'App' {\n    api = container 'API' {\n      orders = component 'Orders' {\n        link ${link}#placeOrder\n      }\n    }\n  }\n}\n`);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const LATER = { file: 'src/later.ts', name: 'later', startLine: 1, stub: 'throws' };
  const TODO = { file: 'src/orders.ts', name: 'todo', startLine: 5, stub: 'empty' };
  it.each<[string, Partial<C4pmConfig>, object[]]>([
    ['every stub, files in scan order', {}, [LATER, TODO]],
    ['--ignore drops a file', { ignore: ['src/later.ts'] }, [TODO]],
    ['--lang without the language finds none', { languages: ['python'] }, []],
  ])('findStubs: %s', (_label, cli, expected) => {
    expect(findStubs(root, cli)).toEqual(expected);
  });

  it.each<[string, object]>([
    ['src/orders.ts#placeOrder', { target: 'function', exists: true, found: true, range: { start: 1, end: 3 } }],
    ['src/orders.ts#missing', { target: 'function', exists: true, found: false, range: null }],
    ['src/orders.ts#L2-L3', { target: 'lines', exists: true, range: { start: 2, end: 3 } }],
    ['src/orders.ts', { target: 'file', exists: true }],
    ['src/nope.ts', { target: 'file', exists: false }],
  ])('resolveLink %s', (target, expected) => {
    expect(resolveLink(root, {}, target)).toMatchObject({ elementId: 'link', ...expected });
  });
});
