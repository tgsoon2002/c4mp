// VIEW-0 (b337), STOR-6a (b339): a rendered page whose C4PM_DATA has a storage-view tree, so the 'storage' view (registered by
// viewer/storageView.js on every page) has data. The tree is put into C4PM_DATA in front of storageView.js, which lays it out at its
// load (src/page/html.ts VIEWER_SCRIPTS: after ioView.js, before controls.js and map.js), so the switch order stays arch, io, storage.
// A page without this has the storage view registered but no data (has('storage') false, its switch segment disabled).

const ANCHOR = '// storageView.js: the storage view';

/** A small storage tree: the root and one zone with no store (the storage renderer lays it out). */
export const FAKE_STORAGE_ROOT = {
  id: '(storage)', kind: 'system', name: 'Storage view', x: 0, y: 0, w: 400, h: 300,
  children: [{ id: 'db.users', kind: 'container', name: 'users', x: 20, y: 20, w: 120, h: 80, children: [] }],
};

/** `html` with C4PM_DATA.storageView = { root: FAKE_STORAGE_ROOT, edges: [] } set before storageView.js runs. */
export function withFakeView(html: string): string {
  if (html.split(ANCHOR).length !== 2) throw new Error('withFakeView: the storageView.js anchor is not in the page exactly once');
  const js = `window.C4PM_DATA.storageView = { root: ${JSON.stringify(FAKE_STORAGE_ROOT)}, edges: [] };\n`;
  return html.replace(ANCHOR, () => js + ANCHOR);
}
