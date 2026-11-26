import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSnapshot } from '../src/pipeline';
import { resolveLinks, claimedFiles } from '../src/plan/resolve';
import { checkPlan } from '../src/c4/check';
import { resolveLink } from '../src/query/resolveLink';
import type { Plan, PlanElement, PlanLink } from '../src/types';

function buildSingleFolderLinkPlan(folderPath: string): Plan {
  const link: PlanLink = {
    raw: './',
    path: folderPath,
    name: null,
    lines: null,
    title: null,
  };

  const element: PlanElement = {
    id: 'test.folder.link',
    kind: 'component',
    title: 'Folder Link',
    description: null,
    technology: null,
    links: [link],
    metadata: {},
    parent: null,
    source: { file: 'test.c4', line: 1 },
  };

  return {
    files: [],
    elements: [element],
    relations: [],
    issues: [],
  };
}

describe('resolveLinks', () => {
  const fixtureRoot = path.join(__dirname, 'fixtures/phofast');

  // Build PhoFast Plan by hand with the 8 components from §3.1
  function buildPhoFastPlan(): Plan {
    const elements: PlanElement[] = [
      {
        id: 'phofast.api.auth',
        kind: 'component',
        title: 'Auth Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts#L6-L13', path: 'src/api/auth/index.ts', name: null, lines: { start: 6, end: 13 }, title: null }],
        metadata: { status: 'done', owner: 'kien' },
        parent: null,
        source: { file: 'src/api/auth/auth.c4', line: 1 },
      },
      {
        id: 'phofast.api.orders',
        kind: 'component',
        title: 'Order Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts#L7-L14', path: 'src/api/orders/index.ts', name: null, lines: { start: 7, end: 14 }, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/api/orders/orders.c4', line: 1 },
      },
      {
        id: 'phofast.api.payments',
        kind: 'component',
        title: 'Payment Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './stripe.ts', path: 'src/api/payments/stripe.ts', name: null, lines: null, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/api/payments/payments.c4', line: 1 },
      },
      {
        id: 'phofast.api.menu',
        kind: 'component',
        title: 'Menu Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts', path: 'src/api/menu/index.ts', name: null, lines: null, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/api/menu/menu.c4', line: 1 },
      },
      {
        id: 'phofast.api.notify',
        kind: 'component',
        title: 'Notification Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts', path: 'src/api/notify/index.ts', name: null, lines: null, title: null }],
        metadata: { status: 'planned', sprint: 'S14' },
        parent: null,
        source: { file: 'src/api/notify/notify.c4', line: 1 },
      },
      {
        id: 'phofast.web.checkout',
        kind: 'component',
        title: 'Checkout',
        description: null,
        technology: 'React',
        links: [{ raw: './Checkout.tsx#L3-L14', path: 'src/web/pages/Checkout.tsx', name: null, lines: { start: 3, end: 14 }, title: null }],
        metadata: { status: 'in-progress' },
        parent: null,
        source: { file: 'src/web/pages/pages.c4', line: 1 },
      },
      {
        id: 'phofast.web.menupage',
        kind: 'component',
        title: 'Menu Page',
        description: null,
        technology: 'React',
        links: [{ raw: './Menu.tsx', path: 'src/web/pages/Menu.tsx', name: null, lines: null, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/web/pages/pages.c4', line: 1 },
      },
      {
        id: 'phofast.web.reviews',
        kind: 'component',
        title: 'Reviews',
        description: null,
        technology: 'React',
        links: [{ raw: './Reviews.tsx', path: 'src/web/pages/Reviews.tsx', name: null, lines: null, title: null }],
        metadata: { status: 'abandoned' },
        parent: null,
        source: { file: 'src/web/pages/pages.c4', line: 1 },
      },
    ];

    return {
      files: [
        'src/api/auth/auth.c4',
        'src/api/menu/menu.c4',
        'src/api/notify/notify.c4',
        'src/api/orders/orders.c4',
        'src/api/payments/payments.c4',
        'src/architecture.c4',
        'src/web/pages/pages.c4',
      ],
      elements,
      relations: [],
      issues: [],
    };
  }

  it('resolves phofast auth link: lines 6-13 exists', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const authLink = resolved.find(l => l.elementId === 'phofast.api.auth');
    expect(authLink).toBeDefined();
    expect(authLink!.link.raw).toBe('./index.ts#L6-L13');
    expect(authLink!.exists).toBe(true);
    expect(authLink!.target).toBe('lines');
    expect(authLink!.range).toEqual({ start: 6, end: 13 });
    expect(authLink!.found).toBe(true);
  });

  it('resolves phofast orders link: lines 7-14 exists', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const ordersLink = resolved.find(l => l.elementId === 'phofast.api.orders');
    expect(ordersLink).toBeDefined();
    expect(ordersLink!.link.raw).toBe('./index.ts#L7-L14');
    expect(ordersLink!.exists).toBe(true);
    expect(ordersLink!.target).toBe('lines');
    expect(ordersLink!.range).toEqual({ start: 7, end: 14 });
    expect(ordersLink!.found).toBe(true);
  });

  it('resolves phofast payments link: stripe.ts does not exist', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const paymentsLink = resolved.find(l => l.elementId === 'phofast.api.payments');
    expect(paymentsLink).toBeDefined();
    expect(paymentsLink!.link.raw).toBe('./stripe.ts');
    expect(paymentsLink!.exists).toBe(false);
    expect(paymentsLink!.target).toBe('file');
    expect(paymentsLink!.range).toBeNull();
    expect(paymentsLink!.found).toBe(false);
  });

  it('resolves phofast menu link: file exists', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const menuLink = resolved.find(l => l.elementId === 'phofast.api.menu');
    expect(menuLink).toBeDefined();
    expect(menuLink!.link.raw).toBe('./index.ts');
    expect(menuLink!.exists).toBe(true);
    expect(menuLink!.target).toBe('file');
    expect(menuLink!.range).toBeNull();
    expect(menuLink!.found).toBe(true);
  });

  it('resolves phofast notify link: file does not exist', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const notifyLink = resolved.find(l => l.elementId === 'phofast.api.notify');
    expect(notifyLink).toBeDefined();
    expect(notifyLink!.link.raw).toBe('./index.ts');
    expect(notifyLink!.exists).toBe(false);
    expect(notifyLink!.target).toBe('file');
    expect(notifyLink!.range).toBeNull();
    expect(notifyLink!.found).toBe(false);
  });

  it('resolves phofast checkout link: lines 3-14 exists', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const checkoutLink = resolved.find(l => l.elementId === 'phofast.web.checkout');
    expect(checkoutLink).toBeDefined();
    expect(checkoutLink!.link.raw).toBe('./Checkout.tsx#L3-L14');
    expect(checkoutLink!.exists).toBe(true);
    expect(checkoutLink!.target).toBe('lines');
    expect(checkoutLink!.range).toEqual({ start: 3, end: 14 });
    expect(checkoutLink!.found).toBe(true);
  });

  it('resolves phofast menupage link: file exists', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const menupageLink = resolved.find(l => l.elementId === 'phofast.web.menupage');
    expect(menupageLink).toBeDefined();
    expect(menupageLink!.link.raw).toBe('./Menu.tsx');
    expect(menupageLink!.exists).toBe(true);
    expect(menupageLink!.target).toBe('file');
    expect(menupageLink!.range).toBeNull();
    expect(menupageLink!.found).toBe(true);
  });

  it('resolves phofast reviews link: file does not exist', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    const reviewsLink = resolved.find(l => l.elementId === 'phofast.web.reviews');
    expect(reviewsLink).toBeDefined();
    expect(reviewsLink!.link.raw).toBe('./Reviews.tsx');
    expect(reviewsLink!.exists).toBe(false);
    expect(reviewsLink!.target).toBe('file');
    expect(reviewsLink!.range).toBeNull();
    expect(reviewsLink!.found).toBe(false);
  });

  it('resolves function link to issueToken: found with range 17-19', () => {
    const link: PlanLink = {
      raw: './index.ts#issueToken',
      path: 'src/api/auth/index.ts',
      name: 'issueToken',
      lines: null,
      title: null,
    };

    const element: PlanElement = {
      id: 'phofast.api.auth.issueToken',
      kind: 'component',
      title: 'Issue Token',
      description: null,
      technology: null,
      links: [link],
      metadata: {},
      parent: null,
      source: { file: 'src/api/auth/auth.c4', line: 1 },
    };

    const plan: Plan = {
      files: [],
      elements: [element],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].target).toBe('function');
    expect(resolved[0].range).toEqual({ start: 17, end: 19 });
    expect(resolved[0].found).toBe(true);
  });

  it('resolves function link to nope: not found', () => {
    const link: PlanLink = {
      raw: './index.ts#nope',
      path: 'src/api/auth/index.ts',
      name: 'nope',
      lines: null,
      title: null,
    };

    const element: PlanElement = {
      id: 'phofast.api.auth.nope',
      kind: 'component',
      title: 'Nope',
      description: null,
      technology: null,
      links: [link],
      metadata: {},
      parent: null,
      source: { file: 'src/api/auth/auth.c4', line: 1 },
    };

    const plan: Plan = {
      files: [],
      elements: [element],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].target).toBe('function');
    expect(resolved[0].range).toBeNull();
    expect(resolved[0].found).toBe(false);
  });

  it('resolves folder link: claims all files under folder', () => {
    const link: PlanLink = {
      raw: './',
      path: 'src/api/auth/',
      name: null,
      lines: null,
      title: null,
    };

    const element: PlanElement = {
      id: 'phofast.api.auth.folder',
      kind: 'component',
      title: 'Auth Folder',
      description: null,
      technology: null,
      links: [link],
      metadata: {},
      parent: null,
      source: { file: 'src/api/auth/auth.c4', line: 1 },
    };

    const plan: Plan = {
      files: [],
      elements: [element],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].target).toBe('folder');
    expect(resolved[0].exists).toBe(true);
    expect(resolved[0].range).toBeNull();
    expect(resolved[0].found).toBe(true);
  });
});

