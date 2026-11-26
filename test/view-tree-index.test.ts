import { idIndex, uidIndex } from '../src/view/tree';
import type { ViewKind, ViewModel, ViewNode } from '../src/types';

// Phase 25 (S4, UI1 b751): the shared uid / id indexes over the arch, IO and storage trees (src/view/tree.ts).

function node(id: string, kind: ViewKind, extra: Partial<ViewNode> = {}, children: ViewNode[] = []): ViewNode {
  return { id, kind, name: id, detail: '', weight: 1, children, x: 0, y: 0, w: 0, h: 0, callsAvailable: false, ...extra };
}

/** Arch: system > container `c` (subregion `c.layer`) > component `c.k`; IO: group > screen; storage: zone > store > record. Ids and uids clash on purpose. */
function model(): ViewModel {
  const arch = node('sys', 'system', {}, [node('c', 'container', { uid: 'u-c', subregions: [node('c.layer', 'subregion', { uid: 'u-layer' })] }, [
    node('c.k', 'component', { uid: 'u-k', planId: 'plan.k' }),
  ])]);
  const io = node('(io)', 'system', {}, [node('c', 'container', { uid: 'u-c' }, [node('c.screen', 'screen', { uid: 'u-screen' })])]);
  const storage = node('(storage)', 'system', {}, [node('zone', 'container', { uid: 'u-screen' }, [
    node('zone.db', 'store', { uid: 'u-db' }, [node('zone.db.t', 'record', { uid: 'u-t', planId: 'plan.k' })]),
  ])]);
  return {
    schemaVersion: 1, title: 't', subtitle: '', summary: '', repoPath: '/r', root: arch, edges: [], drift: null, planFindings: [], files: [],
    navView: { root: io, edges: [] }, storageView: { root: storage, edges: [] },
  };
}

describe('uidIndex', () => {
  test('first uid wins in arch, IO, storage order; every tree and subregions are walked', () => {
    const m = model();
    const idx = uidIndex(m);
    expect(idx.get('u-c')).toEqual({ node: m.root.children[0], view: 'arch' });            // arch over IO
    expect(idx.get('u-screen')?.view).toBe('io');                                           // IO over storage
    expect(idx.get('u-screen')?.node.id).toBe('c.screen');
    expect(idx.get('u-t')).toEqual({ node: m.storageView!.root.children[0].children[0].children[0], view: 'storage' });
    expect(idx.get('u-layer')?.node.kind).toBe('subregion');
    expect(idx.has('u-db')).toBe(true);
    expect(idx.size).toBe(6);
  });

  test('a model with only the arch tree indexes the arch tree', () => {
    const m = model();
    delete m.navView;
    delete m.storageView;
    expect([...uidIndex(m).keys()].sort()).toEqual(['u-c', 'u-k', 'u-layer']);
  });
});

describe('idIndex', () => {
  test('node.id and node.planId keys, first wins in arch, IO, storage order, with the parent in its own tree', () => {
    const m = model();
    const idx = idIndex(m);
    const archC = m.root.children[0];
    expect(idx.get('c')).toEqual({ node: archC, view: 'arch', parent: m.root });          // the IO group 'c' loses
    expect(idx.get('sys')).toEqual({ node: m.root, view: 'arch', parent: null });
    expect(idx.get('plan.k')?.node.id).toBe('c.k');                                       // arch planId over the storage record's
    expect(idx.get('c.k')?.parent).toBe(archC);
    expect(idx.get('c.layer')).toEqual({ node: archC.subregions![0], view: 'arch', parent: archC });
    expect(idx.get('c.screen')).toEqual({ node: m.navView!.root.children[0].children[0], view: 'io', parent: m.navView!.root.children[0] });
    expect(idx.get('zone.db.t')?.view).toBe('storage');
    expect(idx.get('zone.db.t')?.parent?.id).toBe('zone.db');
  });
});
