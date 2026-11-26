import { parseLink } from '../plan/links';
import { resolveLinks } from '../plan/resolve';
import { openProject } from '../scan/project';
import { planFor, scanWithPlan } from '../scan/planScan';
import type { C4pmConfig, Plan, ResolvedLink } from '../types';

/**
 * `c4pm plan resolve-link`: what one link resolves to, as if it were written in a .c4 file at the repo root
 * (repo-relative path, optionally #functionName or #Lx-Ly). The scan is built with the plan, as `view` does.
 * Undefined when nothing resolves. Read-only; the link is parsed before the config is read.
 */
export function resolveLink(repoRoot: string, cli: Partial<C4pmConfig>, target: string): ResolvedLink | undefined {
  const link = parseLink(target, '_.c4');
  const { config } = openProject(repoRoot, cli);
  const snapshot = scanWithPlan(repoRoot, config, planFor(repoRoot, config));

  // A one-element plan that holds only the link
  const plan: Plan = {
    files: ['_.c4'],
    elements: [
      {
        id: 'link',
        kind: 'system',
        title: 'Link',
        description: null,
        technology: null,
        links: [link],
        metadata: {},
        parent: null,
        source: { file: '_.c4', line: 1 },
      },
    ],
    relations: [],
    issues: [],
  };
  return resolveLinks(plan, repoRoot, snapshot.files)[0];
}
