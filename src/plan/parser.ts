import * as fs from 'fs';
import * as path from 'path';
import { tokenize, Token } from './lexer';
import { parseLink } from './links';
import { canonicalKind } from './renames';
import type { PlanElement, PlanRelation, ParseIssue, Plan } from '../types';
import { log } from '../log';

const TAG = 'c4parser';

interface P {
  tokens: Token[];
  pos: number;
  file: string;
  issues: ParseIssue[];
}

function init(tokens: Token[], file: string): P {
  return { tokens, pos: 0, file, issues: [] };
}

function cur(p: P): Token {
  return p.pos < p.tokens.length ? p.tokens[p.pos] : p.tokens[p.tokens.length - 1];
}

function next(p: P): Token {
  const t = cur(p);
  if (t.type !== 'eof') p.pos++;
  return t;
}

function expect(p: P, type: string): boolean {
  if (cur(p).type !== type) return false;
  next(p);
  return true;
}

function issue(p: P, line: number, msg: string): void {
  p.issues.push({ file: p.file, line, message: msg });
}

function skipLine(p: P): void {
  const ln = cur(p).line;
  while (cur(p).type !== 'eof' && cur(p).line === ln) next(p);
}

function skipBalanced(p: P): void {
  let d = 1;
  while (cur(p).type !== 'eof' && d > 0) {
    if (cur(p).type === 'lbrace') d++;
    else if (cur(p).type === 'rbrace') d--;
    if (d > 0) next(p);
  }
  if (d === 0) next(p);
}

function addRel(p: P, from: string, to: string, ln: number, label: string | null, rels: PlanRelation[]): void {
  rels.push({ from, to, label, source: { file: p.file, line: ln } });
  log(TAG, `relation`, { from, to });
}

function addElem(p: P, id: string, idLn: number, parent: string | null, els: PlanElement[], rels: PlanRelation[]): void {
  const kind = canonicalKind(cur(p).value);   // b456: an old kind word (layer) reads as the current one (subregion)
  next(p);
  if (cur(p).type !== 'string') {
    issue(p, cur(p).line, `expected title`);
    skipLine(p);
    return;
  }
  const title = cur(p).value;
  next(p);
  let desc: string | null = null;
  if (cur(p).type === 'string') {
    desc = cur(p).value;
    next(p);
  }

  const fqn = parent ? `${parent}.${id}` : id;
  const elem: PlanElement = {
    id: fqn,
    kind,
    title,
    description: desc,
    technology: null,
    links: [],
    metadata: {},
    parent,
    source: { file: p.file, line: idLn },
  };

  els.push(elem);
  log(TAG, `element`, { id: fqn, kind });

  if (cur(p).type === 'lbrace') {
    next(p);
    parseBody(p, fqn, elem, els, rels);
    if (cur(p).type === 'rbrace') {
      elem.source.endLine = Math.max(idLn, cur(p).line);   // closing-brace line
      next(p);
    } else {
      issue(p, cur(p).line, `expected }`);
    }
  }
  // No body, or unterminated body: fall back to the last token consumed (never before the identifier line).
  if (elem.source.endLine === undefined) {
    elem.source.endLine = Math.max(idLn, p.pos > 0 ? p.tokens[p.pos - 1].line : idLn);
  }
  log(TAG, `element end`, { id: fqn, line: idLn, endLine: elem.source.endLine });
}

