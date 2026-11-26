/**
 * Phase 20 wireframes (C1): the one resolver of `data-c4` refs. A ref names a part under a screen of the plan:
 * no dot = the id of a part anywhere under the screen; with dots = the exact path from the screen. States count as
 * parts. Titles are never used. Pure: it takes the parsed plan and the ref texts (scanned elsewhere); wireframeOf takes a
 * loaded file (wireframeFiles.ts) and scans it with wireframeHtml.ts scanWireRefs.
 */
import type { NavWireframe, Plan, PlanElement, WireRef } from '../types';   // WireRef: one ref after resolving (data contract), defined in types.ts (W6)
import type { WireframeFile } from './wireframeFiles';
import { scanWireRefs } from './wireframeHtml';
import { CMD_NAME } from '../constants';

/** unique = one part; state = one part and it is a state; ambiguous = two or more parts share the id; unknown = none. */
export type WireRefStatus = 'unique' | 'ambiguous' | 'unknown' | 'state';

export interface WireRefResult { ref: string; status: WireRefStatus; fqn: string | null; candidates: string[] }

/** Kinds a wireframe must place (H5: states are shown in the panel, not placed). */
const PLACED_KINDS: ReadonlySet<string> = new Set(['region', 'control']);

function localId(fqn: string): string { return fqn.slice(fqn.lastIndexOf('.') + 1); }

/** Every element below the screen (any depth), in plan order. */
function partsOf(plan: Plan, screenFqn: string): PlanElement[] {
  const prefix = screenFqn + '.';
  return plan.elements.filter(e => e.id.startsWith(prefix));
}

/** Resolve one ref against the parts of a screen. */
export function resolveWireRef(plan: Plan, screenFqn: string, ref: string): WireRefResult {
  const prefix = screenFqn + '.';
  const parts = partsOf(plan, screenFqn);
  const hits = ref.includes('.')
    ? parts.filter(e => e.id === prefix + ref)
    : parts.filter(e => localId(e.id) === ref);
  if (hits.length === 0) return { ref, status: 'unknown', fqn: null, candidates: [] };
  if (hits.length > 1) return { ref, status: 'ambiguous', fqn: null, candidates: hits.map(e => e.id) };
  return { ref, status: hits[0].kind === 'state' ? 'state' : 'unique', fqn: hits[0].id, candidates: [] };
}

/**
 * Resolve all refs of one wireframe file. `refs` is deduplicated (a ref on several elements counts once).
 * `missing` = fqns of the screen's regions and controls that no ref reached, in plan order.
 */
export function resolveWireRefs(plan: Plan, screenFqn: string, refs: readonly string[]): { refs: WireRef[]; missing: string[] } {
  const out: WireRef[] = [];
  const reached = new Set<string>();
  for (const ref of new Set(refs)) {
    const r = resolveWireRef(plan, screenFqn, ref);
    if (r.status === 'unknown') out.push({ ref, fqn: null, problem: 'unknown' });
    else if (r.status === 'ambiguous') out.push({ ref, fqn: null, problem: 'ambiguous', candidates: r.candidates });
    else { out.push({ ref, fqn: r.fqn }); reached.add(r.fqn as string); }
  }
  const missing = partsOf(plan, screenFqn).filter(e => PLACED_KINDS.has(e.kind) && !reached.has(e.id)).map(e => e.id);
  return { refs: out, missing };
}

/** Shortest ref that resolves to `fqn` under `screenFqn`: its id when unique under the screen, else the path from the screen. Null if it is not a part of the screen. */
export function refFor(plan: Plan, screenFqn: string, fqn: string): string | null {
  if (!partsOf(plan, screenFqn).some(e => e.id === fqn)) return null;
  const id = localId(fqn);
  return resolveWireRef(plan, screenFqn, id).fqn === fqn ? id : fqn.slice(screenFqn.length + 1);
}

/**
 * W6 (b302, S3): the one wireframe resolver (C1). One screen's loaded file -> its refs resolved against the plan and what is missing.
 * A file c4pm cannot use (file.error) stays an error entry: no refs, and every region and control of the screen is missing.
 * Pure; buildNav (page data), checkWireframes (rules) and the starter round trip call it.
 */
export function wireframeOf(plan: Plan, screenFqn: string, file: WireframeFile): NavWireframe {
  if (file.error !== undefined) return { file: file.file, error: file.error, refs: [], missing: resolveWireRefs(plan, screenFqn, []).missing };
  if (file.html === undefined) throw new Error(`wireframeOf: the wireframe '${file.file}' of ${screenFqn} has neither html nor error`);
  return { file: file.file, html: file.html, ...resolveWireRefs(plan, screenFqn, scanWireRefs(file.html)) };
}

/** Plan order of a screen's parts: their place in the plan files (the plan's own list is sorted by fqn). */
const bySource = (a: PlanElement, b: PlanElement): number =>
  a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line;

/** Text that may sit in an HTML comment: no `--` (it would end or break the comment). */
const commentSafe = (s: string): string => s.replace(/-(?=-)/g, '- ');

/**
 * W9 (b305): a starter wireframe of a screen, for a person or an AI to arrange (`c4pm plan wireframe <screen>`). Pure.
 * Nested like the plan: one `<div data-c4>` per region (nested regions nest), each run of controls in a `<div class="row">`
 * as `<button data-c4 class="btn">`; states are not placed (H5). Classes only (K 2026-11-07): no style attribute, no
 * `<style>` block; every size lives in the linked io/site.css (a region's class is its id). Refs from refFor, so the file
 * round-trips through wireframeOf with nothing missing and no ref problem. Lives here, next to refFor: in wireframeHtml.ts
 * it would make a file cycle (this file imports scanWireRefs from there).
 */
export function starterWireframe(plan: Plan, screenFqn: string): string {
  const screen = plan.elements.find(e => e.id === screenFqn);
  if (screen === undefined || screen.kind !== 'screen') throw new Error(`starterWireframe: ${screenFqn} is not a screen of the plan`);
  const parts = partsOf(plan, screenFqn);
  const ref = (fqn: string): string => refFor(plan, screenFqn, fqn) as string;   // a part of the screen: never null
  const lines: string[] = [
    '<!--',
    `  Wireframe of screen ${screenFqn} ('${commentSafe(screen.title)}'): starter, arrange me.`,
    `  Bare HTML, classes only: every size and position lives in site.css (linked below); ${CMD_NAME} draws it in its own theme.`,
    '  data-c4 = a region or control of this screen in the plan.',
    '-->',
    '<link rel="stylesheet" href="site.css">',
    '<div class="page">',
  ];
  const emit = (parentFqn: string, depth: number): void => {
    const pad = '  '.repeat(depth);
    const kids = parts.filter(e => e.parent === parentFqn && PLACED_KINDS.has(e.kind)).sort(bySource);
    let row: PlanElement[] = [];
    const flush = (): void => {
      if (row.length === 0) return;
      lines.push(`${pad}<div class="row">`);
      for (const c of row) lines.push(`${pad}  <button data-c4="${ref(c.id)}" class="btn"></button>`);
      lines.push(`${pad}</div>`);
      row = [];
    };
    for (const k of kids) {
      if (k.kind === 'control') { row.push(k); continue; }
      flush();
      lines.push(`${pad}<div data-c4="${ref(k.id)}" class="${localId(k.id)}">`);
      emit(k.id, depth + 1);
      lines.push(`${pad}</div>`);
    }
    flush();
  };
  emit(screenFqn, 1);
  lines.push('</div>');
  return lines.join('\n') + '\n';
}
