import { Snapshot, Component, Plan, PlanElement, SourcePos } from '../types';
import { GENERATED_HEADER } from '../constants';
import { log } from '../log';
import { c4Id } from '../names';
import { UID_KEY, newUid } from '../util/uid';
import { quoteC4String, testBlockText } from './editMeta';
import { parseC4 } from '../plan/parser';
import { formatLink } from '../plan/links';
import { PLANNED_CODE_KINDS } from '../plan/plannedElements';
import { containerOf, declaredOrder } from '../plan/layers';
import { blockCopier, BlockCopier } from './blockText';

/**
 * Write a `metadata { key 'value' }` block (empty string for an empty object).
 * Key order: status, owner, sprint, priority, then the others sorted. `indent` is the column of `metadata`.
 */
function metadataBlock(meta: Record<string, string>, indent: string): string {
  const metadataKeys = Object.keys(meta);
  if (metadataKeys.length === 0) return '';

  const priorityKeys = ['status', 'owner', 'sprint', 'priority'];
  const orderedKeys = priorityKeys.filter(k => metadataKeys.includes(k));
  orderedKeys.push(...metadataKeys.filter(k => !priorityKeys.includes(k)).sort());

  let out = `${indent}metadata {\n`;
  for (const key of orderedKeys) {
    out += `${indent}  ${key} ${quoteC4String(meta[key])}\n`;
  }
  out += `${indent}}\n`;
  return out;
}

/**
 * Title literal for a generated element. An edited title in the existing plan wins over the scanned name (T45a).
 * Without an edit the output is the same `'name'` text as before.
 */
function titleLiteral(scanned: string, existingTitle: string | undefined): string {
  if (existingTitle !== undefined && existingTitle !== scanned) return quoteC4String(existingTitle);
  return `'${scanned}'`;
}

/** Writes the `test` blocks of an element (Phase 26, D16), each line starting with `indent`; '' when it has none. */
type TestsWriter = (el: PlanElement | undefined, indent: string) => string;

/**
 * B.6: test blocks come back verbatim when the plan text is known and the block's lines hold only that block (checked by
 * parsing the re-indented lines: one test, same name and case, no issue); else rebuilt as one line (A6).
 */
function testsWriter(planText?: (file: string) => string | undefined, covered?: (pos: SourcePos) => boolean): TestsWriter {
  return (el, indent) => (el?.tests ?? []).filter(t => !covered?.(t.source)).map(t => {
    const text = planText?.(t.source.file);
    if (text !== undefined && t.source.endLine !== undefined) {
      const lines = text.split('\n').slice(t.source.line - 1, t.source.endLine).map(l => l.replace(/\r$/, ''));
      const base = /^[ \t]*/.exec(lines[0])![0];
      const block = lines.map(l => indent + (l.startsWith(base) ? l.slice(base.length) : l.trimStart())).join('\n');
      const back = parseC4(`model {\n x = component 'x' {\n${block}\n }\n}\n`, t.source.file);
      const x = back.elements.length === 1 ? back.elements[0] : null;   // nothing else on those lines (no element, field, link, metadata)
      const only = x !== null && x.title === 'x' && x.description === null && x.technology === null && x.links.length === 0
        && Object.keys(x.metadata).length === 0 && back.relations.length === 0 && back.issues.length === 0;
      const got = only && x ? x.tests ?? [] : [];
      if (got.length === 1 && got[0].name === t.name && got[0].case === t.case) return block + '\n';
    }
    return `${indent}${testBlockText(t)}\n`;
  }).join('');
}

/** What the block writers share (b397): planned children not yet covered, test blocks not yet covered, the copier. */
interface BlockCtx {
  kids(parentId: string): PlanElement[];   // planned children of `parentId` that no copied block holds, at call time
  tests: TestsWriter;                      // skips a test block that a copied block holds
  copier: BlockCopier;
}

