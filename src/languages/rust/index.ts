import { defineLanguage } from '../define';
import { extractRustOutline } from './outline';
import { extractRustImports } from './imports';
import { createRustResolver } from './resolve';

// Outline and imports (`use`, `mod x;`, `extern crate`). Resolution follows the module tree and the
// Cargo.toml crate names (see imports.ts and resolve.ts); no call graph.
export const rustHandler = defineLanguage({
  id: 'rust',
  extensions: ['.rs'],
  grammar: () => require('tree-sitter-rust'),
  ignoreDirs: ['target'],
  smoke: [{ pkg: 'tree-sitter-rust', want: ['function_item', 'struct_item'],
    snippet: 'use std::fmt;\n\nstruct Box { size: u32 }\n\nfn add(x: i32, y: i32) -> i32 { x + y }\n' }],
  // `#[test]`, or a runtime's `#[tokio::test]` / `#[async_std::test(...)]`, above the fn.
  testCases: { marks: /#\[\s*(?:\w+::)*test\s*[\](]/ },
  // `cargo test <filter>` runs the tests whose path contains the filter, in every test target.
  testRunner: {
    runners: [{ id: 'cargo', detect: [{ file: 'Cargo.toml' }], command: 'cargo test "{name}"' }],
    name: (n) => n.replace(/\./g, '::'),
  },
  outline: extractRustOutline,
  outlineTypes: true,
  imports: extractRustImports,
  // the resolver reads the items a file declares with this handler's own parser
  resolver: (repoRoot, sourceFiles) => createRustResolver(repoRoot, sourceFiles, rustHandler.parse),
});

export default rustHandler;
