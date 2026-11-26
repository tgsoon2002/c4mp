import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../log';
import type { ResolveResult } from '../../types';
import { createResolverKit, external, internalAll, unresolved } from '../resolveKit';

const MANIFEST = 'Package.swift';
// Target kinds that hold Swift sources; a binaryTarget or systemLibrary has none (its import is external).
const TARGET_CALL = /\.(target|executableTarget|testTarget|macro|plugin)\s*\(/g;
// SwiftPM's default source roots, in its search order; test targets look in Tests/ first, plugins in Plugins/.
const SOURCE_ROOTS = ['Sources', 'Source', 'src', 'srcs'];
const FIRST_ROOTS: Record<string, string[]> = { testTarget: ['Tests'], plugin: ['Plugins'] };

export interface SwiftTarget {
  name: string;
  /** Target folder relative to the package folder, as written in `path:`; absent: the SwiftPM default. */
  path?: string;
  kind: string;
}

/**
 * The targets of one Package.swift (text): `.target`, `.executableTarget`, `.testTarget`, `.macro` and
 * `.plugin` calls with their `name:` and optional `path:` string arguments. Comments are ignored. A
 * call inside another one (a `.target(name:)` dependency) is not a target. Read as text, not run.
 */
export function packageTargets(text: string): SwiftTarget[] {
  const code = text.replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ' '));
  const targets: SwiftTarget[] = [];
  const label = /(name|path)\s*:\s*"([^"]*)"/y;
  TARGET_CALL.lastIndex = 0;
  for (let m = TARGET_CALL.exec(code); m; m = TARGET_CALL.exec(code)) {
    const args: Record<string, string> = {};
    let depth = 0;
    let i = m.index + m[0].length - 1;   // at the '('
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"') {
        for (i++; i < code.length && code[i] !== '"'; i++) if (code[i] === '\\') i++;
      } else if ('([{'.includes(ch)) {
        depth++;
      } else if (')]}'.includes(ch)) {
        if (--depth === 0) break;
      } else if (depth === 1 && !/\w/.test(code[i - 1])) {
        label.lastIndex = i;
        const arg = label.exec(code);
        if (arg && !(arg[1] in args)) args[arg[1]] = arg[2];
      }
    }
    TARGET_CALL.lastIndex = i + 1;   // nested calls are dependencies, not targets
    if (args.name) targets.push({ name: args.name, kind: m[1], ...(args.path !== undefined && { path: args.path }) });
  }
  return targets;
}

/**
 * Swift resolver. `import Foo` (first segment of `Foo.Bar`) names a module: a target of a Package.swift
 * in the repo points at every scanned .swift file in the target's folder (one edge per file; the
 * importing file itself only when it is the only one); a target with no scanned file is unresolved
 * 'target-has-no-files'. Any other module (Foundation, XCTest, UIKit, a package dependency) is external,
 * pkg = the module name. Not modelled: Xcode project targets (no Package.swift), `exclude:` and
 * `sources:` of a target, Package@swift-x.y.swift variants.
 */
export function createSwiftResolver(repoRoot: string, sourceFiles: string[]): (fromFile: string, spec: string) => ResolveResult {
  const kit = createResolverKit('swift', repoRoot, sourceFiles);
  const swiftFiles = sourceFiles.filter((f) => f.endsWith('.swift'));
  const filesUnder = (dir: string): string[] => swiftFiles.filter((f) => !dir || f.startsWith(`${dir}/`));

  const filesOf = new Map<string, Set<string>>();   // module (target name) -> its files
  for (const manifest of swiftFiles.filter((f) => path.posix.basename(f) === MANIFEST).sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, manifest), 'utf8');
    } catch (err) {
      log('swift-resolve', 'manifest-unreadable', { file: manifest, error: String(err) });
      continue;
    }
    const pkgDir = kit.dirOf(manifest);
    const targets = packageTargets(text);
    for (const t of targets) {
      const dirs = t.path !== undefined
        ? [t.path]
        : [...(FIRST_ROOTS[t.kind] ?? []), ...SOURCE_ROOTS].map((root) => `${root}/${t.name}`);
      const full = dirs.map((d) => path.posix.normalize(path.posix.join(pkgDir || '.', d)).replace(/^\.$/, '').replace(/\/$/, ''));
      const files = full.map(filesUnder).find((list) => list.length > 0) ?? [];
      if (!filesOf.has(t.name)) filesOf.set(t.name, new Set());
      files.forEach((f) => filesOf.get(t.name)!.add(f));
    }
    log('swift-resolve', 'manifest', { file: manifest, targets: targets.length });
  }

  return kit.resolver((fromFile: string, spec: string): ResolveResult => {
    const module = spec.split('.')[0];
    const files = filesOf.get(module);
    if (!files) return external(module);
    if (files.size === 0) return unresolved('target-has-no-files');
    const others = [...files].filter((f) => f !== fromFile);
    return internalAll(others.length > 0 ? others : [...files]);
  });
}
