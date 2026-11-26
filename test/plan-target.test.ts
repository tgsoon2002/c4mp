import { parsePlanTexts } from '../src/plan/parser';
import { resolvePlanTarget } from '../src/plan/planItems';

// T4a (b698): resolvePlanTarget finds one plan element the way `plan show` does and gives the ref to store
// (uid when the element has one, else its fqn), or why not (none with the closest 5, ambiguous).

const PLAN = [
  'model {',
  "  shop = system 'Shop' {",
  '    metadata {',
  "      uid 'u-shop'",
  '    }',
  "    api = container 'API' {",
  '      metadata {',
  "        uid 'u-api'",
  '      }',
  "      cart = component 'Cart' {",
  '        metadata {',
  "          uid 'u-cart'",
  '        }',
  '      }',
  "      orders = component 'Order service'",
  '    }',
  "    web = container 'Web' {",
  '      metadata {',
  "        uid 'u-web'",
  '      }',
  "      cart = component 'Basket' {",
  '        metadata {',
  "          uid 'u-wcart'",
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

const plan = parsePlanTexts('/x', new Map([['p.c4', PLAN]]));

describe('resolvePlanTarget (T4a)', () => {
  it('the plan parses', () => {
    expect(plan.issues).toEqual([]);
  });

  it.each<[string, string, string, string]>([
    ['a uid', 'u-cart', 'u-cart', 'shop.api.cart'],
    ['an fqn', 'shop.web.cart', 'u-wcart', 'shop.web.cart'],
    ['a local id', 'web', 'u-web', 'shop.web'],
    ['a title (any case)', 'basket', 'u-wcart', 'shop.web.cart'],
    ['an element without a uid: the ref is its fqn', 'orders', 'shop.api.orders', 'shop.api.orders'],
  ])('%s', (_label, target, ref, id) => {
    const r = resolvePlanTarget(plan, target);
    expect('kind' in r).toBe(false);
    if ('kind' in r) return;
    expect(r.ref).toBe(ref);
    expect(r.el.id).toBe(id);
  });

  it('several matches: ambiguous with every match', () => {
    const r = resolvePlanTarget(plan, 'cart');
    expect(r).toMatchObject({ kind: 'unresolved', reason: 'ambiguous' });
    if (!('kind' in r) || r.reason !== 'ambiguous') return;
    expect(r.matches.map((m) => m.id)).toEqual(['shop.api.cart', 'shop.web.cart']);
  });

  it('no match: none with the closest 5 (a name containing the query first)', () => {
    const r = resolvePlanTarget(plan, 'ord');
    expect(r).toMatchObject({ kind: 'unresolved', reason: 'none' });
    if (!('kind' in r) || r.reason !== 'none') return;
    expect(r.closest).toHaveLength(5);
    expect(r.closest[0].id).toBe('shop.api.orders');
  });
});