describe('resolveLinks folder link found-ness (P6-T7: bug-report item c)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-folder-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('folder link to an empty directory: found false', () => {
    fs.mkdirSync(path.join(tmpRoot, 'empty'));

    const plan = buildSingleFolderLinkPlan('empty/');
    const resolved = resolveLinks(plan, tmpRoot, []);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].target).toBe('folder');
    expect(resolved[0].exists).toBe(true);
    expect(resolved[0].found).toBe(false);
  });

  it('folder link to a directory with only a .md file (no source extensions): found false', () => {
    const dir = path.join(tmpRoot, 'docs-only');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# docs only, no source files here\n');

    const plan = buildSingleFolderLinkPlan('docs-only/');
    const resolved = resolveLinks(plan, tmpRoot, []);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].target).toBe('folder');
    expect(resolved[0].exists).toBe(true);
    expect(resolved[0].found).toBe(false);
  });

  it('folder link to a directory with one real source file: found true (unchanged from today)', () => {
    const dir = path.join(tmpRoot, 'has-source');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n');

    const plan = buildSingleFolderLinkPlan('has-source/');
    const resolved = resolveLinks(plan, tmpRoot, [{ file: 'has-source/index.ts', lineCount: 1, parseError: false, elements: [] }]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].target).toBe('folder');
    expect(resolved[0].exists).toBe(true);
    expect(resolved[0].found).toBe(true);
  });

  it('folder link whose sources the scan skipped (ignored by config or language): found false (b162)', () => {
    const dir = path.join(tmpRoot, 'gen');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n');

    // the scan ignored gen/, so no outline lives under it
    const resolved = resolveLinks(buildSingleFolderLinkPlan('gen/'), tmpRoot, [
      { file: 'genesis/other.ts', lineCount: 1, parseError: false, elements: [] },
    ]);

    expect(resolved[0].exists).toBe(true);
    expect(resolved[0].found).toBe(false);
  });
});

