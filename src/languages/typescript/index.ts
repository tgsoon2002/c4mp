import { defineLanguage, type TestRunnerProbe } from '../define';
import { parseSource } from './language';
import { extractOutline } from './outline';
import { extractCalls } from './calls';
import { addTestCases, TEST_NAME_SEP } from './tests';
import { extractImports } from './imports';
import { createResolver } from './resolve';

// TypeScript and JavaScript: two grammars (typescript, tsx) picked by extension in language.ts,
// outline with export / IIFE / arrow forms, imports resolved by the TypeScript compiler, call sites,
// test cases of test files (describe / it / test, Phase 26).

// A test runner in package.json: a dependency or config key named `tool`, or a script that runs it.
const npmUses = (tool: string): TestRunnerProbe =>
  ({ file: 'package.json', contains: new RegExp(`"${tool}"\\s*:|:\\s*"(?:[^"\\n]*[\\s&;|])?${tool}[\\s"]`) });

export const typescriptHandler = defineLanguage({
  id: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  parse: (code, file) => parseSource(code, file).tree,
  smoke: [
    { label: 'typescript', pkg: 'tree-sitter-typescript', key: 'typescript', want: ['function_declaration', 'class_declaration'],
      snippet: 'import { a } from "./a";\nexport function add(x: number, y: number): number { return x + y; }\nexport class Box { size = 1; }\n' },
    { label: 'tsx', file: 'smoke.tsx', pkg: 'tree-sitter-typescript', key: 'tsx', want: ['function_declaration', 'class_declaration', 'jsx_element'],
      snippet: 'export function App() { return <div>hi</div>; }\nexport class Box {}\n' },
  ],
  outline: extractOutline,
  outlineTypes: true,
  imports: extractImports,
  calls: extractCalls,
  tests: addTestCases,
  // jest, vitest and mocha match a case by its describe chain joined with spaces.
  testRunner: {
    runners: [
      { id: 'jest', detect: [npmUses('jest'), { file: /^jest\.config\.(?:[cm]?[jt]s|json)$/ }], command: 'npx jest {file} -t "{nameRegex}"' },
      { id: 'vitest', detect: [npmUses('vitest'), { file: /^vitest\.config\.[cm]?[jt]s$/ }], command: 'npx vitest run {file} -t "{nameRegex}"' },
      { id: 'mocha', detect: [npmUses('mocha'), { file: /^\.mocharc\.(?:[cm]?js|json|ya?ml)$/ }], command: 'npx mocha {file} --grep "{nameRegex}"' },
    ],
    name: (n) => n.split(TEST_NAME_SEP).join(' '),
  },
  resolver: createResolver,
});

export default typescriptHandler;
