/**
 * `c4pm languages` (b451): does each language grammar load and parse on this machine? Each language's smoke snippet is parsed
 * through the language's own descriptor (its static `require('tree-sitter-x')`, so it also works in the single-file binary)
 * and must give no syntax error and every expected node type. A grammar that fails is reported, never thrown.
 */
import { LANGUAGES } from '../languages/registry';
import { loadTreeSitter } from '../languages/treesitter';

export interface GrammarCheck {
  label: string;
  language: string;
  pkg: string;
  key: string | null;
  /** Installed package version; 'unknown' when it cannot be read (never a failure). */
  version: string;
  ok: boolean;
  error?: string;
}

export interface LanguageCheckResult {
  node: string;
  platform: string;
  arch: string;
  abi: string;
  treeSitter: { version?: string; error?: string };
  languages: { id: string; extensions: string[] }[];
  grammars: GrammarCheck[];
  ok: boolean;
}

/** Every node type in the tree. */
function walkTypes(node: { type: string; childCount: number; child(i: number): any }, seen: Set<string>): Set<string> {
  seen.add(node.type);
  for (let i = 0; i < node.childCount; i += 1) walkTypes(node.child(i), seen);
  return seen;
}

/** First line of an error message. */
function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message.split('\n')[0] : String(error);
}

/** Version of an installed package; 'unknown' when its package.json cannot be read (e.g. inside the binary). */
function versionOf(pkg: string): string {
  try {
    return String(require(`${pkg}/package.json`).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/** Checks every language grammar. Reads nothing but the installed packages and writes nothing. */
export function checkLanguages(): LanguageCheckResult {
  const treeSitter: LanguageCheckResult['treeSitter'] = {};
  try {
    loadTreeSitter();
    treeSitter.version = versionOf('tree-sitter');
  } catch (error) {
    treeSitter.error = errorText(error);
  }

  const grammars: GrammarCheck[] = [];
  for (const d of LANGUAGES.descriptors) {
    for (const check of d.smoke) {
      const label = check.label ?? d.id;
      const row: GrammarCheck = { label, language: d.id, pkg: check.pkg, key: check.key ?? null, version: versionOf(check.pkg), ok: false };
      try {
        const tree = d.parse(check.snippet, check.file ?? `smoke${d.extensions[0]}`);
        if (tree.rootNode.hasError) throw new Error('snippet parsed with a syntax error: ' + tree.rootNode.toString().slice(0, 200));
        const types = walkTypes(tree.rootNode, new Set());
        const missing = check.want.filter((t) => !types.has(t));
        if (missing.length > 0) throw new Error('missing node type(s): ' + missing.join(', '));
        row.ok = true;
      } catch (error) {
        row.error = errorText(error);
      }
      grammars.push(row);
    }
  }

  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    abi: process.versions.modules,
    treeSitter,
    languages: LANGUAGES.descriptors.map((d) => ({ id: d.id, extensions: d.extensions })),
    grammars,
    ok: !treeSitter.error && grammars.every((g) => g.ok),
  };
}
