import type { IoCard, IoRow, NavEdge, NavEntry, NavGroup, NavModel, NavPart, ViewEdge, ViewNode } from '../types';
import { log } from '../log';
import { DEVICE_VIEWPORT, PARAM_IN_BY_PARENT, PART_WORD_BY_PARENT, parseViewport, routeMethod } from '../plan/ioWords';

// P20-T5-A (b255): the IO-view tree. NavModel (groups > screens, screen-to-screen edges) becomes a ViewNode tree
// (root '(io)' > one container per group > one leaf per entry: screen, command, route, tool). No geometry lives here:
// the browser lays the tree out (viewer/ioView.js).

const DEVICES: ReadonlySet<string> = new Set(Object.keys(DEVICE_VIEWPORT));   // W6 (b302): one table (ioWords.ts DEVICE_VIEWPORT)
const PHONE_RE = /mobile|ios|android|phone|flutter|react native|swift|kotlin/i;

const node = (id: string, kind: ViewNode['kind'], name: string, detail: string, weight: number, children: ViewNode[]): ViewNode => ({
  id, kind, name, detail, weight, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false,
});

// b128: the device rule, once. metadata.device when valid (invalid: logged, falls through); else phone when the
// container technology, container title or screen title/fqn matches PHONE_RE; else web.
function deviceOf(s: NavEntry, g: NavGroup): NonNullable<IoCard['device']> {
  const explicit = s.metadata?.device;
  if (explicit !== undefined) {
    if (DEVICES.has(explicit)) return explicit as NonNullable<IoCard['device']>;
    log('view-nav', 'invalid screen device, using the default rule', { screen: s.fqn, device: explicit });
  }
  return [g.technology ?? '', g.title, s.title, s.fqn].some(t => PHONE_RE.test(t)) ? 'phone' : 'web';
}

/**
 * W6 (b302, C3): the layout size of a screen's frame. metadata.viewport when valid (parseViewport) -> 'metadata'; a bad value is
 * logged and falls through (H9; the check reports it); else the device's size (DEVICE_VIEWPORT) -> 'device'.
 */
export function viewportOf(entry: NavEntry, device: string): { w: number; h: number; source: 'device' | 'metadata' } {
  const viewport = entry.metadata?.viewport;
  if (viewport !== undefined) {
    const size = parseViewport(viewport);
    if (size) return { ...size, source: 'metadata' };
    log('view-nav', 'invalid screen viewport, using the device size', { screen: entry.fqn, viewport });
  }
  const size = DEVICE_VIEWPORT[device];
  if (!size) throw new Error(`viewportOf: device '${device}' of ${entry.fqn} has no DEVICE_VIEWPORT row`);
  return { w: size.w, h: size.h, source: 'device' };
}

// b266: the metadata of a part (in, type, required), only keys that are set; a param's `in` defaults by its parent kind. Shared by the card rows and the part nodes.
function partMeta(p: NavPart, parentKind: string): Record<string, string> {
  const inDefault = p.kind === 'param' ? PARAM_IN_BY_PARENT[parentKind] : undefined;
  return { ...(inDefault ? { in: inDefault } : {}), ...p.meta };
}

// b128: parts flattened depth-first into card rows. A row gets `nav` from the first edge whose `via` is its id.
// b266: a row gets `word` when its parent kind changes it, and `meta` (in, type, required).
function rowsOf(parts: NavPart[], edges: NavEdge[], parentKind: string, depth = 0): IoRow[] {
  return parts.flatMap(p => {
    const row: IoRow = { id: p.fqn, kind: p.kind, title: p.title, depth };
    if (p.status) row.status = p.status;
    const word = PART_WORD_BY_PARENT[p.kind]?.[parentKind];
    if (word) row.word = word;
    const meta = partMeta(p, parentKind);
    if (Object.keys(meta).length > 0) row.meta = meta;
    const e = edges.find(x => x.via === p.fqn);
    if (e) row.nav = e.labelled && e.label ? { to: e.to, label: e.label } : { to: e.to };
    return [row, ...rowsOf(p.parts, edges, p.kind, depth + 1)];
  });
}

