import path from 'path';
import { buildView, renderViewHtml } from '../src/page/html';
import type { ViewNode } from '../src/types';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';

// P16-B33: the map search also matches a node's `meta.tags` (a comma separated string).

const walk = (n: ViewNode, fn: (n: ViewNode) => void) => { fn(n); n.children.forEach(c => walk(c, fn)); };

function page() {
  const { model } = buildView({ repo: path.join(__dirname, 'fixtures/sample-v2') });
  walk(model.root, n => {
    if (n.id === 'api/routes') n.meta = { status: 'done', tags: 'billing, API' };
    if (n.id === 'api/payments') n.meta = { status: 'planned' };   // meta without tags
  });
  return runViewerScripts(renderViewHtml(model));
}

function search(h: ReturnType<typeof page>, q: string): string[] {
  h.search.value = q;
  h.search.dispatch('input', { target: h.search });
  return h.searchResults.querySelectorAll('.pn-search-result').map(r => serializeText(r).trim());
}

describe('P16-B33 search matches tags', () => {
  const h = page();

  it('finds a node by a tag, ignoring case, and only that node', () => {
    const r = search(h, 'billing');
    expect(r.length).toBe(1);
    expect(r[0]).toContain('Routes');
    expect(search(h, 'BILLING').length).toBe(1);
    expect(search(h, 'api').some(t => t.includes('Routes'))).toBe(true);   // the second tag, upper case in the data
  });

  it('nodes without meta or without tags do not throw and do not match', () => {
    expect(() => search(h, 'zzz-no-such-thing')).not.toThrow();
    expect(serializeText(h.searchResults)).toContain('No results');
    const hit = search(h, 'payments');   // still found by name
    expect(hit.length).toBeGreaterThan(0);
  });

  it('name, id and uid matching is unchanged', () => {
    expect(search(h, 'routes').some(t => t.includes('Routes'))).toBe(true);
  });
});
