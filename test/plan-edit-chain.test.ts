import { makeRepo, writeSource } from './helpers/planEditHarness';
import { PlanEditChain, addCodeEdit, codeElementOf, codeOwnerOf } from '../src/services/planEditChain';
import { linkCheckError, uidEdit, writeSpecOf } from '../src/services/planOps';
import type { EditResult } from '../src/services/planOps';
import { loadPlanState, reparsePlan, runWrite } from '../src/services/planState';
import type { PlanState } from '../src/services/planState';
import { readFileOutline } from '../src/services/codeEdit';
import type { FileOutline } from '../src/types';

// b899 slice 2: uidEdit, addCodeEdit, codeOwnerOf, codeElementOf, PlanEditChain on a tmp repo.
const SOURCES: Record<string, string> = {
  'src/cart.ts': [
    'export function addItem(id: string): void {}',
    'export function total(): number { return 0; }',
    'export class Box { x = 1; open(): void { this.x = 2; } }',
    'export interface T { a: number }',
    '',
  ].join('\n'),
  'src/orders/pay.ts': 'export function charge(): void {}\nexport function refund(): void {}\n',
  'src/other.ts': 'export function lonely(): void {}\n',
};

function plan(links: Record<string, string>, withPay: boolean): string {
  return [
    'model {',
    "  shop = system 'Shop' {",
    "    api = container 'Shop api' {",
    "      cart = component 'Cart service' {",
    `        link ${links['src/cart.ts']}`,
    '        metadata {',
    "          uid 'u-cartsvc'",
    "          owner 'K'",
    '        }',
    "        addItem = function 'addItem' {",
    '          metadata {',
    "            status 'planned'",
    "            signature 'addItem(id: string): void'",
    '          }',
    '        }',
    '      }',
    "      orders = component 'Orders' {",
    `        link ${links['src/orders/']}`,
    '      }',
    ...(withPay ? ["      pay = component 'Pay' {", `        link ${links['src/orders/pay.ts']}#charge`, '      }'] : []),
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

function fixture(withPay = false): { root: string; state: PlanState; outline: (rel: string) => FileOutline } {
  const { root, planDir } = makeRepo('c4pm-chain-', {});
  const links: Record<string, string> = {};
  for (const [rel, text] of Object.entries(SOURCES)) links[rel] = writeSource(root, planDir, rel, text);
  links['src/orders/'] = links['src/orders/pay.ts'].replace(/pay\.ts$/, '');
  require('fs').writeFileSync(require('path').join(planDir, 'shop.c4'), plan(links, withPay));
  const state = loadPlanState(root) as PlanState;
  const outline = (rel: string): FileOutline => {
    const read = readFileOutline(root, {}, rel);
    return { ...read.outline, file: read.rel };
  };
  return { root, state, outline };
}

const okEdit = (r: EditResult) => {
  if (!r.ok) throw new Error(`refused: ${r.error.message}`);
  return r.edit;
};

describe('codeOwnerOf', () => {
  it('folder mode: the component whose file or folder link covers the code', () => {
    const { state, outline } = fixture();
    expect(codeOwnerOf(state.plan, outline('src/cart.ts'), 'total')).toBe('shop.api.cart');
    expect(codeOwnerOf(state.plan, outline('src/orders/pay.ts'), 'refund')).toBe('shop.api.orders');
    expect(codeOwnerOf(state.plan, outline('src/other.ts'), 'lonely')).toBeNull();
  });
  it('claim mode: a function claim wins over the folder claim', () => {
    const { state, outline } = fixture(true);
    expect(codeOwnerOf(state.plan, outline('src/orders/pay.ts'), 'charge')).toBe('shop.api.pay');
    expect(codeOwnerOf(state.plan, outline('src/orders/pay.ts'), 'refund')).toBe('shop.api.orders');
  });
});

describe('uidEdit', () => {
  it('mints a uid on a planned function once; unknown fqn is not-found', () => {
    const { state } = fixture();
    const edit = okEdit(uidEdit(state, 'shop.api.cart.addItem'));
    expect(edit.target.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(edit.after.elements.find(e => e.id === 'shop.api.cart.addItem')?.metadata.uid).toBe(edit.target.uid);
    expect(edit.post(edit.after)).toBeNull();
    const chain = new PlanEditChain(state);
    expect(chain.apply(s => uidEdit(s, 'shop.api.cart.addItem')).ok).toBe(true);
    const again = chain.apply(s => uidEdit(s, 'shop.api.cart.addItem'));
    expect(!again.ok && again.error.message).toMatch(/already has uid/);
    const nope = uidEdit(state, 'shop.nope');
    expect(!nope.ok && nope.error.code).toBe('not-found');
  });
});

describe('addCodeEdit', () => {
  it('adds a function under the owning component: done, component owner, link, no uid', () => {
    const { state, outline } = fixture();
    const edit = okEdit(addCodeEdit(state, { outline: outline('src/cart.ts'), name: 'total' }));
    const el = edit.after.elements.find(e => e.id === 'shop.api.cart.total');
    expect(el).toMatchObject({ kind: 'function', title: 'total', metadata: { status: 'done', owner: 'K' } });
    expect(el?.metadata.uid).toBeUndefined();
    expect(el?.links[0]).toMatchObject({ path: 'src/cart.ts', name: 'total' });
  });
  it('a method and a class get their own kind; spec.owner wins over the component owner', () => {
    const { state, outline } = fixture();
    const o = outline('src/cart.ts');
    const method = okEdit(addCodeEdit(state, { outline: o, name: 'Box.open' }));
    expect(method.after.elements.find(e => e.id === 'shop.api.cart.Box_open')?.kind).toBe('method');
    const cls = okEdit(addCodeEdit(state, { outline: o, name: 'Box' }));
    expect(cls.after.elements.find(e => e.id === 'shop.api.cart.Box')?.kind).toBe('class');
    const jay = okEdit(addCodeEdit(state, { outline: o, name: 'total', owner: 'Jay' }));
    expect(jay.after.elements.find(e => e.id === 'shop.api.cart.total')?.metadata.owner).toBe('Jay');
  });
  it.each([
    ['src/cart.ts', 'T', undefined, 'is a type'],
    ['src/other.ts', 'lonely', undefined, 'no component claims src/other.ts#lonely: link its file or folder to a component first (c4mp plan link <component> src/other.ts)'],
    ['src/orders/pay.ts', 'refund', undefined, 'set owner on shop.api.orders'],
    ['src/cart.ts', 'addItem', undefined, "shop.api.cart.addItem already exists (function 'addItem') and does not link src/cart.ts#addItem"],
    ['src/cart.ts', 'nope', undefined, "no function, class or method 'nope' in src/cart.ts"],
  ])('refuses %s#%s', (rel, name, owner, text) => {
    const { state, outline } = fixture();
    const r = addCodeEdit(state, { outline: outline(rel), name, owner });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain(text);
  });
});

describe('PlanEditChain', () => {
  it('chains edits into one gated write; a refused edit changes nothing', () => {
    const { root, state, outline } = fixture();
    const chain = new PlanEditChain(state);
    expect(new PlanEditChain(state).edit()).toBeNull();
    expect(codeElementOf(chain.state.plan, 'src/cart.ts', 'addItem')).toBeNull();
    expect(chain.apply(s => addCodeEdit(s, { outline: outline('src/cart.ts'), name: 'total' })).ok).toBe(true);
    expect(codeElementOf(chain.state.plan, 'src/cart.ts', 'total')?.id).toBe('shop.api.cart.total');
    expect(chain.apply(s => uidEdit(s, 'shop.api.cart.total')).ok).toBe(true);
    expect(chain.apply(s => addCodeEdit(s, { outline: outline('src/cart.ts'), name: 'Box.open' })).ok).toBe(true);
    const texts = chain.state.texts;
    expect(chain.apply(s => addCodeEdit(s, { outline: outline('src/other.ts'), name: 'lonely' })).ok).toBe(false);
    expect(chain.state.texts).toBe(texts);

    const edit = okEditOrNull(chain.edit());
    expect(linkCheckError(chain.start, edit)).toBeNull();
    const report = runWrite(writeSpecOf('test', { yes: true }, chain.start, edit));
    expect(report.error).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.written).toBe(true);
    expect(report.findings.new.filter(f => f.severity === 'warning' || f.severity === 'critical')).toEqual([]);
    const plan2 = reparsePlan(chain.start);
    const total = plan2.elements.find(e => e.id === 'shop.api.cart.total');
    expect(total?.metadata.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan2.elements.some(e => e.id === 'shop.api.cart.Box_open')).toBe(true);
    expect(root).toBeTruthy();
  });
  it('a chained move edit is refused', () => {
    const { state } = fixture();
    const chain = new PlanEditChain(state);
    const r = chain.apply(s => {
      const e = okEdit(uidEdit(s, 'shop.api.cart.addItem'));
      return { ok: true, edit: { ...e, moved: new Map() } } as EditResult;
    });
    expect(r.ok).toBe(false);
    expect(chain.edit()).toBeNull();
  });
});

function okEditOrNull<T>(e: T | null): T {
  if (e === null) throw new Error('no edit');
  return e;
}
