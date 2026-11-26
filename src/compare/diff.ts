import type { Snapshot, RawChange, DiffSummary, ChangeType } from '../types';
import { detectRenames } from './renames';
import { findCycles } from './cycles';
import { log } from '../log';

function componentLines(snap: Snapshot, componentId: string): number {
  return snap.files
    .filter(f => f.componentId === componentId)
    .reduce((s, f) => s + f.lineCount, 0);
}

function mapFilePath(file: string, oldCompPath: string, newCompPath: string): string {
  const prefix = oldCompPath + '/';
  if (!file.startsWith(prefix)) return file;
  return newCompPath + '/' + file.slice(prefix.length);
}

/**
 * b568 + b582: a file or element changed when its line count differs, or when both sides carry a content hash
 * (parseCache addContentHashes) and the hashes differ. A side without one (a snapshot from before the hash) compares
 * by line count only, so an old history snapshot against a new one is not a change on every element.
 */
function contentDiffers(before: { lineCount: number; hash?: string }, after: { lineCount: number; hash?: string }): boolean {
  if (before.lineCount !== after.lineCount) return true;
  return before.hash !== undefined && after.hash !== undefined && before.hash !== after.hash;
}

function compareKeyedMaps<T>(opts: {
  before: Map<string, T>; after: Map<string, T>; type: ChangeType;
  extractValue: (item: T) => number | undefined; isModified?: (before: T, after: T) => boolean;
  renames?: Record<string, string>; logTag: string;
}): { changes: RawChange[]; counters: Record<string, number> } {
  const { before, after, type, extractValue, isModified, renames = {}, logTag } = opts;
  const changes: RawChange[] = [];
  const counters = { added: 0, removed: 0, renamed: 0, modified: 0 };

  for (const [oldId, newId] of Object.entries(renames)) {
    const beforeItem = before.get(oldId), afterItem = after.get(newId);
    if (beforeItem && afterItem) {
      const beforeVal = extractValue(beforeItem), afterVal = extractValue(afterItem);
      changes.push({ type, kind: 'renamed', id: newId, renamedFrom: oldId, before: beforeVal, after: afterVal });
      counters.renamed++;
      log('diff', `${logTag} renamed`, { oldId, newId, before: beforeVal, after: afterVal });
      if (isModified && isModified(beforeItem, afterItem)) {
        changes.push({ type, kind: 'modified', id: newId, before: beforeVal, after: afterVal });
        counters.modified++;
        log('diff', `${logTag} modified (renamed)`, { id: newId, before: beforeVal, after: afterVal });
      }
    }
  }

  const renamedToIds = new Set(Object.values(renames));
  for (const [id, item] of after) {
    if (!before.has(id) && !renamedToIds.has(id)) {
      const afterVal = extractValue(item);
      changes.push({ type, kind: 'added', id, after: afterVal });
      counters.added++;
      log('diff', `${logTag} added`, { id, after: afterVal });
    }
  }

  const renamedFromIds = new Set(Object.keys(renames));
  for (const [id, item] of before) {
    if (!after.has(id) && !renamedFromIds.has(id)) {
      const beforeVal = extractValue(item);
      changes.push({ type, kind: 'removed', id, before: beforeVal });
      counters.removed++;
      log('diff', `${logTag} removed`, { id, before: beforeVal });
    }
  }

  for (const [id, beforeItem] of before) {
    if (after.has(id) && !renamedFromIds.has(id) && !renamedToIds.has(id)) {
      const afterItem = after.get(id)!;
      if (isModified && isModified(beforeItem, afterItem)) {
        const beforeVal = extractValue(beforeItem), afterVal = extractValue(afterItem);
        changes.push({ type, kind: 'modified', id, before: beforeVal, after: afterVal });
        counters.modified++;
        log('diff', `${logTag} modified`, { id, before: beforeVal, after: afterVal });
      }
    }
  }

  return { changes, counters };
}

