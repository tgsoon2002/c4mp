/**
 * P18-T13: does every link of one plan element point at something that exists? The gate (planTx) does not catch a
 * link to a missing file or function for non-built elements, so add and link check it themselves with the same
 * resolveLinks call as `resolve-link` and `check` (D9). Needs a scan (function links are looked up in the outlines).
 */
import * as path from 'path';
import { resolveLinks } from '../plan/resolve';
import type { Plan, PlanLink } from '../types';
import type { PlanState } from './planState';

/**
 * One line per problem; empty = the links of `fqn` resolve (only those accepted by `only`, default all: `link` checks
 * just the link it adds, so an old broken link does not block a good new one).
 * Throws when the scan cannot run (the caller refuses the write).
 */
export function linkProblems(state: PlanState, plan: Plan, fqn: string, only: (link: PlanLink) => boolean = () => true): string[] {
  const outlines = state.session.core().outlines;
  const problems: string[] = [];
  for (const r of resolveLinks(plan, state.repoRoot, outlines)) {
    if (r.elementId !== fqn || !only(r.link) || /^[a-z][a-z0-9+.-]*:\/\//.test(r.link.path)) continue;
    const full = path.resolve(state.repoRoot, r.link.path);
    if (path.relative(state.repoRoot, full).startsWith('..')) problems.push(`link ${r.link.raw} points outside the repo`);
    else if (!r.exists) problems.push(`link target does not exist: ${r.link.path}`);
    else if (r.target === 'function' && !r.found) problems.push(`function '${r.link.name}' not found in ${r.link.path}`);
    else if (r.target === 'folder' && !r.found) problems.push(`folder has no source files: ${r.link.path}`);
  }
  return problems;
}