export function parseC4(text: string, file: string): {
  elements: PlanElement[];
  relations: PlanRelation[];
  issues: ParseIssue[];
} {
  const { tokens, errors } = tokenize(text);
  const p = init(tokens, file);
  errors.forEach(e => issue(p, e.line, e.message));

  const elements: PlanElement[] = [];
  const relations: PlanRelation[] = [];

  log(TAG, `parsing ${file}`, { tokens: tokens.length });

  while (cur(p).type !== 'eof') {
    if (cur(p).type !== 'ident') {
      issue(p, cur(p).line, `unexpected ${cur(p).type}`);
      skipLine(p);
      continue;
    }

    const kw = cur(p).value;

    if (kw === 'specification' || kw === 'views') {
      next(p);
      if (expect(p, 'lbrace')) skipBalanced(p);
      continue;
    }

    if (kw === 'model') {
      next(p);
      if (expect(p, 'lbrace')) {
        const { els, rels } = parseTop(p, null);
        elements.push(...els);
        relations.push(...rels);
      }
      continue;
    }

    if (kw === 'extend') {
      const ln = cur(p).line;
      next(p);
      const fqnTok = cur(p);
      if (fqnTok.type !== 'ident') {
        issue(p, ln, `expected fqn`);
        skipLine(p);
        continue;
      }
      const fqn = fqnTok.value;
      next(p);
      if (expect(p, 'lbrace')) {
        const { els, rels } = parseTop(p, fqn);
        elements.push(...els);
        relations.push(...rels);
      }
      continue;
    }

    issue(p, cur(p).line, `unexpected keyword`);
    skipLine(p);
  }

  log(TAG, `parsed ${file}`, { elements: elements.length, relations: relations.length, issues: p.issues.length });
  return { elements, relations, issues: p.issues };
}

function parseTop(p: P, parent: string | null): { els: PlanElement[]; rels: PlanRelation[] } {
  const els: PlanElement[] = [];
  const rels: PlanRelation[] = [];

  while (cur(p).type !== 'rbrace' && cur(p).type !== 'eof') {
    if (cur(p).type !== 'ident') {
      if (cur(p).type === 'rbrace') break;
      issue(p, cur(p).line, `unexpected ${cur(p).type}`);
      skipLine(p);
      continue;
    }

    const kw = cur(p).value;

    if (kw === 'specification' || kw === 'views') {
      next(p);
      if (expect(p, 'lbrace')) skipBalanced(p);
      continue;
    }

    if (kw === 'extend') {
      const ln = cur(p).line;
      next(p);
      if (cur(p).type !== 'ident') {
        issue(p, ln, `expected fqn`);
        skipLine(p);
        continue;
      }
      const fqn = cur(p).value;
      next(p);
      if (expect(p, 'lbrace')) {
        const { els: subEls, rels: subRels } = parseTop(p, fqn);
        els.push(...subEls);
        rels.push(...subRels);
      }
      continue;
    }

    const id = kw;
    const idLn = cur(p).line;
    next(p);

    if (cur(p).type === 'equals') {
      next(p);
      if (cur(p).type !== 'ident') {
        issue(p, cur(p).line, `expected kind`);
        skipLine(p);
        continue;
      }
      addElem(p, id, idLn, parent, els, rels);
    } else if (cur(p).type === 'arrow') {
      next(p);
      if (cur(p).type !== 'ident') {
        issue(p, cur(p).line, `expected target`);
        skipLine(p);
        continue;
      }
      const to = cur(p).value;
      next(p);
      let label: string | null = null;
      if (cur(p).type === 'string') {
        label = cur(p).value;
        next(p);
      }
      if (expect(p, 'lbrace')) skipBalanced(p);
      addRel(p, id, to, idLn, label, rels);
    } else if (cur(p).line !== idLn) {
      // b178 (PS-3.18): a lone word on its line; report it and go on with the next line (skipLine here would drop that line).
      issue(p, idLn, `stray word '${id}': expected = or -> after it`);
    } else {
      log(TAG, `skip`, { id });
      skipLine(p);
    }
  }

  if (cur(p).type === 'rbrace') next(p);
  return { els, rels };
}

