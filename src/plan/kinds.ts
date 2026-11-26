/**
 * P20-T1: the one table of plan element kinds. Every list of "which kinds" (lookup, tree level, uid backfill)
 * reads this table; add a kind here and nowhere else.
 */
import type { ViewName } from '../types';
import { canonicalKind } from './renames';

export type TreeLevel = 'c1' | 'c2' | 'c3';

export interface KindInfo {
  /** Tree level (`c4pm plan tree c1|c2|c3`), null when the kind has no level of its own. */
  level: TreeLevel | null;
  /** Found by `element`, `tree`, `remove` and the board link lookup; carries a uid (`c4pm plan ids`). */
  element: boolean;
  /**
   * 'architecture' = may be drawn on the architecture map; 'frontend' = screens and what they hold (later navigation map);
   * 'storage' (b210) = store > record > field, what a container keeps (later storage view).
   */
  family: 'architecture' | 'frontend' | 'storage';
  /** A `done` or `in-progress` element must link to code (check rule missing-code). False for kinds with no code of their own. */
  needsCode: boolean;
  /** Drawn on the architecture map as a plan-only node outside the system (person, external); relations to and from it are kept. */
  actor: boolean;
  /**
   * P20-T9 (b131): kinds a new element of this kind may go under (`c4pm plan add`). [] = top level of the model
   * (no --parent); null = `plan add` cannot create this kind yet.
   */
  parents: string[] | null;
}

export const KIND_TABLE: Record<string, KindInfo> = {
  system: { level: 'c1', element: true, family: 'architecture', needsCode: true, actor: false, parents: [] },
  container: { level: 'c2', element: true, family: 'architecture', needsCode: true, actor: false, parents: ['system', 'external'] },
  // Phase 28 (b390), b456: was `layer` (the old word still reads, plan/renames.ts). A named group of components inside a container;
  // a layer when the project orders its subregions as a stack (declaration order = top to bottom). Level c3 so `plan tree c3 <subregion>` lists its components.
  subregion: { level: 'c3', element: true, family: 'architecture', needsCode: false, actor: false, parents: ['container'] },
  component: { level: 'c3', element: true, family: 'architecture', needsCode: true, actor: false, parents: ['container', 'subregion'] },
  person: { level: null, element: true, family: 'architecture', needsCode: false, actor: true, parents: [] },
  external: { level: null, element: true, family: 'architecture', needsCode: false, actor: true, parents: [] },
  screen: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['container'] },
  region: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['screen'] },
  control: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['screen', 'region'] },
  state: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['screen', 'region', 'control'] },
  flow: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: null },
  journey: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: null },
  // b266: CLI / API / MCP surfaces, drawn in the IO view like screens. command, route and tool are the entries (like screen);
  // a subcommand is a command under a command. needsCode true for the entries: a done one must link to its code.
  command: { level: null, element: true, family: 'frontend', needsCode: true, actor: false, parents: ['container', 'command'] },
  options: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['command'] },
  flag: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['command', 'options'] },
  arg: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['command'] },
  route: { level: null, element: true, family: 'frontend', needsCode: true, actor: false, parents: ['container'] },
  body: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['route'] },
  param: { level: null, element: true, family: 'frontend', needsCode: false, actor: false, parents: ['route', 'body', 'tool'] },
  tool: { level: null, element: true, family: 'frontend', needsCode: true, actor: false, parents: ['container'] },
  // b210: storage kinds. A record sits only under a store; a field may hold fields (nested JSON / Mongo documents).
  store: { level: null, element: true, family: 'storage', needsCode: false, actor: false, parents: ['container'] },
  record: { level: null, element: true, family: 'storage', needsCode: false, actor: false, parents: ['store'] },
  field: { level: null, element: true, family: 'storage', needsCode: false, actor: false, parents: ['record', 'field'] },
};

/**
 * P20-T9 (b131): planned code kinds `plan add` can create. They are not in KIND_TABLE (never a map element), so
 * their parent rule sits here, next to it. Key = the word on the command line, `plan` = the kind written to the file.
 */
export const CODE_ADD_KINDS: Record<string, { plan: string; parents: string[] }> = {
  'planned-fn': { plan: 'function', parents: ['component'] },
  'planned-class': { plan: 'class', parents: ['component'] },
  'planned-type': { plan: 'type', parents: ['component'] },
};

/**
 * Phase 26 (T26-13, D15/D16, A7): accessories `plan add` can write. Not in KIND_TABLE (a row would make them c-items:
 * lookup, tree, uid, board links) and not elements: a `test` block is notation on its parent, like a field.
 */
export const ACCESSORY_ADD_KINDS: Record<string, { parents: string[] }> = {
  test: { parents: ['container', 'component', 'function', 'method'] },
};

/**
 * What `plan add <word>` writes: the plan kind and where it may go (parents [] = top level). null = not an addable word.
 * `accessory` = a block on the parent (a `test`), not an element.
 */