describe('claimedFiles', () => {
  const fixtureRoot = path.join(__dirname, 'fixtures/phofast');

  function buildPhoFastPlan(): Plan {
    const elements: PlanElement[] = [
      {
        id: 'phofast.api.auth',
        kind: 'component',
        title: 'Auth Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts#L6-L13', path: 'src/api/auth/index.ts', name: null, lines: { start: 6, end: 13 }, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/api/auth/auth.c4', line: 1 },
      },
      {
        id: 'phofast.api.orders',
        kind: 'component',
        title: 'Order Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts#L7-L14', path: 'src/api/orders/index.ts', name: null, lines: { start: 7, end: 14 }, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/api/orders/orders.c4', line: 1 },
      },
      {
        id: 'phofast.api.menu',
        kind: 'component',
        title: 'Menu Service',
        description: null,
        technology: 'TypeScript',
        links: [{ raw: './index.ts', path: 'src/api/menu/index.ts', name: null, lines: null, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/api/menu/menu.c4', line: 1 },
      },
      {
        id: 'phofast.web.checkout',
        kind: 'component',
        title: 'Checkout',
        description: null,
        technology: 'React',
        links: [{ raw: './Checkout.tsx#L3-L14', path: 'src/web/pages/Checkout.tsx', name: null, lines: { start: 3, end: 14 }, title: null }],
        metadata: { status: 'in-progress' },
        parent: null,
        source: { file: 'src/web/pages/pages.c4', line: 1 },
      },
      {
        id: 'phofast.web.menupage',
        kind: 'component',
        title: 'Menu Page',
        description: null,
        technology: 'React',
        links: [{ raw: './Menu.tsx', path: 'src/web/pages/Menu.tsx', name: null, lines: null, title: null }],
        metadata: { status: 'done' },
        parent: null,
        source: { file: 'src/web/pages/pages.c4', line: 1 },
      },
    ];

    return {
      files: [],
      elements,
      relations: [],
      issues: [],
    };
  }

  it('claims 5 phofast source files; does not claim points.ts and Dashboard.tsx', () => {
    const plan = buildPhoFastPlan();
    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);
    const sourceFiles = snapshot.files.map(f => f.file).sort();

    const claimed = claimedFiles(resolved, sourceFiles);

    // Should have 5 claimed files
    expect(claimed.size).toBe(5);

    // Check specific claimed files
    expect(claimed.has('src/api/auth/index.ts')).toBe(true);
    expect(claimed.get('src/api/auth/index.ts')).toEqual(['phofast.api.auth']);

    expect(claimed.has('src/api/orders/index.ts')).toBe(true);
    expect(claimed.get('src/api/orders/index.ts')).toEqual(['phofast.api.orders']);

    expect(claimed.has('src/api/menu/index.ts')).toBe(true);
    expect(claimed.get('src/api/menu/index.ts')).toEqual(['phofast.api.menu']);

    expect(claimed.has('src/web/pages/Checkout.tsx')).toBe(true);
    expect(claimed.get('src/web/pages/Checkout.tsx')).toEqual(['phofast.web.checkout']);

    expect(claimed.has('src/web/pages/Menu.tsx')).toBe(true);
    expect(claimed.get('src/web/pages/Menu.tsx')).toEqual(['phofast.web.menupage']);

    // Should not claim these
    expect(claimed.has('src/api/loyalty/points.ts')).toBe(false);
    expect(claimed.has('src/web/admin/Dashboard.tsx')).toBe(false);
  });

  it('folder link claims all files under the folder', () => {
    const link: PlanLink = {
      raw: './',
      path: 'src/api/auth/',
      name: null,
      lines: null,
      title: null,
    };

    const element: PlanElement = {
      id: 'phofast.api.auth.folder',
      kind: 'component',
      title: 'Auth Folder',
      description: null,
      technology: null,
      links: [link],
      metadata: {},
      parent: null,
      source: { file: 'src/api/auth/auth.c4', line: 1 },
    };

    const plan: Plan = {
      files: [],
      elements: [element],
      relations: [],
      issues: [],
    };

    const snapshot = runSnapshot({ repo: fixtureRoot, write: false, quiet: true });
    const resolved = resolveLinks(plan, fixtureRoot, snapshot.files);
    const sourceFiles = snapshot.files.map(f => f.file).sort();

    const claimed = claimedFiles(resolved, sourceFiles);

    // Should claim only src/api/auth/index.ts from auth folder
    expect(claimed.size).toBe(1);
    expect(claimed.has('src/api/auth/index.ts')).toBe(true);
    expect(claimed.get('src/api/auth/index.ts')).toEqual(['phofast.api.auth.folder']);
  });
});

describe('nested function links (b787)', () => {
  let repo: string;
  const N_TS = 'export function outer(): number {\n  function inner(b: number): number {\n    return b * 2;\n  }\n  return inner(1);\n}\n';
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-nestlink-'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'n.ts'), N_TS);
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  const fnItem = (name: string, linkName: string, status: string): PlanElement => ({
    id: `app.${name}`,
    kind: 'function',
    title: name,
    description: null,
    technology: null,
    links: [{ raw: '../src/n.ts#' + linkName, path: 'src/n.ts', name: linkName, lines: null, title: null }],
    metadata: { status, signature: '(b: number): number' },
    parent: null,
    source: { file: 'test.c4', line: 1 },
  });
  const planOf = (elements: PlanElement[]): Plan => ({ files: [], elements, relations: [], issues: [] });
  const snapshot = () => runSnapshot({ repo, write: false, quiet: true });
  const rules = (plan: Plan, id: string) => checkPlan(plan, snapshot(), repo).filter(f => f.id === id).map(f => f.rule);

  it('outer.inner planned: found with its range, built-update-status', () => {
    const plan = planOf([fnItem('x', 'outer.inner', 'planned')]);
    expect(resolveLinks(plan, repo, snapshot().files)[0]).toMatchObject({ target: 'function', found: true, range: { start: 2, end: 4 } });
    expect(rules(plan, 'app.x')).toEqual(['planned-built-update-status']);
  });

  it('a bare inner name is not found', () => {
    const plan = planOf([fnItem('x', 'inner', 'planned')]);
    expect(resolveLinks(plan, repo, snapshot().files)[0]).toMatchObject({ found: false });
    expect(rules(plan, 'app.x')).toEqual(['planned-not-built']);
  });

  it('done: outer.inner is not broken; outer.nope is', () => {
    const ok = rules(planOf([fnItem('x', 'outer.inner', 'done')]), 'app.x');
    expect(ok).not.toContain('broken-function');
    expect(ok).not.toContain('missing-code');
    expect(rules(planOf([fnItem('y', 'outer.nope', 'done')]), 'app.y')).toContain('broken-function');
  });

  it('resolveLink answers src/n.ts#outer.inner', () => {
    expect(resolveLink(repo, {}, 'src/n.ts#outer.inner')).toMatchObject({ found: true, range: { start: 2, end: 4 } });
  });
});