function parseBody(p: P, fqn: string, elem: PlanElement, els: PlanElement[], rels: PlanRelation[]): void {
  while (cur(p).type !== 'rbrace' && cur(p).type !== 'eof') {
    if (cur(p).type !== 'ident') {
      if (cur(p).type === 'arrow') {
        const ln = cur(p).line;
        next(p);
        if (cur(p).type !== 'ident') {
          issue(p, cur(p).line, `expected target`);
          skipLine(p);
          continue;
        }
        const to = cur(p).value;
        next(p);
        let label: string | null = null;
        if (cur(p).type === 'string') {
          label = cur(p).value;
          next(p);
        }
        if (expect(p, 'lbrace')) skipBalanced(p);
        addRel(p, fqn, to, ln, label, rels);
        continue;
      }
      if (cur(p).type === 'rbrace') break;
      issue(p, cur(p).line, `unexpected ${cur(p).type}`);
      skipLine(p);
      continue;
    }

    const kw = cur(p).value;

    if (kw === 'technology' || kw === 'description' || kw === 'title') {
      next(p);
      if (cur(p).type === 'string') {
        if (kw === 'technology') elem.technology = cur(p).value;
        else if (kw === 'description') elem.description = cur(p).value;
        else elem.title = cur(p).value;
        next(p);
      } else {
        issue(p, cur(p).line, `expected value`);
        skipLine(p);
      }
      continue;
    }

    if (kw === 'link') {
      next(p);
      if (cur(p).type === 'word' || cur(p).type === 'ident' || cur(p).type === 'string') {
        const linkRaw = cur(p).value;
        next(p);
        let linkTitle: string | null = null;
        if (cur(p).type === 'string') {
          linkTitle = cur(p).value;
          next(p);
        }
        const link = parseLink(linkRaw, p.file, linkTitle);
        elem.links.push(link);
        log(TAG, `link`, { element: fqn, raw: linkRaw });
      } else {
        issue(p, cur(p).line, `expected value`);
        skipLine(p);
      }
      continue;
    }

    if (kw === 'metadata') {
      next(p);
      if (expect(p, 'lbrace')) {
        while (cur(p).type !== 'rbrace' && cur(p).type !== 'eof') {
          if (cur(p).type !== 'ident') {
            skipLine(p);
            continue;
          }
          const key = cur(p).value;
          next(p);
          if (cur(p).type === 'string') {
            elem.metadata[key] = cur(p).value;
            next(p);
          } else {
            issue(p, cur(p).line, 'metadata value must be quoted (key ' + key + ')');
            skipLine(p);
          }
        }
        if (!expect(p, 'rbrace')) {
          issue(p, cur(p).line, `expected }`);
        }
      }
      continue;
    }

    if (kw === 'specification' || kw === 'views') {
      next(p);
      if (expect(p, 'lbrace')) skipBalanced(p);
      continue;
    }

    if (kw === 'extend') {
      const ln = cur(p).line;
      next(p);
      if (cur(p).type !== 'ident') {
        issue(p, ln, `expected fqn`);
        skipLine(p);
        continue;
      }
      const extFqn = cur(p).value;
      next(p);
      if (expect(p, 'lbrace')) {
        const { els: subEls, rels: subRels } = parseTop(p, extFqn);
        els.push(...subEls);
        rels.push(...subRels);
      }
      continue;
    }

    // Phase 26 (T26-13, D16): `test 'name' { [case '<id>'] }`; only when a string follows, so `test = component 'T'` stays an element.
    if (kw === 'test' && p.tokens[p.pos + 1]?.type === 'string') {
      parseTest(p, elem);
      continue;
    }

    // Nested element or relation
    const id = kw;
    const idLn = cur(p).line;
    next(p);

    if (cur(p).type === 'equals') {
      next(p);
      if (cur(p).type !== 'ident') {
        issue(p, cur(p).line, `expected kind`);
        skipLine(p);
        continue;
      }
      addElem(p, id, idLn, fqn, els, rels);
    } else if (cur(p).type === 'arrow') {
      next(p);
      if (cur(p).type !== 'ident') {
        issue(p, cur(p).line, `expected target`);
        skipLine(p);
        continue;
      }
      const to = cur(p).value;
      next(p);
      let label: string | null = null;
      if (cur(p).type === 'string') {
        label = cur(p).value;
        next(p);
      }
      if (expect(p, 'lbrace')) skipBalanced(p);
      addRel(p, id, to, idLn, label, rels);
    } else if (cur(p).line !== idLn) {
      // b178 (PS-3.18): same rule as parseTop.
      issue(p, idLn, `stray word '${id}': expected = or -> after it`);
    } else {
      log(TAG, `skip`, { id });
      skipLine(p);
    }
  }
}

