import { defineLanguage } from '../define';
import { extractCppOutline, TEST_MACROS } from './outline';
import { extractCppImports } from './imports';
import { createCppResolver } from './resolve';

// Words that start a declaration: an ALL_CAPS word right before one is an export / attribute macro (`FMT_EXPORT class`,
// `FMT_CONSTEXPR inline void f()`). Not `const`: `FOO const*` is a valid type.
const DECLARATION_START = 'template|class|struct|union|enum|namespace|inline|static|constexpr|consteval|extern|virtual|explicit'
  + '|friend|typedef|using|void|auto|bool|char|int|unsigned|signed|long|short|double|float';
const MACRO = '[A-Z][A-Z0-9_]*[A-Z0-9]';   // ALL_CAPS, two characters or more
// Likely macros, blanked only when a file has parse errors (define.ts retryMacros, b573), each alternative a form seen in
// fmt and nlohmann/json: `X_NAMESPACE_BEGIN` / `X_NAMESPACE_END` alone on a line; an ALL_CAPS word before a declaration
// word; one between `class|struct|union` and the name (`class JSON_API name`, not `class A final`); a line holding only an
// ALL_CAPS word above a `template|class|struct` line (`NLOHMANN_BASIC_JSON_TPL_DECLARATION`).
const RETRY_MACROS = new RegExp([
  String.raw`^[ \t]*[A-Z_][A-Z0-9_]*_NAMESPACE_(?:BEGIN|END)(?=[ \t]*\r?$)`,
  String.raw`\b${MACRO}(?=[ \t]+(?:${DECLARATION_START})\b)`,
  String.raw`(?<=\b(?:class|struct|union)[ \t]+)${MACRO}(?=[ \t]+(?!final\b)[A-Za-z_])`,
  String.raw`^[ \t]*${MACRO}[ \t]*(?=\r?\n[ \t]*(?:template|class|struct)\b)`,
].join('|'), 'gm');

// Outline and #include imports; no stubs (an empty C++ body is normal). '.h' is treated as C++: the C++
// grammar also parses C headers. CMakeLists.txt needs no manifest here: it is already in MANIFESTS.
export const cppHandler = defineLanguage({
  id: 'cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
  grammar: () => require('tree-sitter-cpp'),
  // A line holding only `X_BEGIN_NAMESPACE` / `X_END_NAMESPACE` (fmt, Qt): a macro for `namespace x {` / `}`.
  // Blanked, so the declarations inside parse; namespaces add no element or name prefix anyway.
  blankMacros: /^[ \t]*[A-Z_][A-Z0-9_]*_(?:BEGIN|END)_NAMESPACE(?=[ \t]*\r?$)/gm,
  retryMacros: RETRY_MACROS,
  ignoreDirs: ['cmake-build-*'],
  smoke: [{ pkg: 'tree-sitter-cpp', want: ['function_definition', 'class_specifier', 'struct_specifier'],
    snippet: '#include <vector>\nstruct Pt { int x; };\nclass Box { public: int size() { return 1; } };\nint add(int x, int y) { return x + y; }\n' }],
  // gtest bodies, named by their macro call (`TEST(Suite, Name)`, outline.ts).
  testCases: { names: new RegExp(`^(?:${[...TEST_MACROS].join('|')})\\(`) },
  // gtest: no runner command, the test binary is known only to the build. `{name}` of a config template is
  // gtest's filter form, `TEST(Suite, Name)` -> `Suite.Name`.
  testRunner: {
    runners: [],
    name: (n) => n.replace(/^\w+\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/, '$1.$2'),
    unknown: 'the gtest binary is known only to the build (CMake)',
  },
  outline: extractCppOutline,
  outlineTypes: true,
  imports: extractCppImports,
  resolver: createCppResolver,
});

export default cppHandler;
