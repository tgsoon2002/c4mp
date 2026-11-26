import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cppHandler } from '../src/languages/cpp';
import { extractCppImports } from '../src/languages/cpp/imports';
import { cmakeIncludeDirs, createCppResolver } from '../src/languages/cpp/resolve';

const parseCpp = (code: string) => cppHandler.parse(code, '');

const FIX = path.join(__dirname, 'fixtures/cppshop');
const FILES = ['include/shop/util.h', 'libs/gtest/gtest/gtest.h', 'src/main.cpp', 'src/order.cpp', 'src/order.hpp'];

describe('C++ imports', () => {
  it('extracts quoted and system includes, also inside #ifdef and namespaces; skips macro includes', () => {
    const code = '#include "a/b.h"\n#include <vector>\n#  include "c.h" // x\n#include MACRO\n#ifdef X\n#include "in_if.h"\n#endif\nnamespace n {\n#include "ns.h"\n}\n';
    const specs = extractCppImports(parseCpp(code)).map((i) => [i.spec, i.line]);
    expect(specs).toEqual([['a/b.h', 1], ['<vector>', 2], ['c.h', 3], ['in_if.h', 6], ['ns.h', 9]]);
  });

  it('reads include dirs of include_directories / target_include_directories in a CMakeLists.txt', () => {
    const text = [
      '# include_directories(commented/out)',
      'add_library(x STATIC a.cc)',
      'target_include_directories(x SYSTEM BEFORE PUBLIC . "quoted dir" PRIVATE ../shared)',
      'INCLUDE_DIRECTORIES(${CMAKE_CURRENT_SOURCE_DIR}/gen $<BUILD_INTERFACE:api> $<INSTALL_INTERFACE:include>)',
      'include_directories(${PROJECT_SOURCE_DIR}/include /usr/include ../../../outside) # x',
    ].join('\n');
    expect(cmakeIncludeDirs(text, 'libs/x')).toEqual(['libs/x', 'libs/x/quoted dir', 'libs/shared', 'libs/x/gen', 'libs/x/api']);
    expect(cmakeIncludeDirs('include_directories(.)', '')).toEqual(['']);
  });

  it('resolves the cppshop fixture: file folder, include dir, CMake include dir, system, external, unresolved', () => {
    const resolve = createCppResolver(FIX, FILES);
    const results: Record<string, unknown> = {};
    for (const file of FILES) {
      const tree = parseCpp(fs.readFileSync(path.join(FIX, file), 'utf-8'));
      for (const imp of extractCppImports(tree)) results[`${file} ${imp.spec}`] = resolve(file, imp.spec);
    }
    expect(results).toEqual({
      'src/main.cpp <vector>': { status: 'external', pkg: 'vector' },
      'src/main.cpp <sys/types.h>': { status: 'external', pkg: 'sys' },
      'src/main.cpp order.hpp': { status: 'internal', target: 'src/order.hpp' },
      'src/main.cpp shop/util.h': { status: 'internal', target: 'include/shop/util.h' },
      'src/main.cpp missing.h': { status: 'unresolved', reason: 'header not found' },
      // libs/gtest/CMakeLists.txt: target_include_directories(gtest SYSTEM PUBLIC .)
      'src/main.cpp gtest/gtest.h': { status: 'internal', target: 'libs/gtest/gtest/gtest.h' },
      // found nowhere in the repo and no repo folder is named absl: a third-party library
      'src/main.cpp absl/strings/str_cat.h': { status: 'external', pkg: 'absl' },
      // shop/ is a repo folder: a missing repo header, not a library
      'src/main.cpp shop/missing.h': { status: 'unresolved', reason: 'header not found' },
      'src/order.cpp order.hpp': { status: 'internal', target: 'src/order.hpp' },
      'src/order.hpp <string>': { status: 'external', pkg: 'string' },
    });
  });

  it('uses -I dirs from compile_commands.json (command and arguments forms) instead of the defaults', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-cc-'));
    try {
      fs.writeFileSync(
        path.join(root, 'compile_commands.json'),
        JSON.stringify([
          { directory: root, file: 'a.cpp', command: 'c++ -I libs/core -Iinc "-Iquoted dir" -c a.cpp' },
          { directory: root, file: 'b.cpp', arguments: ['c++', '-isystem', 'third/x', '-I/outside/repo'] },
        ])
      );
      fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'include_directories(include)\n');
      const files = ['a.cpp', 'libs/core/core.h', 'inc/i.h', 'third/x/t.h', 'include/d.h'];
      const resolve = createCppResolver(root, files);
      expect(resolve('a.cpp', 'core.h')).toEqual({ status: 'internal', target: 'libs/core/core.h' });
      expect(resolve('a.cpp', 'i.h')).toEqual({ status: 'internal', target: 'inc/i.h' });
      expect(resolve('a.cpp', '<t.h>')).toEqual({ status: 'internal', target: 'third/x/t.h' });
      // default dirs (include/) and CMake dirs are not used once compile_commands lists -I dirs
      expect(resolve('a.cpp', 'd.h')).toEqual({ status: 'unresolved', reason: 'header not found' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when compile_commands.json is broken', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-cc-'));
    try {
      fs.writeFileSync(path.join(root, 'compile_commands.json'), '{not json');
      const resolve = createCppResolver(root, ['a.cpp', 'include/d.h']);
      expect(resolve('a.cpp', 'd.h')).toEqual({ status: 'internal', target: 'include/d.h' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