/**
 * Diff two snapshots and return raw changes + summary.
 * Algorithm: 10 steps per spec §5 P2-T11.
 */
export function diffSnapshots(a: Snapshot, b: Snapshot): { changes: RawChange[]; summary: DiffSummary } {
  const changes: RawChange[] = [];

  const { changes: c1, counters: cnt1 } = compareKeyedMaps({
    before: new Map(a.containers.map(c => [c.id, c])),
    after: new Map(b.containers.map(c => [c.id, c])),
    type: 'container',
    extractValue: () => undefined,
    logTag: 'container',
  });
  changes.push(...c1);
  const { added: containersAdded, removed: containersRemoved } = cnt1;
  const aComponentIds = new Map(a.components.map(c => [c.id, c]));
  const bComponentIds = new Map(b.components.map(c => [c.id, c]));

  const removedCandidates = Array.from(aComponentIds.values()).filter(c => !bComponentIds.has(c.id));
  const addedCandidates = Array.from(bComponentIds.values()).filter(c => !aComponentIds.has(c.id));

  const renames = detectRenames(removedCandidates, addedCandidates);
  log('diff', 'component renames detected', { count: Object.keys(renames).length });

  let componentsAdded = 0, componentsRemoved = 0, componentsRenamed = 0, componentsModified = 0;

  const removedRenamedIds = new Set(Object.keys(renames));
  for (const comp of removedCandidates) {
    if (!removedRenamedIds.has(comp.id)) {
      const before = componentLines(a, comp.id);
      changes.push({ type: 'component', kind: 'removed', id: comp.id, before });
      componentsRemoved++;
      log('diff', 'component removed', { id: comp.id, before });
    }
  }

  for (const [oldId, newId] of Object.entries(renames)) {
    const before = componentLines(a, oldId), after = componentLines(b, newId);
    changes.push({ type: 'component', kind: 'renamed', id: newId, renamedFrom: oldId, before, after });
    componentsRenamed++;
    log('diff', 'component renamed', { oldId, newId, before, after });
    if (before !== after) {
      changes.push({ type: 'component', kind: 'modified', id: newId, before, after });
      componentsModified++;
      log('diff', 'component modified (renamed)', { id: newId, before, after });
    }
  }

  const addedRenamedToIds = new Set(Object.values(renames));
  for (const comp of addedCandidates) {
    if (!addedRenamedToIds.has(comp.id)) {
      const after = componentLines(b, comp.id);
      changes.push({ type: 'component', kind: 'added', id: comp.id, after });
      componentsAdded++;
      log('diff', 'component added', { id: comp.id, after });
    }
  }

  for (const [compId] of aComponentIds) {
    if (bComponentIds.has(compId) && !removedRenamedIds.has(compId)) {
      const before = componentLines(a, compId), after = componentLines(b, compId);
      const elemsBefore = a.files.filter(f => f.componentId === compId).reduce((s, f) => s + f.elements.length, 0);
      const elemsAfter = b.files.filter(f => f.componentId === compId).reduce((s, f) => s + f.elements.length, 0);
      const filesBefore = a.files.filter(f => f.componentId === compId).length;
      const filesAfter = b.files.filter(f => f.componentId === compId).length;

      if (before !== after || elemsBefore !== elemsAfter || filesBefore !== filesAfter) {
        changes.push({ type: 'component', kind: 'modified', id: compId, before, after });
        componentsModified++;
        log('diff', 'component modified', { id: compId, before, after });
      }
    }
  }

  const filePathMap = new Map<string, string>();
  for (const [oldCompId, newCompId] of Object.entries(renames)) {
    const oldComp = aComponentIds.get(oldCompId), newComp = bComponentIds.get(newCompId);
    if (oldComp && newComp) {
      for (const file of oldComp.files) {
        filePathMap.set(file, mapFilePath(file, oldComp.path, newComp.path));
      }
    }
  }

  const aFiles = new Map(a.files.map(f => [f.file, f]));
  const bFiles = new Map(b.files.map(f => [f.file, f]));

  const aMappedFiles = new Map<string, typeof a.files[0]>();
  const aOriginalByMapped = new Map<string, string>();
  for (const [oldPath, file] of aFiles) {
    const mappedPath = filePathMap.get(oldPath) || oldPath;
    aMappedFiles.set(mappedPath, file);
    if (mappedPath !== oldPath) aOriginalByMapped.set(mappedPath, oldPath);
  }

  const aFilePaths = new Set(aMappedFiles.keys());
  const bFilePaths = new Set(bFiles.keys());

  let filesAdded = 0, filesRemoved = 0, filesRenamed = 0, filesModified = 0;

  for (const bp of bFilePaths) {
    if (!aFilePaths.has(bp)) {
      changes.push({ type: 'file', kind: 'added', id: bp, after: bFiles.get(bp)!.lineCount });
      filesAdded++;
      log('diff', 'file added', { id: bp, after: bFiles.get(bp)!.lineCount });
    }
  }

  for (const ap of aFilePaths) {
    if (!bFilePaths.has(ap)) {
      changes.push({ type: 'file', kind: 'removed', id: ap, before: aMappedFiles.get(ap)!.lineCount });
      filesRemoved++;
      log('diff', 'file removed', { id: ap, before: aMappedFiles.get(ap)!.lineCount });
    }
  }

  for (const cp of Array.from(aFilePaths).filter(p => bFilePaths.has(p))) {
    const orig = aOriginalByMapped.get(cp);
    const af = aMappedFiles.get(cp)!;
    const bf = bFiles.get(cp)!;
    if (orig) {
      changes.push({
        type: 'file',
        kind: 'renamed',
        id: cp,
        renamedFrom: orig,
        before: af.lineCount,
        after: bf.lineCount,
      });
      filesRenamed++;
      log('diff', 'file renamed', { from: orig, to: cp });
      if (contentDiffers(af, bf)) {
        changes.push({ type: 'file', kind: 'modified', id: cp, before: af.lineCount, after: bf.lineCount });
        filesModified++;
        log('diff', 'file modified (renamed)', { id: cp, before: af.lineCount, after: bf.lineCount });
      }
    } else if (contentDiffers(af, bf)) {
      changes.push({ type: 'file', kind: 'modified', id: cp, before: af.lineCount, after: bf.lineCount });
      filesModified++;
      log('diff', 'file modified', { id: cp, before: af.lineCount, after: bf.lineCount });
    }
  }

  const buildElementMap = (snap: Snapshot) => {
    const m = new Map<string, { lineCount: number; kind: string; hash?: string }>();
    for (const f of snap.files) {
      const path = snap === a ? (filePathMap.get(f.file) || f.file) : f.file;
      for (const e of f.elements) {
        let k = `${path}#${e.name}`;
        if (m.has(k)) {
          let s = 2;
          while (m.has(`${path}#${e.name}#${s}`)) s++;
          k = `${path}#${e.name}#${s}`;
        }
        m.set(k, { lineCount: e.lineCount, kind: e.kind, hash: e.hash });
      }
    }
    return m;
  };

  const aElementMap = buildElementMap(a);
  const bElementMap = buildElementMap(b);

  let elementsAdded = 0, elementsRemoved = 0, elementsModified = 0;

  for (const [k, e] of bElementMap) {
    if (!aElementMap.has(k)) {
      changes.push({ type: 'element', kind: 'added', id: k, after: e.lineCount, elementKind: e.kind as any });
      elementsAdded++;
      log('diff', 'element added', { id: k, after: e.lineCount });
    }
  }

  for (const [k, e] of aElementMap) {
    if (!bElementMap.has(k)) {
      changes.push({ type: 'element', kind: 'removed', id: k, before: e.lineCount, elementKind: e.kind as any });
      elementsRemoved++;
      log('diff', 'element removed', { id: k, before: e.lineCount });
    }
  }

  for (const [k, ea] of aElementMap) {
    if (bElementMap.has(k)) {
      const eb = bElementMap.get(k)!;
      if (contentDiffers(ea, eb)) {
        changes.push({ type: 'element', kind: 'modified', id: k, before: ea.lineCount, after: eb.lineCount, elementKind: eb.kind as any });
        elementsModified++;
        log('diff', 'element modified', { id: k, before: ea.lineCount, after: eb.lineCount });
      }
    }
  }

  const buildEdgeMap = (edges: typeof a.componentEdges, rm: Record<string, string> = {}) => {
    const m = new Map<string, number>();
    for (const e of edges) {
      const k = `${rm[e.from] || e.from} -> ${rm[e.to] || e.to}`;
      m.set(k, Math.max(m.get(k) ?? 0, e.weight));
    }
    return m;
  };

  const { changes: c2, counters: cnt2 } = compareKeyedMaps({
    before: buildEdgeMap(a.componentEdges, renames),
    after: buildEdgeMap(b.componentEdges),
    type: 'edge',
    extractValue: (w) => w,
    isModified: (before, after) => before !== after,
    logTag: 'edge',
  });
  changes.push(...c2);
  const { added: edgesAdded, removed: edgesRemoved } = cnt2;

  const aCycles = findCycles(a.componentEdges.map(e => ({
    from: renames[e.from] || e.from,
    to: renames[e.to] || e.to,
    weight: e.weight,
  })));
  const bCycles = findCycles(b.componentEdges);
  const aCyclesSet = new Set(aCycles);
  const bCyclesSet = new Set(bCycles);

  let cyclesAdded = 0, cyclesRemoved = 0;
  for (const c of bCycles) {
    if (!aCyclesSet.has(c)) {
      changes.push({ type: 'cycle', kind: 'added', id: c });
      cyclesAdded++;
      log('diff', 'cycle added', { id: c });
    }
  }
  for (const c of aCycles) {
    if (!bCyclesSet.has(c)) {
      changes.push({ type: 'cycle', kind: 'removed', id: c });
      cyclesRemoved++;
      log('diff', 'cycle removed', { id: c });
    }
  }

  const { changes: c3, counters: cnt3 } = compareKeyedMaps({
    before: new Map(a.externals.map(e => [e.pkg, true])),
    after: new Map(b.externals.map(e => [e.pkg, true])),
    type: 'external',
    extractValue: () => undefined,
    logTag: 'external',
  });
  changes.push(...c3);
  const { added: externalsAdded, removed: externalsRemoved } = cnt3;

  const aUnresolved = a.stats.unresolvedImports, bUnresolved = b.stats.unresolvedImports;
  if (aUnresolved !== bUnresolved) {
    changes.push({ type: 'health', kind: 'modified', id: 'unresolved imports', before: aUnresolved, after: bUnresolved });
    log('diff', 'health changed (unresolved imports)', { before: aUnresolved, after: bUnresolved });
  }

  const aParseErrors = a.files.filter(f => f.parseError).length;
  const bParseErrors = b.files.filter(f => f.parseError).length;
  if (aParseErrors !== bParseErrors) {
    changes.push({ type: 'health', kind: 'modified', id: 'parse errors', before: aParseErrors, after: bParseErrors });
    log('diff', 'health changed (parse errors)', { before: aParseErrors, after: bParseErrors });
  }

  const linesBefore = a.files.reduce((s, f) => s + f.lineCount, 0);
  const linesAfter = b.files.reduce((s, f) => s + f.lineCount, 0);

  const summary: DiffSummary = {
    componentsAdded, componentsRemoved, componentsRenamed, componentsModified,
    filesAdded, filesRemoved, filesRenamed, filesModified,
    elementsAdded, elementsRemoved, elementsModified,
    edgesAdded, edgesRemoved, cyclesAdded, cyclesRemoved,
    linesBefore, linesAfter,
  };

  log('diff', 'summary', summary);
  return { changes, summary };
}