export interface AddRule { plan: string; parents: string[]; code: boolean; accessory?: true }
export function addRuleOf(wordArg: string): AddRule | null {
  const word = canonicalKind(wordArg);   // b456: `plan add layer` adds a subregion
  const code = Object.prototype.hasOwnProperty.call(CODE_ADD_KINDS, word) ? CODE_ADD_KINDS[word] : null;
  if (code) return { ...code, code: true };
  const accessory = Object.prototype.hasOwnProperty.call(ACCESSORY_ADD_KINDS, word) ? ACCESSORY_ADD_KINDS[word] : null;
  if (accessory) return { plan: word, parents: [...accessory.parents], code: false, accessory: true };
  const info = Object.prototype.hasOwnProperty.call(KIND_TABLE, word) ? KIND_TABLE[word] : null;
  return info?.parents ? { plan: word, parents: info.parents, code: false } : null;
}

/**
 * b405: kinds an element of `kind` may sit under (plan move): the KIND_TABLE parents, else the planned code rule
 * (CODE_ADD_KINDS by its written kind, e.g. function -> component). [] = top level only; null = no rule (flow, journey,
 * method, an unknown kind).
 */
export function parentKindsOf(kindArg: string): string[] | null {
  const kind = canonicalKind(kindArg);
  if (Object.prototype.hasOwnProperty.call(KIND_TABLE, kind)) {
    const parents = KIND_TABLE[kind].parents;
    return parents === null ? null : [...parents];
  }
  const code = Object.values(CODE_ADD_KINDS).find(c => c.plan === kind);
  return code ? [...code.parents] : null;
}

/** Every word `plan add` accepts: addable table kinds, then the planned code kinds, then the accessories. */
export const addableKinds = (): string[] => [
  ...Object.keys(KIND_TABLE).filter(k => KIND_TABLE[k].parents !== null),
  ...Object.keys(CODE_ADD_KINDS),
  ...Object.keys(ACCESSORY_ADD_KINDS),
];

/** Addable kinds with no parent (system, person, external): the choices of `plan add context --as`. */
export const topLevelKinds = (): string[] => Object.keys(KIND_TABLE).filter(k => KIND_TABLE[k].parents?.length === 0);

/** True for a kind of the table that is a plan element (lookup, tree, remove, uid). */
export const isElementKind = (kind: string): boolean => KIND_TABLE[kind]?.element === true;

/** b266: kinds an IO card is drawn for: a screen, a CLI command (subcommands too), an API route, an MCP tool. */
export const ENTRY_KINDS: ReadonlySet<string> = new Set(['screen', 'command', 'route', 'tool']);

/** b130, b266: kinds that hang under an entry as its parts. */
export const PART_KINDS: ReadonlySet<string> = new Set(['region', 'control', 'state', 'options', 'flag', 'arg', 'body', 'param']);

/** b130, b266: owning entry of a relation endpoint: the endpoint itself when an entry, or the entry above a chain of parts. Shared by navModel and check. */
export function owningEntry(id: string, byId: Map<string, { kind: string; id: string; parent: string | null }>): string | null {
  let cur = byId.get(id);
  while (cur) {
    if (ENTRY_KINDS.has(cur.kind)) return cur.id;
    if (!PART_KINDS.has(cur.kind) || cur.parent === null) return null;
    cur = byId.get(cur.parent);
  }
  return null;
}

/** True for screen, region, control, state, flow, journey and the b266 kinds (command, options, flag, arg, route, body, param, tool). */
export const isFrontendKind = (kind: string): boolean => KIND_TABLE[kind]?.family === 'frontend';

/** True for store, record and field (b210). */
export const isStorageKind = (kind: string): boolean => KIND_TABLE[kind]?.family === 'storage';

/** b273: the three views (the type is Foundation's, src/types.ts; re-exported for the callers that import it here). */
export type { ViewName };

const VIEW_OF_FAMILY: Record<KindInfo['family'], ViewName> = { architecture: 'arch', frontend: 'io', storage: 'storage' };

/** View a kind belongs to. Non-element and unknown kinds -> 'arch' (as today). */
export const viewOfKind = (kind: string): ViewName => (KIND_TABLE[kind] ? VIEW_OF_FAMILY[KIND_TABLE[kind].family] : 'arch');

/** Element kinds of a view, in table order. */
export const kindsOfView = (view: ViewName): string[] =>
  Object.keys(KIND_TABLE).filter(k => KIND_TABLE[k].element && VIEW_OF_FAMILY[KIND_TABLE[k].family] === view);

/** c1/c2/c3 for system/container/(subregion, component), null for every other kind. */
export const levelOf = (kind: string): TreeLevel | null => KIND_TABLE[kind]?.level ?? null;

/** False for subregion, person, external, the frontend and the storage kinds: they are never code-backed, so `done` without a link is fine. Unknown kinds need code. */
export const needsCode = (kind: string): boolean => KIND_TABLE[kind]?.needsCode !== false;

/** True for person and external: plan-only map nodes outside the system boundary. */
export const isMapActor = (kind: string): boolean => KIND_TABLE[kind]?.actor === true;

/** True for the boxes of the architecture map that nest: system, container, subregion, component (not person, external, nor the other families). One list for the view model. */
export const isArchBox = (kind: string): boolean => KIND_TABLE[kind]?.family === 'architecture' && !KIND_TABLE[kind].actor;
