import { defineLanguage } from '../define';
import { extractSwiftOutline } from './outline';
import { extractSwiftImports } from './imports';
import { createSwiftResolver } from './resolve';

// Outline and imports: `import Module` resolved through the Package.swift targets (one edge per target
// file); other modules (Apple frameworks, package dependencies) external.
export const swiftHandler = defineLanguage({
  id: 'swift',
  extensions: ['.swift'],
  grammar: () => require('tree-sitter-swift'),
  manifests: { 'Package.swift': 'Swift (SwiftPM)' },
  ignoreDirs: ['.build', 'DerivedData', 'Pods'],
  smoke: [{ pkg: 'tree-sitter-swift', want: ['class_declaration', 'function_declaration', 'protocol_declaration'],
    snippet: 'import Foundation\n\nprotocol Priced { func price() -> Int }\n\nstruct Box: Priced {\n  init() {}\n  func price() -> Int { 1 }\n}\n\nfunc add(x: Int, y: Int) -> Int { x + y }\n' }],
  // XCTest: a `test*` method (`ShopTests.testOrder`); swift-testing: a function or method marked `@Test`.
  testCases: { names: /^[^.]+\.test[^.]*$/, marks: /@Test\b/ },
  // SwiftPM: a `.testTarget` in Package.swift (the manifest above); the filter matches `Class/testMethod`.
  testRunner: {
    runners: [{ id: 'swift', detect: [{ contains: /\.testTarget\s*\(/ }], command: 'swift test --filter "{nameRegex}"' }],
    name: (n) => n.replace(/\./g, '/'),
  },
  outline: extractSwiftOutline,
  outlineTypes: true,
  imports: extractSwiftImports,
  resolver: createSwiftResolver,
});

export default swiftHandler;