/**
 * Block for one planned code element (function/class/method/type) and, recursively, its planned children (L4-6).
 * Children are written inside it, so a method stays nested in its class and the class in its component.
 */
function plannedBlock(el: PlanElement, indent: string, ctx: BlockCtx): string {
  const copied = ctx.copier.copy(el, () => ctx.tests(el, `${indent}  `) + ctx.kids(el.id).map(k => plannedBlock(k, `${indent}  `, ctx)).join(''));
  if (copied !== null) return copied;
  const localId = el.id.slice(el.id.lastIndexOf('.') + 1);
  let out = `${indent}${localId} = ${el.kind} ${quoteC4String(el.title)} {\n`;
  if (el.technology) out += `${indent}  technology ${quoteC4String(el.technology)}\n`;
  if (el.description) out += `${indent}  description ${quoteC4String(el.description)}\n`;
  for (const link of el.links) out += `${indent}  link ${link.raw}\n`;
  out += metadataBlock(el.metadata, `${indent}  `);
  out += ctx.tests(el, `${indent}  `);
  for (const kid of ctx.kids(el.id)) out += plannedBlock(kid, `${indent}  `, ctx);
  out += `${indent}}\n`;
  return out;
}

/**
 * Block for a plan element the scan no longer finds (T45a): written back as the user had it, with a comment.
 * Indent is 4 spaces (inside `extend` in the generated files). Its planned children (L4-6) go inside it.
 */
function keptBlock(el: PlanElement, ctx: BlockCtx): string {
  const indent = '    ';
  const localId = el.id.slice(el.id.lastIndexOf('.') + 1);
  let out = `${indent}// kept by user: not found in the scan\n`;
  const copied = ctx.copier.copy(el, () => ctx.tests(el, `${indent}  `) + ctx.kids(el.id).map(k => plannedBlock(k, `${indent}  `, ctx)).join(''));
  if (copied !== null) return out + copied;
  out += `${indent}${localId} = ${el.kind} ${quoteC4String(el.title)} {\n`;
  if (el.technology) out += `${indent}  technology ${quoteC4String(el.technology)}\n`;
  if (el.description) out += `${indent}  description ${quoteC4String(el.description)}\n`;
  for (const link of el.links) out += `${indent}  link ${link.raw}\n`;
  out += metadataBlock(el.metadata, `${indent}  `);
  out += ctx.tests(el, `${indent}  `);
  for (const kid of ctx.kids(el.id)) out += plannedBlock(kid, `${indent}  `, ctx);
  out += `${indent}}\n`;
  return out;
}

/** Counts of what a re-run kept from the existing plan (T45b). `components` includes kept containers. */
export interface KeptCounts {
  titles: number;
  components: number;
  relations: number;
}

/**
 * Generate C4 `.c4` files from a snapshot.
 * Returns a map of filename → content (both .c4 extensions).
 *
 * - architecture.c4: specification + system with all containers
 * - One <containerId>.c4 per container with ≥1 component (contains components + relations)
 *
 * If existing plan provided, preserves description, metadata and edited titles for elements with matching IDs,
 * and keeps plan containers/components the scan no longer finds (marked `// kept by user`, T45a).
 */
