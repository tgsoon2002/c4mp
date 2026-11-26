import type { NavCall, NavEdge, NavEntry, NavGroup, NavModel, NavPart, Plan, PlanElement } from '../types';
import { UID_KEY } from '../util/uid';
import { ENTRY_KINDS, PART_KINDS, owningEntry, isFrontendKind } from '../plan/kinds';
import { IO_META_KEYS, ioContainerWord } from '../plan/ioWords';
import { log } from '../log';
import { rankNodes, type LayerPair } from './arrangeLayered';
import { wireframeOf } from '../c4/wireframeRefs';
import type { WireframeFile } from '../c4/wireframeFiles';

// P20-T4 (b126): data for the IO view (navigation map). Groups, entries (b266: screens, commands, routes, tools) with their parts and the
// navigation edges, from the plan only. No drawing here (T5 b127 mode, T6 b128 drawing).

export const NO_CONTAINER = '(no container)';

/**
 * Navigation data for a plan, or null when the plan holds no screen (ViewModel.nav is then left out).
 * W6 (b302): `wireframes` = the loaded files by screen fqn (loadWireframes().files); a screen with a file gets its resolved
 * wireframe (wireframeOf). The caller loads the files, so buildNav stays pure.
 */
export function buildNav(plan: Plan, wireframes?: ReadonlyMap<string, WireframeFile>): NavModel | null {
  // Declaration order (K): plan.elements is alphabetical, so sort by the position of the file in plan.files, then line.
  const fileIndex = new Map(plan.files.map((f, i) => [f, i] as const));
  const fileRank = (el: PlanElement): number => {
    const idx = fileIndex.get(el.source.file);
    if (idx === undefined) throw new Error(`navModel: ${el.id} is declared in '${el.source.file}', which is not in plan.files`);
    return idx;
  };
  plan.elements.forEach(fileRank);   // a file missing from plan.files is an error, even when the sort never compares it
  const byDeclaration = (a: PlanElement, b: PlanElement): number => fileRank(a) - fileRank(b) || a.source.line - b.source.line;
  const declared = [...plan.elements].sort(byDeclaration);
  const byId = new Map(plan.elements.map((e) => [e.id, e] as const));

  const entries = declared.filter((e) => ENTRY_KINDS.has(e.kind));
  if (entries.length === 0) {
    log('view-nav', 'no screens, commands, routes or tools in the plan, no nav');
    return null;
  }

  const childrenOf = new Map<string, PlanElement[]>();
  for (const el of declared) {
    if (!PART_KINDS.has(el.kind) || el.parent === null) continue;
    const list = childrenOf.get(el.parent);
    if (list) list.push(el);
    else childrenOf.set(el.parent, [el]);
  }
  // b266: the row metadata keys (in, type, required) ride on the part, only the ones that are set
  const metaOf = (el: PlanElement): Record<string, string> | undefined => {
    const keys = IO_META_KEYS.filter((k) => el.metadata[k] !== undefined);
    return keys.length === 0 ? undefined : Object.fromEntries(keys.map((k) => [k, el.metadata[k]]));
  };
  const toPart = (el: PlanElement): NavPart => {
    const meta = metaOf(el);
    return {
      fqn: el.id,
      uid: el.metadata[UID_KEY] ?? null,
      kind: el.kind,
      title: el.title,
      status: el.metadata.status ?? null,
      parts: (childrenOf.get(el.id) ?? []).map(toPart),
      ...(meta ? { meta } : {}),
    };
  };

  // Groups: one per container that holds entries, in the container's declaration order; '(no container)' last.
  // b266: an entry's container is its nearest container ancestor (a subcommand sits under a command, in the same app).
  const containerOf = (el: PlanElement): string | null => {
    let cur = el.parent === null ? undefined : byId.get(el.parent);
    while (cur) {
      if (cur.kind === 'container') return cur.id;
      cur = cur.parent === null ? undefined : byId.get(cur.parent);
    }
    return null;
  };
  // The nearest ancestor that is an entry too (a subcommand's command); null for a top-level entry.
  const entryIds = new Set(entries.map((e) => e.id));
  const entryParentOf = (el: PlanElement): string | null => {
    let cur = el.parent === null ? undefined : byId.get(el.parent);
    while (cur) {
      if (entryIds.has(cur.id)) return cur.id;
      cur = cur.parent === null ? undefined : byId.get(cur.parent);
    }
    return null;
  };
  const groupOfEntry = new Map<string, string>();
  const groupEntries = new Map<string, PlanElement[]>();
  for (const en of entries) {
    const key = containerOf(en) ?? NO_CONTAINER;
    if (key === NO_CONTAINER) log('view-nav', 'entry has no container ancestor', { entry: en.id, kind: en.kind, parent: en.parent });
    groupOfEntry.set(en.id, key);
    const list = groupEntries.get(key);
    if (list) list.push(en);
    else groupEntries.set(key, [en]);
  }

  // b130: the target when a component, else its nearest component ancestor.
  const componentOf = (el: PlanElement): string | null => {
    let cur: PlanElement | undefined = el;
    while (cur) {
      if (cur.kind === 'component') return cur.id;
      cur = cur.parent === null ? undefined : byId.get(cur.parent);
    }
    return null;
  };

  const edges: NavEdge[] = [];
  const calls: NavCall[] = [];
  for (const rel of plan.relations) {
    const owner = owningEntry(rel.from, byId);
    if (owner === null) continue;   // not from an entry or one of its parts: an architecture relation, not navigation
    const target = byId.get(rel.to);
    if (target && !isFrontendKind(target.kind)) {
      // b130: screen/part -> component, function, ... = "calls / implemented by"; the label is the relation's own only
      calls.push({
        from: owner, via: rel.from === owner ? null : rel.from, to: target.id, toKind: target.kind, toTitle: target.title,
        toUid: target.metadata[UID_KEY] ?? null, toComponent: componentOf(target), label: rel.label ?? null,
      });
      continue;
    }
    if (!target || target.kind !== 'screen') {
      log('view-nav', 'edge dropped', { from: rel.from, to: rel.to, reason: target ? `target is a ${target.kind}` : 'target not in plan' });
      continue;
    }
    const via = rel.from === owner ? null : rel.from;
    const label = rel.label ?? (via === null ? null : byId.get(via)!.title);
    const edge: NavEdge = { from: owner, to: target.id, label, via };
    if (rel.label != null) edge.labelled = true;   // b263: the label is the relation's own, not the control-title fallback
    if (owner === target.id) edge.self = true;
    if (groupOfEntry.get(owner) !== groupOfEntry.get(target.id)) edge.crossGroup = true;
    edges.push(edge);
  }

  const keys = [...groupEntries.keys()].sort((a, b) => {
    if (a === NO_CONTAINER || b === NO_CONTAINER) return a === NO_CONTAINER ? 1 : -1;
    return byDeclaration(byId.get(a)!, byId.get(b)!);
  });

  const groups: NavGroup[] = keys.map((key) => {
    const members = groupEntries.get(key)!;
    const index = new Map(members.map((s, i) => [s.id, i] as const));
    // One pair per distinct (from, to) between this group's screens; self loops and cross-group edges do not rank.
    const seen = new Set<string>();
    const pairs: LayerPair[] = [];
    for (const e of edges) {
      const from = index.get(e.from);
      const to = index.get(e.to);
      if (from === undefined || to === undefined || e.self || e.crossGroup || seen.has(`${from}>${to}`)) continue;
      seen.add(`${from}>${to}`);
      pairs.push({ from, to, weight: 1 });
    }
    const { rank, order } = rankNodes(members.length, pairs);
    // W14 (b310): the navigation column of each screen (K3, D4); rank and order above stay the arch layout's (rankNodes)
    const screens = members.filter((m) => m.kind === 'screen');
    const screenIndex = new Map(screens.map((s, i) => [s.id, i] as const));
    const screenPairs = pairs.flatMap((p) => {
      const from = screenIndex.get(members[p.from].id), to = screenIndex.get(members[p.to].id);
      return from === undefined || to === undefined ? [] : [{ from, to }];
    });
    const columns = navColumns(screens, screenPairs, byDeclaration);
    const navEntries: NavEntry[] = members.map((sc, i) => {
      const si = screenIndex.get(sc.id);
      const file = sc.kind === 'screen' ? wireframes?.get(sc.id) : undefined;   // W6: screens only; no file = no key
      return {
        kind: sc.kind,
        fqn: sc.id,
        uid: sc.metadata[UID_KEY] ?? null,
        title: sc.title,
        status: sc.metadata.status ?? null,
        ...(sc.description ? { description: sc.description } : {}),   // the element's description: the box header detail
        metadata: { ...sc.metadata },   // b128: device and design reach the layout (b266: route method too)
        rank: rank[i],
        order: order[rank[i]].indexOf(i),
        parent: entryParentOf(sc),
        parts: (childrenOf.get(sc.id) ?? []).map(toPart),
        ...(file ? { wireframe: wireframeOf(plan, sc.id, file) } : {}),
        ...(si === undefined ? {} : { column: columns[si] }),
      };
    });
    const container = key === NO_CONTAINER ? null : byId.get(key)!;
    log('view-nav', 'group built', { group: key, entries: members.length, rankedPairs: pairs.length });
    return {
      fqn: key,
      title: container ? container.title : NO_CONTAINER,
      technology: container ? container.technology : null,
      word: ioContainerWord(container ? container.technology : null),
      entries: navEntries,
    };
  });

  log('view-nav', 'nav built', { groups: groups.length, entries: entries.length, edges: edges.length, calls: calls.length });
  return { groups, edges, calls };
}

