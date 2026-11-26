import { parsePlanTexts } from '../src/plan/parser';
import { layerIndex } from '../src/plan/layers';
import { layersBetween, routeHint, shortId } from '../src/c4/layerRoute';
import type { ComponentEdge, Plan } from '../src/types';

// b465 shared helpers: layerIndex (plan/layers.ts) and layerRoute (c4/layerRoute.ts), used by b466 and b469.
const PLAN = [
  "model {",
  "  shop = system 'Shop' {",
  "    api = container 'Api' {",
  "      entry = subregion 'Entry' {",
  "        cli = component 'Cli'",
  "      }",
  "      services = subregion 'Services' {",
  "        query = component 'Query'",
  "        report = component 'Report'",
  "      }",
  "      util = subregion 'Util' {",
  "        metadata {",
  "          shared 'true'",
  "        }",
  "        text = component 'Text'",
  "      }",
  "      engines = layer 'Engines' {",
  "        scan = component 'Scan'",
  "      }",
  "      readers = subregion 'Readers' {",
  "        ws = component 'Workspace'",
  "      }",
  "      loose = component 'Loose'",
  "    }",
  "    web = container 'Web' {",
  "      page = component 'Page'",
  "    }",
  "  }",
  "}",
].join('\n');

const plan: Plan = parsePlanTexts('/repo', new Map([['a.c4', PLAN]]));
const E = (from: string, to: string, weight = 1): ComponentEdge => ({ from: `shop.api.${from}`, to: `shop.api.${to}`, weight });
const A = (id: string): string => `shop.api.${id}`;

describe('layerIndex', () => {
  const idx = layerIndex(plan);

  it('stacks: containers with subregions only, in declaration order, shared and old `layer` kind included', () => {
    expect([...idx.stacks.keys()]).toEqual(['shop.api']);
    expect(idx.stacks.get('shop.api')!.map((l) => l.id)).toEqual(
      ['shop.api.entry', 'shop.api.services', 'shop.api.util', 'shop.api.engines', 'shop.api.readers']);
  });

  it.each([
    ['entry.cli', 0, 'shop.api.entry', false],
    ['services.report', 1, 'shop.api.services', false],
    ['util.text', 2, 'shop.api.util', true],
    ['readers.ws', 4, 'shop.api.readers', false],
  ])('place of %s: rank %d in %s, shared %s', (id, rank, layer, shared) => {
    const p = idx.place(A(id))!;
    expect(p).toMatchObject({ container: 'shop.api', rank, shared });
    expect(p.layer.id).toBe(layer);
  });

  it('null for a loose component, a component of a container without subregions, a subregion, an unknown id', () => {
    expect(idx.place(A('loose'))).toBeNull();
    expect(idx.place('shop.web.page')).toBeNull();
    expect(idx.place(A('services'))).toBeNull();
    expect(idx.place('nope')).toBeNull();
  });

  it('a plan without subregions: no stacks, nothing placed', () => {
    const flat = parsePlanTexts('/repo', new Map([['a.c4', "model {\n  s = system 'S' {\n    c = container 'C' {\n      x = component 'X'\n    }\n  }\n}"]]));
    const i = layerIndex(flat);
    expect(i.stacks.size).toBe(0);
    expect(i.place('s.c.x')).toBeNull();
  });
});

describe('layersBetween', () => {
  const idx = layerIndex(plan);

  it('non-shared layers strictly between, top to bottom, with the components that already call the target', () => {
    const edges = [E('services.report', 'readers.ws', 2), E('services.query', 'readers.ws'), E('util.text', 'readers.ws'), E('entry.cli', 'readers.ws')];
    const steps = layersBetween(idx, edges, A('entry.cli'), A('readers.ws'));
    expect(steps.map((s) => [s.layer.id, s.rank, s.callers])).toEqual([
      ['shop.api.services', 1, [A('services.query'), A('services.report')]],
      ['shop.api.engines', 3, []],
    ]);
  });

  it('adjacent layers, same layer, other container, unplaced end: []', () => {
    expect(layersBetween(idx, [], A('entry.cli'), A('services.query'))).toEqual([]);
    expect(layersBetween(idx, [], A('services.query'), A('services.report'))).toEqual([]);
    expect(layersBetween(idx, [], A('entry.cli'), 'shop.web.page')).toEqual([]);
    expect(layersBetween(idx, [], A('loose'), A('readers.ws'))).toEqual([]);
  });
});

describe('routeHint', () => {
  const idx = layerIndex(plan);

  it('null when no layer between has a caller of the target', () => {
    expect(routeHint(idx, [E('entry.cli', 'readers.ws')], A('entry.cli'), A('readers.ws'))).toBeNull();
  });

  it('prefers a caller `from` already calls, then the nearest layer, then id order', () => {
    const base = [E('services.report', 'readers.ws'), E('engines.scan', 'readers.ws'), E('services.query', 'readers.ws')];
    expect(routeHint(idx, base, A('entry.cli'), A('readers.ws'))).toEqual({ via: A('services.query'), viaUses: A('readers.ws') });
    expect(routeHint(idx, [...base, E('entry.cli', 'engines.scan')], A('entry.cli'), A('readers.ws'))!.via).toBe(A('engines.scan'));
    expect(routeHint(idx, [E('engines.scan', 'readers.ws')], A('entry.cli'), A('readers.ws'))!.via).toBe(A('engines.scan'));
  });
});

it('shortId drops the container prefix only', () => {
  expect(shortId('c4pm.c4pm', 'c4pm.c4pm.services.query')).toBe('services.query');
  expect(shortId('c4pm.c4pm', 'other.x')).toBe('other.x');
});
