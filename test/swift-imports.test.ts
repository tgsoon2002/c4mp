import * as fs from 'fs';
import * as path from 'path';
import { swiftHandler } from '../src/languages/swift';
import { extractSwiftImports } from '../src/languages/swift/imports';
import { createSwiftResolver, packageTargets } from '../src/languages/swift/resolve';

const parseSwift = (code: string) => swiftHandler.parse(code, '');

const FIX = path.join(__dirname, 'fixtures/swiftshop');
const FILES = [
  'Kit/Format.swift', 'Kit/Kit.swift', 'Package.swift',
  'Sources/Shop/Shop.swift', 'Sources/Shop/Util/Money.swift', 'Tests/ShopTests/ShopTests.swift',
];

describe('Swift imports', () => {
  it('extracts the module path of every import form, also inside #if', () => {
    const code = [
      'import Foundation',
      '@testable import Alamofire',
      '@_spi(Internal) import Alamofire',
      '@_spi(A) @testable import Shop',
      '@_exported import Combine',
      '@preconcurrency import Dispatch',
      'import struct Foundation.URL',
      'internal import os.log',
      '#if canImport(UIKit)',
      'import UIKit',
      '#endif',
      'func f() {}',
    ].join('\n');
    expect(extractSwiftImports(parseSwift(code)).map((i) => [i.spec, i.line, i.kind])).toEqual([
      ['Foundation', 1, 'import'], ['Alamofire', 2, 'import'], ['Alamofire', 3, 'import'], ['Shop', 4, 'import'],
      ['Combine', 5, 'import'], ['Dispatch', 6, 'import'], ['Foundation.URL', 7, 'import'], ['os.log', 8, 'import'],
      ['UIKit', 10, 'import'],
    ]);
  });

  it('reads the targets of Package.swift: name, path, kind; not dependencies or comments', () => {
    const text = fs.readFileSync(path.join(FIX, 'Package.swift'), 'utf8');
    expect(packageTargets(text)).toEqual([
      { name: 'Shop', kind: 'target' },
      { name: 'ShopKit', kind: 'target', path: 'Kit' },
      { name: 'Empty', kind: 'target' },
      { name: 'ShopTests', kind: 'testTarget' },
    ]);
  });

  it('resolves the swiftshop fixture: targets to all their files, other modules external', () => {
    const resolve = createSwiftResolver(FIX, FILES);
    const results: Record<string, unknown> = {};
    for (const file of FILES) {
      const tree = parseSwift(fs.readFileSync(path.join(FIX, file), 'utf8'));
      for (const imp of extractSwiftImports(tree)) results[`${file} ${imp.spec}`] = resolve(file, imp.spec);
    }
    const shop = ['Sources/Shop/Shop.swift', 'Sources/Shop/Util/Money.swift'];
    expect(results).toEqual({
      'Kit/Kit.swift Foundation': { status: 'external', pkg: 'Foundation' },
      'Kit/Kit.swift Shop': { status: 'internal', target: shop[0], targets: shop },
      'Package.swift PackageDescription': { status: 'external', pkg: 'PackageDescription' },
      'Sources/Shop/Shop.swift Foundation': { status: 'external', pkg: 'Foundation' },
      'Tests/ShopTests/ShopTests.swift XCTest': { status: 'external', pkg: 'XCTest' },
      // default folder Sources/Shop; @testable and @_spi change nothing
      'Tests/ShopTests/ShopTests.swift Shop': { status: 'internal', target: shop[0], targets: shop },
      // path: "Kit"
      'Tests/ShopTests/ShopTests.swift ShopKit': { status: 'internal', target: 'Kit/Format.swift', targets: ['Kit/Format.swift', 'Kit/Kit.swift'] },
      'Tests/ShopTests/ShopTests.swift Collections': { status: 'external', pkg: 'Collections' },
      'Tests/ShopTests/ShopTests.swift Foundation.URL': { status: 'external', pkg: 'Foundation' },
      'Tests/ShopTests/ShopTests.swift Empty': { status: 'unresolved', reason: 'target-has-no-files' },
      // commented out in Package.swift: not a target
      'Tests/ShopTests/ShopTests.swift Old': { status: 'external', pkg: 'Old' },
    });
  });

  it('an import of the own target from one of its files points at the other files only', () => {
    const resolve = createSwiftResolver(FIX, FILES);
    expect(resolve('Sources/Shop/Shop.swift', 'Shop')).toEqual({ status: 'internal', target: 'Sources/Shop/Util/Money.swift' });
  });
});