/**
 * W14 (b310, K3 / D4): the navigation column of each screen of one app group (indexes into `screens`). Pure.
 * Sources = the screens no pair reaches (self pairs ignored); none -> the first screen by `order`. Column = steps from the
 * nearest source, breadth first. Screens still unreached (a cycle nothing leads into): the first of them by `order` becomes
 * another source at column 0, and the steps are counted again from all sources, until every screen has a column.
 */
export function navColumns(
  screens: PlanElement[], pairs: { from: number; to: number }[], order: (a: PlanElement, b: PlanElement) => number,
): number[] {
  const n = screens.length;
  const next: number[][] = screens.map(() => []);
  const reached = new Array<boolean>(n).fill(false);
  for (const p of pairs) {
    if (p.from === p.to) continue;
    if (!(p.from >= 0 && p.from < n && p.to >= 0 && p.to < n)) throw new Error(`navColumns: pair ${p.from} -> ${p.to} is outside the ${n} screens`);
    next[p.from].push(p.to);
    reached[p.to] = true;
  }
  const byOrder = screens.map((_, i) => i).sort((a, b) => order(screens[a], screens[b]) || a - b);
  const sources = byOrder.filter((i) => !reached[i]);
  if (sources.length === 0 && n > 0) sources.push(byOrder[0]);   // every screen has an incoming arrow: the first by order
  for (;;) {
    const col = new Array<number>(n).fill(-1);
    const queue = [...sources];
    for (const s of sources) col[s] = 0;
    for (let q = 0; q < queue.length; q++) {
      const at = queue[q];
      for (const to of next[at]) {
        if (col[to] >= 0) continue;
        col[to] = col[at] + 1;
        queue.push(to);
      }
    }
    const left = byOrder.find((i) => col[i] < 0);
    if (left === undefined) return col;
    sources.push(left);
  }
}