/**
 * A `test` block (D16) on `elem`: `test 'name'`, optional `{`, optional `case '<id>'`, `}`. The block may span lines (a
 * 1.5 reader accepts both; writers emit one line, A6). Issues: a second case, any other token inside (skipped to the `}`).
 */
function parseTest(p: P, elem: PlanElement): void {
  const line = next(p).line;   // 'test'
  const name = next(p).value;  // the string (checked by the caller)
  let caseId: string | null = null;
  let endLine = line;
  if (cur(p).type === 'lbrace') {
    next(p);
    while (cur(p).type !== 'rbrace' && cur(p).type !== 'eof') {
      const t = cur(p);
      if (t.type === 'ident' && t.value === 'case' && p.tokens[p.pos + 1]?.type === 'string') {
        next(p);
        const value = next(p).value;
        if (caseId !== null) issue(p, t.line, `test block takes one case`);
        else caseId = value;
        continue;
      }
      issue(p, t.line, `unexpected ${t.type === 'ident' || t.type === 'word' ? `'${t.value}'` : t.type} in test block`);
      if (t.type === 'lbrace') { next(p); skipBalanced(p); continue; }
      next(p);
    }
    if (cur(p).type === 'rbrace') { endLine = cur(p).line; next(p); }
    else issue(p, cur(p).line, `expected }`);
  }
  (elem.tests ??= []).push({ name, case: caseId, source: { file: p.file, line, endLine } });
  log(TAG, `test`, { element: elem.id, name, case: caseId });
}

export function parsePlan(repoRoot: string, files: string[]): Plan {
  const issues: ParseIssue[] = [];
  const fileList = [...files].sort();
  const texts = new Map<string, string>();

  for (const file of fileList) {
    const fp = path.join(repoRoot, file);
    try {
      texts.set(file, fs.readFileSync(fp, 'utf-8'));
    } catch (e) {
      issues.push({ file, line: 0, message: `read failed: ${(e as Error).message}` });
    }
  }

  const plan = parsePlanTexts(repoRoot, texts);
  // Keep the per-file order of issues (a read failure sits where that file would have been).
  const order = new Map(fileList.map((f, i) => [f, i]));
  const merged = [...issues, ...plan.issues].sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
  return { files: fileList, elements: plan.elements, relations: plan.relations, issues: merged };
}

/**
 * Parse a plan from in-memory file texts (key = repo-relative file). Same result as parsePlan on the same
 * content: files are processed in sorted order, `../` link paths are folded back to repo-relative.
 */
export function parsePlanTexts(repoRoot: string, texts: Map<string, string>): Plan {
  const els: PlanElement[] = [];
  const rels: PlanRelation[] = [];
  const issues: ParseIssue[] = [];
  const fileList = [...texts.keys()].sort();

  for (const file of fileList) {
    const text = texts.get(file) as string;

    const res = parseC4(text, file);
    // A plan folder outside repoRoot (e.g. <anchor>/.c4pm/... above the scan target) yields link paths
    // like '../Project/src/x/' after parseLink's purely textual join. Claims, ownership and checks match
    // links as repo-relative strings, so fold such paths back to repo-relative when they land inside repoRoot.
    for (const el of res.elements) {
      for (const link of el.links) {
        if (!link.path.startsWith('../')) continue;
        const rel = path.relative(repoRoot, path.resolve(repoRoot, link.path)).split(path.sep).join('/');
        if (rel === '' || rel.startsWith('..')) continue;
        link.path = link.path.endsWith('/') && !rel.endsWith('/') ? rel + '/' : rel;
      }
    }
    els.push(...res.elements);
    rels.push(...res.relations);
    issues.push(...res.issues);
  }

  els.sort((a, b) => a.id.localeCompare(b.id));

  log(TAG, `parsePlan`, { files: fileList.length, elements: els.length, relations: rels.length, issues: issues.length });

  return { files: fileList, elements: els, relations: rels, issues };
}
