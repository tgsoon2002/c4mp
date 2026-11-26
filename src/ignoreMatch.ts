// B18: the ONE matcher for ignore patterns, used by the source walk, .c4 discovery, container
// discovery and the watcher. A pattern (repo-relative, '/' separators) is one of:
//   - a directory prefix or exact file path: `dist`, `src/gen`, `src/a.ts` (the old behaviour)
//   - a glob with `*` (any chars except '/'), `**` (any chars incl. '/'; `**/` = zero or more
//     folders) and `?` (one char except '/'): `**/*.test.ts`, `src/*/gen`
// A path is ignored when it, or any parent folder of it, matches. Patterns are anchored at the repo root.

export interface IgnoreMatcher {
  /** True when `relPath` (repo-relative, '/' separators), or a parent folder of it, matches a pattern. */
  matches(relPath: string): boolean;
  /** Patterns that never matched anything asked so far (call after the walk). */
  unmatched(): string[];
}

const GLOB_CHARS = /[*?]/;

/** Strip a leading `./` and a trailing `/` (same rule as config.ts normalizeIgnore). */
function normalizePattern(entry: string): string {
  let n = entry.trim();
  if (n.startsWith('./')) n = n.slice(2);
  if (n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function createIgnoreMatcher(patterns: string[] | undefined): IgnoreMatcher {
  const compiled = (patterns ?? [])
    .map(normalizePattern)
    .filter((p) => p !== '')
    .map((p) => ({
      pattern: p,
      test: GLOB_CHARS.test(p) ? globToRegExp(p) : null,
      hit: false,
    }));

  return {
    matches(relPath: string): boolean {
      if (compiled.length === 0) return false;
      // the path itself, then each parent folder: 'a/b/c.ts' -> 'a', 'a/b', 'a/b/c.ts'
      const parts = relPath.split('/');
      let found = false;
      for (const c of compiled) {
        let prefix = '';
        for (const part of parts) {
          prefix = prefix === '' ? part : prefix + '/' + part;
          if (c.test ? c.test.test(prefix) : prefix === c.pattern) {
            c.hit = true;
            found = true;
            break;
          }
        }
      }
      return found;
    },
    unmatched(): string[] {
      return compiled.filter((c) => !c.hit).map((c) => c.pattern);
    },
  };
}