export function generateC4(
  snapshot: Snapshot,
  existing?: Plan | null,
  opts?: {
    functionLinks?: boolean;
    linkBase?: string;
    repoRoot?: string;
    newUid?: () => string;
    /** Text of a plan file of `existing` (by Plan.files path). With it every existing element's block is written back as the user wrote it (b397); without it, rebuilt from the parsed plan. */
    planText?: (file: string) => string | undefined;
    onKept?: (kept: KeptCounts) => void;
  }
): Record<string, string> {
  const result: Record<string, string> = {};
  const mint = opts?.newUid ?? newUid;
  // b397: every existing block is copied as the user wrote it; `copier` remembers which lines it copied, so what sits inside
  // a copied block (children, test blocks, relations) is written nowhere else.
  const copier = blockCopier(opts?.planText);
  const tests = testsWriter(opts?.planText, copier.covers);   // Phase 26: every element generate writes keeps its test blocks (B.6)
  // What the re-run kept from the existing plan (T45b): edited titles, kept components, kept relations.
  let keptTitles = 0;
  const titleOf = (scanned: string, existingTitle: string | undefined): string => {
    if (existingTitle !== undefined && existingTitle !== scanned) keptTitles++;
    return titleLiteral(scanned, existingTitle);
  };
  // Folder the .c4 files live in, relative to the scan target. Default 'c4' keeps old output byte-identical.
  // repoRoot (absolute) is needed only when linkBase escapes the repo ('../...').
  const linkBase = opts?.linkBase ?? 'c4';
  const linkRoot = opts?.repoRoot;

  // Build a map of existing element fqn → element for fast lookup
  const existingMap = new Map<string, PlanElement>();
  if (existing) {
    for (const el of existing.elements) {
      existingMap.set(el.id, el);
    }
  }

  const sysId = c4Id(snapshot.system.id);
  const sysName = snapshot.system.name;

  // Phase 28 (LK-B, Q-3): layers (plan kind `subregion`, b456) are the user's. A scanned component whose (container, local id) twin sits in a layer is
  // skipped (its fqn is the twin's); layers are written back with their components, in declaration order, into the file
  // they were declared in (when generate writes that file). Nothing here runs for a plan without layers.
  const twinByKey = new Map<string, PlanElement>();
  const layersByParent = new Map<string, PlanElement[]>();
  const layerKidsByParent = new Map<string, PlanElement[]>();
  if (existing) {
    const byDeclaration = declaredOrder(existing);
    for (const el of [...existing.elements].sort(byDeclaration)) {
      if (el.kind === 'subregion' && el.parent !== null && el.id.split('.').length === 3 && el.id.startsWith(`${sysId}.`)) {
        if (!layersByParent.has(el.parent)) layersByParent.set(el.parent, []);
        layersByParent.get(el.parent)!.push(el);
      } else if (el.kind === 'component' && el.parent !== null && existingMap.get(el.parent)?.kind === 'subregion') {
        if (!layerKidsByParent.has(el.parent)) layerKidsByParent.set(el.parent, []);
        layerKidsByParent.get(el.parent)!.push(el);
        const cont = containerOf(existing, el);
        if (cont !== null) twinByKey.set(`${cont}\0${el.id.slice(el.id.lastIndexOf('.') + 1)}`, el);
      }
    }
  }
  /** The plan fqn of a scanned component: its layered twin's, else `<system>.<container>.<local id>`. */
  const fqnOfScanned = (sys: string, containerId: string, scannedLocal: string): string => {
    const cont = `${sys}.${c4Id(containerId)}`;
    const local = c4Id(scannedLocal);
    return twinByKey.get(`${cont}\0${local}`)?.id ?? `${cont}.${local}`;
  };
  /** A scanned component the plan already holds in a layer (its twin), or whose fqn is a layer's: the layer block keeps it, generate writes no second one. */
  const inLayer = (containerId: string, scannedLocal: string): boolean => {
    const cont = `${sysId}.${c4Id(containerId)}`;
    const local = c4Id(scannedLocal);
    return twinByKey.has(`${cont}\0${local}`) || existingMap.get(`${cont}.${local}`)?.kind === 'subregion';
  };
  /** Layers of a container to write back in architecture.c4 (declared there; only for a container this run writes there). */
  const archLayers = (parent: string): PlanElement[] => (layersByParent.get(parent) ?? []).filter(l => l.source.file === 'architecture.c4' && !copier.covers(l.source));
  /** Layers of a container to write back in its own file: declared there, or in architecture.c4 when the container is not written there. */
  const fileLayers = (parent: string, inArch: boolean): PlanElement[] =>
    (layersByParent.get(parent) ?? []).filter(l => (l.source.file === `${parent.split('.')[1]}.c4` || (!inArch && l.source.file === 'architecture.c4')) && !copier.covers(l.source));

  log('generate', 'generateC4 start', { containers: snapshot.containers.length, components: snapshot.components.length });

  // Generate architecture.c4

  // Plan elements the scan no longer finds are kept (T45a), grouped by parent fqn.
  const scannedFqns = new Set<string>([sysId]);
  for (const c of snapshot.containers) scannedFqns.add(`${sysId}.${c4Id(c.id)}`);
  for (const comp of snapshot.components) {
    scannedFqns.add(`${sysId}.${c4Id(comp.containerId)}.${c4Id(comp.id.split('/')[1])}`);
  }
  const keptContainers: PlanElement[] = [];
  const keptByParent = new Map<string, PlanElement[]>();
  for (const el of existing?.elements ?? []) {
    const segs = el.id.split('.');
    if (segs[0] !== sysId || scannedFqns.has(el.id)) continue;
    if (el.kind === 'container' && segs.length === 2) {
      keptContainers.push(el);
    } else if (el.kind === 'component' && segs.length === 3) {
      const parent = segs.slice(0, 2).join('.');
      if (!keptByParent.has(parent)) keptByParent.set(parent, []);
      keptByParent.get(parent)!.push(el);
    }
  }
  keptContainers.sort((a, b) => a.id.localeCompare(b.id));
  for (const kids of keptByParent.values()) kids.sort((a, b) => a.id.localeCompare(b.id));

  // Planned code (function/class/method/type) of the existing plan, by parent fqn, in plan order (L4-6).
  // The scan never finds these, so they are written back under their component, not dropped on re-run.
  const plannedKidsByParent = new Map<string, PlanElement[]>();
  for (const el of existing?.elements ?? []) {
    if (!PLANNED_CODE_KINDS.includes(el.kind) || el.parent === null) continue;
    if (!plannedKidsByParent.has(el.parent)) plannedKidsByParent.set(el.parent, []);
    plannedKidsByParent.get(el.parent)!.push(el);
  }

  // A layer block is written like planned code: the layer, its components (declaration order), their planned code.
  for (const [layer, kids] of layerKidsByParent) plannedKidsByParent.set(layer, kids);
  const ctx: BlockCtx = { copier, tests, kids: id => (plannedKidsByParent.get(id) ?? []).filter(k => !copier.covers(k.source)) };

  // Relations of the existing plan that generate-c4 does not write itself are kept (T45b). A relation that
  // matches a generated edge (same container, same from/to) is skipped: that edge is already written.
  const generatedRelKeys = new Set<string>();
  for (const edge of snapshot.componentEdges) {
    const fromCont = edge.from.split('/')[0];
    if (fromCont !== edge.to.split('/')[0]) continue;
    const fromFqn = fqnOfScanned(sysId, fromCont, edge.from.split('/')[1]);
    const toFqn = fqnOfScanned(sysId, fromCont, edge.to.split('/')[1]);
    generatedRelKeys.add(`${fromFqn} -> ${toFqn}`);
  }
  // Every element this run writes (scanned or kept). A kept relation whose end is not in this set is written as a comment.
  const writtenFqns = new Set<string>(scannedFqns);
  for (const el of keptContainers) writtenFqns.add(el.id);
  for (const kids of keptByParent.values()) for (const el of kids) writtenFqns.add(el.id);
  for (const layers of layersByParent.values()) for (const l of layers) { writtenFqns.add(l.id); for (const k of layerKidsByParent.get(l.id) ?? []) writtenFqns.add(k.id); }
  let archContent = GENERATED_HEADER + '\n';
  archContent += 'specification {\n';
  archContent += '  element system\n';
  archContent += '  element container\n';
  archContent += '  element component\n';
  archContent += '}\n';
  archContent += '\n';
  archContent += 'model {\n';
  const existingSys = existingMap.get(sysId);
  const sysTitle = titleOf(sysName, existingSys?.title);

  // Sort containers by id
  const sortedContainers = [...snapshot.containers].sort((a, b) => a.id.localeCompare(b.id));

  // One container inside the system block: the user's block when the plan has one, else built (a NEW container also gets a uid).
  const containerText = (container: Snapshot['containers'][number]): string => {
    const contId = c4Id(container.id);
    const existingCont = existingMap.get(`${sysId}.${contId}`);
    const contTitle = titleOf(container.name, existingCont?.title);
    if (existingCont) {
      const copied = copier.copy(existingCont, () => tests(existingCont, '      ') + archLayers(`${sysId}.${contId}`).map(l => plannedBlock(l, '      ', ctx)).join(''));
      if (copied !== null) return copied;
    }
    const contMeta: Record<string, string> = { ...(existingCont?.metadata ?? {}) };
    if (!existingCont) contMeta[UID_KEY] = mint();
    let out = `    ${contId} = container ${contTitle} {\n`;
    out += `      technology '${container.tech}'\n`;
    out += metadataBlock(contMeta, '      ');
    out += tests(existingCont, '      ');
    for (const layer of archLayers(`${sysId}.${contId}`)) out += plannedBlock(layer, '      ', ctx);
    out += '    }\n';
    return out;
  };

  /** A container block the system block does not hold yet (a block inside the copied system block is already there; its title still counts). */
  const newContainerText = (container: Snapshot['containers'][number]): string => {
    const existingCont = existingMap.get(`${sysId}.${c4Id(container.id)}`);
    if (existingCont && copier.covers(existingCont.source)) { titleOf(container.name, existingCont.title); return ''; }
    return containerText(container);
  };

  // The system block: the user's block with the NEW containers added before its closing brace, else built.
  // Mint order for new elements: system, then containers sorted by id, then components.
  const sysCopy = existingSys ? copier.copy(existingSys, () => tests(existingSys, '    ')
    + sortedContainers.map(newContainerText).join('')) : null;
  if (sysCopy !== null) {
    archContent += sysCopy;
  } else {
    archContent += `  ${sysId} = system ${sysTitle} {\n`;
    // Metadata: kept from the existing plan; a NEW element also gets a uid.
    const sysMeta: Record<string, string> = { ...(existingSys?.metadata ?? {}) };
    if (!existingSys) sysMeta[UID_KEY] = mint();
    archContent += metadataBlock(sysMeta, '    ');
    archContent += tests(existingSys, '    ');
    for (const container of sortedContainers) archContent += newContainerText(container);
    archContent += '  }\n';
  }
  result['architecture.c4'] = '';   // placeholder: keeps the file first; the final text needs the relations, built last
  log('generate', 'generated architecture.c4');

  // Group components by container
  const componentsByContainer = new Map<string, Component[]>();
  for (const component of snapshot.components) {
    if (!componentsByContainer.has(component.containerId)) {
      componentsByContainer.set(component.containerId, []);
    }
    componentsByContainer.get(component.containerId)!.push(component);
  }

  // Generate one file per container with ≥1 component
  for (const container of sortedContainers) {
    const components = componentsByContainer.get(container.id) || [];
    const keptHere = (keptByParent.get(`${sysId}.${c4Id(container.id)}`) ?? []).filter(el => !copier.covers(el.source));
    const layersHere = fileLayers(`${sysId}.${c4Id(container.id)}`, true);
    if (components.length === 0 && keptHere.length === 0 && layersHere.length === 0) {
      log('generate', 'skip container with no components', { container: container.id });
      continue;
    }

    // Sort components by c4Id'd local id
    const localIds = components.filter(c => !inLayer(c.containerId, c.id.split('/')[1])).map(c => {
      const localId = c.id.split('/')[1];
      const c4LocalId = c4Id(localId);
      return { comp: c, localId, c4LocalId };
    });
    localIds.sort((a, b) => a.c4LocalId.localeCompare(b.c4LocalId));

    let fileContent = GENERATED_HEADER + '\n';
    fileContent += 'model {\n';

    const contId = c4Id(container.id);
    fileContent += `  extend ${sysId}.${contId} {\n`;

    // Write each component
    for (const { comp } of localIds) {
      const localId = c4Id(comp.id.split('/')[1]);
      const compName = comp.name;

      // Check if this component exists in the existing plan
      const fqn = `${sysId}.${contId}.${localId}`;
      const existing_el = existingMap.get(fqn);

      const titleLit = titleOf(compName, existing_el?.title);
      if (existing_el) {
        if (copier.covers(existing_el.source)) continue;   // written inside a copied container block
        const copied = copier.copy(existing_el, () => tests(existing_el, '      ') + ctx.kids(fqn).map(k => plannedBlock(k, '      ', ctx)).join(''));
        if (copied !== null) { fileContent += copied; continue; }
      }
      fileContent += `    ${localId} = component ${titleLit}`;

      // Add description if it exists in the existing plan
      if (existing_el?.description) {
        fileContent += ` {\n`;
        fileContent += `      description '${existing_el.description}'\n`;
      } else {
        fileContent += ' {\n';
      }

      // Add links
      if (opts?.functionLinks && comp.mode === 'claim' && comp.claims && comp.claims.length > 0) {
        // Claim-mode component: one link per claim, in claim order, formatted by kind.
        for (const claim of comp.claims) {
          if (claim.kind === 'function') {
            const link = formatLink(claim.path, linkBase, claim.fn, linkRoot);
            fileContent += `      link ${link}\n`;
          } else {
            // 'folder' and 'file' claims: claim.path already carries the trailing
            // slash for folders (per the Claim contract), so formatLink's existing
            // folder/file handling applies unchanged.
            const link = formatLink(claim.path, linkBase, null, linkRoot);
            fileContent += `      link ${link}\n`;
          }
        }
      } else if (comp.id.split('/')[1] === '_root') {
        // For _root component, add one link per file, sorted
        const sortedFiles = [...comp.files].sort();
        for (const file of sortedFiles) {
          const link = formatLink(file, linkBase, null, linkRoot);
          fileContent += `      link ${link}\n`;
        }
      } else {
        // Normal component: one link to the folder
        const link = formatLink(comp.path + '/', linkBase, null, linkRoot);
        fileContent += `      link ${link}\n`;
      }

      // Metadata: kept from the existing plan; a NEW component also gets a uid.
      // An existing component without a uid stays without (`c4pm plan ids` adds it).
      const meta: Record<string, string> = { ...(existing_el?.metadata ?? {}) };
      if (!existing_el) meta[UID_KEY] = mint();
      fileContent += metadataBlock(meta, '      ');
      fileContent += tests(existing_el, '      ');

      for (const kid of ctx.kids(fqn)) fileContent += plannedBlock(kid, '      ', ctx);
      fileContent += '    }\n';
    }

    for (const layer of layersHere) fileContent += plannedBlock(layer, '    ', ctx);
    for (const el of keptHere) fileContent += keptBlock(el, ctx);

    fileContent += '  }\n';
    fileContent += '\n';

    // Write relations: componentEdges where both from and to are in this container
    const relationsInContainer = snapshot.componentEdges.filter(edge => {
      const fromContId = edge.from.split('/')[0];
      const toContId = edge.to.split('/')[0];
      return fromContId === container.id && toContId === container.id;
    });

    // Sort relations by (from, to) using c4Id'd component IDs
    const edgesWithIds = relationsInContainer.map(edge => {
      const fromLocalId = c4Id(edge.from.split('/')[1]);
      const toLocalId = c4Id(edge.to.split('/')[1]);
      return { edge, fromLocalId, toLocalId };
    });

    edgesWithIds.sort((a, b) => {
      if (a.fromLocalId !== b.fromLocalId) return a.fromLocalId.localeCompare(b.fromLocalId);
      return a.toLocalId.localeCompare(b.toLocalId);
    });

    for (const { edge } of edgesWithIds) {
      fileContent += `  ${fqnOfScanned(sysId, container.id, edge.from.split('/')[1])} -> ${fqnOfScanned(sysId, container.id, edge.to.split('/')[1])}\n`;
    }

    fileContent += '}\n';

    const fileName = c4Id(container.id) + '.c4';
    result[fileName] = fileContent;
    log('generate', 'generated container file', { container: container.id, file: fileName });
  }

  // Kept containers get their own file: the container block, then its kept components (T45a).
  const keptContainerFqns = new Set(keptContainers.map(el => el.id));
  for (const cont of keptContainers) {
    let text = GENERATED_HEADER + '\n' + 'model {\n';
    if (!copier.covers(cont.source)) text += `  extend ${sysId} {\n${keptBlock(cont, ctx)}  }\n`;   // inside a copied system block it is already there
    const kids = (keptByParent.get(cont.id) ?? []).filter(el => !copier.covers(el.source));
    const layers = fileLayers(cont.id, false);
    if (kids.length > 0 || layers.length > 0) {
      text += `  extend ${cont.id} {\n${layers.map(l => plannedBlock(l, '    ', ctx)).join('')}${kids.map(el => keptBlock(el, ctx)).join('')}  }\n`;
    }
    text += '}\n';
    if (text.includes('extend')) result[cont.id.split('.')[1] + '.c4'] = text;
  }

  // Kept components whose container is neither scanned nor kept: the plan's own `extend` target, in its own file.
  for (const parent of new Set([...keptByParent.keys(), ...layersByParent.keys()])) {
    if (scannedFqns.has(parent) || keptContainerFqns.has(parent)) continue;
    const kids = (keptByParent.get(parent) ?? []).filter(el => !copier.covers(el.source));
    const layers = fileLayers(parent, false);
    if (kids.length === 0 && layers.length === 0) continue;
    let text = GENERATED_HEADER + '\n' + 'model {\n';
    text += `  extend ${parent} {\n${layers.map(l => plannedBlock(l, '    ', ctx)).join('')}${kids.map(el => keptBlock(el, ctx)).join('')}  }\n`;
    text += '}\n';
    result[parent.split('.')[1] + '.c4'] = text;
  }

  // Kept relations last: a relation inside a block copied above came back with it (b397).
  const keptRelLines: string[] = [];
  const seenKeptRel = new Set<string>();
  for (const rel of existing?.relations ?? []) {
    const arrow = `${rel.from} -> ${rel.to}`;
    if (generatedRelKeys.has(arrow) || copier.covers(rel.source)) continue;   // a relation written inside a copied block comes back with it
    const label = rel.label === null ? '' : ` ${quoteC4String(rel.label)}`;
    const key = `${arrow}${label}`;
    if (seenKeptRel.has(key)) continue;
    seenKeptRel.add(key);
    if (writtenFqns.has(rel.from) && writtenFqns.has(rel.to)) {
      keptRelLines.push(`  ${arrow}${label}\n`);
    } else {
      keptRelLines.push(`  // kept by user: an end is not found in the scan\n  // ${arrow}${label}\n`);
    }
  }

  result['architecture.c4'] = archContent + keptRelLines.join('') + '}\n';

  if (opts?.onKept) {
    let keptComponents = keptContainers.length;
    for (const kids of keptByParent.values()) keptComponents += kids.length;
    opts.onKept({ titles: keptTitles, components: keptComponents, relations: keptRelLines.length });
  }

  return result;
}
