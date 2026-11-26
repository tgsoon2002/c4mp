import type { CodeElement, FileCalls, Snapshot } from '../types';

/** The pseudo caller of calls made outside any named function. The parser names it; the call graph hands it to its
 *  users beside callIndex (b492, row Q8). It lives in Foundation (b592) so the parser (Readers) never imports the call
 *  graph (Engines); re-exported here for those users. */
export { MODULE_CALLER } from '../constants';

// P8 call resolution, moved down from query/calls.ts (Phase 26, ATTACH-DESIGN A1) so engines (the test attachment)
// and the calls / callers queries judge call sites with one set of rules.

/** What a call site reaches: a function or method of the repo, an external package or builtin, or nothing traced. */
export type Verdict = { kind: 'edge'; file: string; name: string } | { kind: 'external' } | { kind: 'unresolved' };

/** `line` is where the call expression starts; b682 `at` is the called name's line and column (RawCall.at). */
export interface CallSite { file: string; caller: string; line: number; callee: string | null; verdict: Verdict; at?: { line: number; column: number }; }

export interface CallIndex {
  sites: CallSite[];
  elements: Map<string, CodeElement>;   // `file#name` of every element of the scan (the first one of a repeated name)
}

const GLOBALS = new Set([
  'console', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'String', 'Number', 'Boolean', 'Date', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Error', 'RegExp', 'Symbol', 'Buffer', 'process', 'Reflect', 'Intl', 'URL', 'BigInt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'fetch', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'globalThis', 'Function', 'Uint8Array', 'TextEncoder', 'TextDecoder',
]);

/** Element kinds a call edge can end at. */
export const EDGE_KINDS = ['function', 'method'];

/** Verdict for every call site of one file: same-file names, imported names, instances, `this`, namespace imports. */
export function judge(fc: FileCalls, elements: Map<string, CodeElement>): CallSite[] {
  const bindings = new Map(fc.bindings.map((b) => [b.local, b]));
  const instances = new Map(fc.instances.map((i) => [i.name, i.className]));
  const unresolved: Verdict = { kind: 'unresolved' };

  const edgeTo = (file: string, name: string): Verdict | null => {
    const el = elements.get(`${file}#${name}`);
    return el && EDGE_KINDS.includes(el.kind) ? { kind: 'edge', file, name } : null;
  };

  const verdictOf = (caller: string, callee: string | null): Verdict => {
    if (callee === null) return unresolved;
    const parts = callee.split('.');
    const head = parts[0];
    const bound = bindings.get(head);
    if (parts.length === 1) {
      return edgeTo(fc.file, head)
        ?? (bound?.target && bound.imported !== 'default' && bound.imported !== '*' ? edgeTo(bound.target, bound.imported) : null)
        ?? (bound?.external || (!bound && GLOBALS.has(head)) ? { kind: 'external' } : unresolved);
    }
    if (head === 'this') {
      const dot = caller.indexOf('.');
      return parts.length === 2 && dot > 0 ? edgeTo(fc.file, `${caller.slice(0, dot)}.${parts[1]}`) ?? unresolved : unresolved;
    }
    if (parts.length === 2) {
      const member = parts[1];
      const cls = instances.get(head);
      if (cls) {
        const viaImport = bindings.get(cls);
        const hit = viaImport?.target ? edgeTo(viaImport.target, `${viaImport.imported}.${member}`) : edgeTo(fc.file, `${cls}.${member}`);
        if (hit) return hit;
      }
      const local = edgeTo(fc.file, callee);   // object literal method or static method: `obj.m`, `Class.m`
      if (local) return local;
      if (bound?.target) {
        const hit = bound.imported === '*' ? edgeTo(bound.target, member) : edgeTo(bound.target, `${bound.imported}.${member}`);
        if (hit) return hit;
      }
    }
    return bound?.external || (!bound && !instances.has(head) && GLOBALS.has(head)) ? { kind: 'external' } : unresolved;
  };

  return fc.calls.map((c) => ({ file: fc.file, caller: c.caller, line: c.line, callee: c.callee, verdict: verdictOf(c.caller, c.callee), ...(c.at && { at: c.at }) }));
}

const indexes = new WeakMap<Snapshot, CallIndex>();

/** Every call site of the scan with its verdict; built once per snapshot object (the MCP context caches it). */
export function callIndex(snapshot: Snapshot): CallIndex {
  let idx = indexes.get(snapshot);
  if (!idx) {
    const elements = new Map<string, CodeElement>();
    for (const f of snapshot.files) for (const e of f.elements) if (!elements.has(`${f.file}#${e.name}`)) elements.set(`${f.file}#${e.name}`, e);
    idx = { sites: (snapshot.calls ?? []).flatMap((fc) => judge(fc, elements)), elements };
    indexes.set(snapshot, idx);
  }
  return idx;
}
