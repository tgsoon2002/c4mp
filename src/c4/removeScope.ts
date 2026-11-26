import type { Plan, PlanElement } from '../types';
import { log } from '../log';

const TAG = 'remove';

export interface RemovalRelation {
  from: string;
  to: string;
  file: string;
  line: number;
  insideBlock: boolean;   // the relation line lies inside the removed block (it goes away with it)
  manual: boolean;        // the relation has a multi-line `{ ... }` body: never removed automatically
}

export type RemovalScope =
  | { ok: false; reason: string }
  | {
      ok: true;
      blocked: boolean;                                    // true when otherFileChildren is not empty
      block: { file: string; startLine: number; endLine: number };
      removedElements: string[];                           // fqn of the element plus all nested children
      relations: RemovalRelation[];
      otherFileChildren: string[];                         // children whose lines are not inside the block
    };

// Source text of one line without string contents and without a trailing `//` comment,
// so quotes and comments cannot hide or fake a brace or an identifier.
// Strings follow the lexer (lexer.ts): `\` + the quote char or `\` is an escape, any other `\` is literal.
// quoteC4String (editMeta.ts) writes `\'` and `\\`, so a title like `it's // x` must stay inside its string.
function code(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < line.length && line[i] !== ch) {
        i += line[i] === '\\' && (line[i + 1] === ch || line[i + 1] === '\\') ? 2 : 1;
      }
      i++;   // closing quote (an unterminated string runs to the end of the line)
      out += '""';
    } else if (ch === '/' && line[i + 1] === '/') {
      break;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function fail(fqn: string, reason: string): RemovalScope {
  log(TAG, 'scope refused', { fqn, reason });
  return { ok: false, reason };
}

/** All elements whose `parent` chain reaches fqn (children, grandchildren, ...). */
export function descendants(plan: Plan, fqn: string): PlanElement[] {
  const byId = new Map(plan.elements.map(e => [e.id, e] as const));
  const out: PlanElement[] = [];
  for (const e of plan.elements) {
    let p = e.parent;
    const seen = new Set<string>();
    while (p !== null && !seen.has(p)) {
      if (p === fqn) { out.push(e); break; }
      seen.add(p);
      p = byId.get(p)?.parent ?? null;
    }
  }
  return out;
}

/**
 * Whole-line span of one element's block (`source.line..endLine` in its file), shared by `plan remove` and `plan move`.
 * Refused when the block shares its first or last line with other text (another element, a brace of the parent, text
 * after the closing brace), so cutting these lines takes exactly this element and its nested children.
 */
export function blockSpan(texts: Map<string, string>, plan: Plan, fqn: string):
  { ok: true; file: string; startLine: number; endLine: number } | { ok: false; reason: string } {
  const el = plan.elements.find(e => e.id === fqn);
  if (!el) return { ok: false, reason: `unknown element ${fqn}` };
  const { file, line: startLine, endLine } = el.source;
  if (endLine === undefined) return { ok: false, reason: `element ${fqn} has no end line` };
  const text = texts.get(file);
  if (text === undefined) return { ok: false, reason: `no text for ${file}` };

  const lines = text.split(/\r?\n/);
  const first = code(lines[startLine - 1] ?? '');
  const last = code(lines[endLine - 1] ?? '');
  const ident = fqn.slice(fqn.lastIndexOf('.') + 1);
  const startsWithIdent = first.trimStart().startsWith(ident) && !/[\w-]/.test(first.trimStart().charAt(ident.length));
  const closeAt = last.lastIndexOf('}');
  const textAfterClose = closeAt >= 0 && last.slice(closeAt + 1).trim() !== '';
  const kidIds = new Set(descendants(plan, fqn).map(k => k.id));
  // another element (not part of the block) that starts on the first or last line of the block
  const neighbour = plan.elements.some(e =>
    e.id !== fqn && !kidIds.has(e.id) && e.source.file === file && (e.source.line === startLine || e.source.line === endLine));
  // the block's own braces must balance, else a brace of the parent (e.g. `a = container 'A' }`) shares the line
  const blockCode = lines.slice(startLine - 1, endLine).map(code).join('\n');
  const unbalanced = (blockCode.match(/\{/g) ?? []).length !== (blockCode.match(/\}/g) ?? []).length;
  if (!startsWithIdent || textAfterClose || neighbour || unbalanced) return { ok: false, reason: 'block shares a line with other text' };
  return { ok: true, file, startLine, endLine };
}

/**
 * What removing one plan element would touch. Pure: nothing is edited or diffed (planRemoval does that).
 * `texts` key = repo-relative plan file, the same string as PlanElement.source.file.
 * Relations are matched on the exact text as written: `from`/`to` equal to fqn or starting with `fqn + '.'`.
 * Short names written inside a body (`auth -> db`) are NOT matched, and a relation whose both ends are
 * short names inside the removed block is not listed (it still goes away with the block).
 */
export function planRemovalScope(texts: Map<string, string>, plan: Plan, fqn: string): RemovalScope {
  const span = blockSpan(texts, plan, fqn);
  if (!span.ok) return fail(fqn, span.reason);
  const { file, startLine, endLine } = span;
  const kids = descendants(plan, fqn);
  const inBlock = (f: string, ln: number) => f === file && ln >= startLine && ln <= endLine;
  const otherFileChildren = kids.filter(k => !inBlock(k.source.file, k.source.line)).map(k => k.id);

  const mentions = (t: string) => t === fqn || t.startsWith(fqn + '.');
  const relations: RemovalRelation[] = plan.relations
    .filter(r => mentions(r.from) || mentions(r.to))
    .map(r => {
      const rl = code((texts.get(r.source.file) ?? '').split(/\r?\n/)[r.source.line - 1] ?? '');
      return {
        from: r.from,
        to: r.to,
        file: r.source.file,
        line: r.source.line,
        insideBlock: inBlock(r.source.file, r.source.line),
        manual: rl.includes('{') && !rl.includes('}'),
      };
    });

  const result: RemovalScope = {
    ok: true,
    blocked: otherFileChildren.length > 0,
    block: { file, startLine, endLine },
    removedElements: [fqn, ...kids.map(k => k.id)],
    relations,
    otherFileChildren,
  };
  log(TAG, 'scope', { fqn, blocked: result.blocked, elements: result.removedElements.length, relations: relations.length });
  return result;
}
