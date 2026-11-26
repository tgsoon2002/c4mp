import { defineLanguage } from '../define';
import { extractPhpOutline } from './outline';
import { extractPhpImports } from './imports';
import { createPhpResolver } from './resolve';

// Outline and imports: `use` names resolved through composer.json PSR-4, require/include with literal paths.
// The `php` grammar (not `php_only`) is used for every file: it also reads HTML around `<?php ... ?>`
// blocks (text / text_interpolation siblings) and parses pure PHP the same. HTML itself stays unindexed.
export const phpHandler = defineLanguage({
  id: 'php',
  extensions: ['.php', '.phtml'],
  grammar: () => require('tree-sitter-php').php,
  manifests: { 'composer.json': 'PHP (Composer)' },
  ignoreDirs: ['vendor'],
  smoke: [{ pkg: 'tree-sitter-php', key: 'php', want: ['function_definition', 'class_declaration'],
    snippet: '<html><?php\nfunction add($x, $y) { return $x + $y; }\nclass Box { public function size() { return 1; } }\n?></html>\n' }],
  // PHPUnit: a `test*` method, or one with a `@test` docblock or a `#[Test]` attribute (any namespace prefix).
  testCases: { names: /^[^.]+\.test[^.]*$/, marks: /@test\b|#\[(?:[^\]]*[\s,\\])?Test\s*[\](,]/ },
  // PHPUnit: its config file, or the package in composer.json (the manifest above); the filter matches `Class::method`.
  testRunner: {
    runners: [{ id: 'phpunit', detect: [{ file: /^phpunit\.xml(?:\.dist)?$/ }, { contains: /"phpunit\/phpunit"/ }],
      command: 'vendor/bin/phpunit --filter "{nameRegex}" {file}' }],
    name: (n) => n.replace(/\./g, '::'),
  },
  outline: extractPhpOutline,
  outlineTypes: true,
  imports: extractPhpImports,
  resolver: createPhpResolver,
});

export default phpHandler;