// b290: a part is a ViewNode too (child of its entry or of its parent part): id = fqn, kind = the part kind (region, control, flag, ...; open
// string, so the cast), name = title; meta = status + in / type / required. The tree, the search, the panel and the selection use these nodes.
function partNode(p: NavPart, parentKind: string): ViewNode {
  const n = node(p.fqn, p.kind as ViewNode['kind'], p.title, '', 1, p.parts.map(c => partNode(c, p.kind)));
  if (p.uid) n.uid = p.uid;
  const meta = { ...(p.status ? { status: p.status } : {}), ...partMeta(p, parentKind) };
  if (Object.keys(meta).length > 0) n.meta = meta;
  const word = PART_WORD_BY_PARENT[p.kind]?.[parentKind];
  if (word) n.word = word;
  return n;
}

/** Builds the laid-out IO-view tree and its edges (one per distinct screen pair, weight = number of nav edges, self edges dropped). */
export function buildNavView(nav: NavModel): { root: ViewNode; edges: ViewEdge[] } {
  const groups = nav.groups.map(g => {
    const made = new Map<string, ViewNode>();
    const entries = g.entries.map(s => {
      const n = node(s.fqn, 'screen', s.title, s.description ?? '', 1, s.parts.map(p => partNode(p, s.kind)));   // b266: every entry is a 'screen' leaf of the tree; io.kind says what it is
      if (s.uid) n.uid = s.uid;
      if (s.status) n.meta = { status: s.status };
      const io: IoCard = { kind: s.kind, rows: rowsOf(s.parts, nav.edges, s.kind) };
      if (s.kind === 'screen') {
        const device = deviceOf(s, g);
        io.device = device;
        io.viewport = viewportOf(s, device);   // W6 (b302)
      }
      if (s.kind === 'route') {
        const method = routeMethod(s.title, s.metadata);
        if (method) io.method = method;
      }
      if (s.metadata?.design !== undefined) io.design = s.metadata.design;
      n.io = io;
      made.set(s.fqn, n);
      return { s, n };
    });
    // b290: a subcommand (NavEntry.parent = an entry of this group) is a child of its parent entry; the others stay under the app
    const top: ViewNode[] = [];
    entries.forEach(({ s, n }) => {
      const parent = s.parent ? made.get(s.parent) : undefined;
      if (parent) parent.children.push(n); else top.push(n);
    });
    const app = node(g.fqn, 'container', g.title, g.technology ?? '', entries.length, top);
    app.word = g.word;
    return app;
  });
  const root = node('(io)', 'system', 'IO view', '', groups.reduce((sum, g) => sum + g.weight, 0), groups);

  const pairs = new Map<string, ViewEdge>();
  let selfEdges = 0;
  for (const e of nav.edges) {
    if (e.from === e.to) { selfEdges++; continue; }
    const key = `${e.from}\u0000${e.to}`;
    let hit = pairs.get(key);
    if (hit) hit.weight++;
    else pairs.set(key, hit = { from: e.from, to: e.to, weight: 1 });
    // b128: a labelled edge's label rides on the pair; distinct labels are joined with ', ' (none are lost)
    if (e.labelled && e.label) {
      hit.labelled = true;
      if (!hit.label) hit.label = e.label;
      else if (!hit.label.split(', ').includes(e.label)) hit.label += `, ${e.label}`;
    }
  }
  const edges = [...pairs.values()];

  // The rects of every node stay 0 here: the browser writes them (viewer/ioView.js layout()). Nothing server-side reads them.
  log('view-nav', 'nav view laid out', { groups: groups.length, entries: nav.groups.reduce((n, g) => n + g.entries.length, 0), edges: edges.length, selfEdges });
  return { root, edges };
}
