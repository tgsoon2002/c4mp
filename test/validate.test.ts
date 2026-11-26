import { validateMetadata, INVALID_META_HEADS } from '../src/c4/validate';
import type { PlanElement } from '../src/types';

describe('validateMetadata', () => {
  const baseElement = (overrides?: Partial<PlanElement>): PlanElement => ({
    id: 'test.element',
    kind: 'component',
    title: 'Test Element',
    description: null,
    technology: null,
    links: [],
    metadata: {},
    parent: null,
    source: { file: 'test.c4', line: 1 },
    ...overrides,
  });

  it('should return no findings for an element without metadata', () => {
    const element = baseElement({ metadata: {} });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(0);
  });

  it('should return no findings for a fully valid element', () => {
    const element = baseElement({
      metadata: {
        status: 'done',
        owner: 'kien',
        sprint: 'S15',
        priority: 'high',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(0);
  });

  it('should flag invalid status', () => {
    const element = baseElement({
      title: 'MyComponent',
      metadata: {
        status: 'invalid-status',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      severity: 'warning',
      rule: 'invalid-metadata',
      id: 'test.element',
      message: "MyComponent: unknown status 'invalid-status' (use planned, in-progress, done, abandoned)",
    });
  });

  it('should flag invalid priority', () => {
    const element = baseElement({
      title: 'MyComponent',
      metadata: {
        priority: 'urgent',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      severity: 'warning',
      rule: 'invalid-metadata',
      id: 'test.element',
      message: "MyComponent: unknown priority 'urgent' (use high, medium, low)",
    });
  });

  it('should flag invalid sprint format', () => {
    const element = baseElement({
      title: 'MyComponent',
      metadata: {
        sprint: 's15',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      severity: 'warning',
      rule: 'invalid-metadata',
      id: 'test.element',
      message: "MyComponent: sprint 's15' should look like S15",
    });
  });

  it('should flag done status without owner', () => {
    const element = baseElement({
      title: 'MyComponent',
      metadata: {
        status: 'done',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      severity: 'warning',
      rule: 'invalid-metadata',
      id: 'test.element',
      message: 'MyComponent: done but has no owner',
    });
  });

  it('should flag done status with empty owner', () => {
    const element = baseElement({
      title: 'MyComponent',
      metadata: {
        status: 'done',
        owner: '   ',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      severity: 'warning',
      rule: 'invalid-metadata',
      id: 'test.element',
      message: 'MyComponent: done but has no owner',
    });
  });

  it('should accept done status with owner', () => {
    const element = baseElement({
      metadata: {
        status: 'done',
        owner: 'kien',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(0);
  });

  it('should report multiple findings for an element, ordered by rule', () => {
    const element = baseElement({
      title: 'MyComponent',
      metadata: {
        status: 'invalid',
        priority: 'urgent',
        sprint: 'bad',
      },
    });
    const findings = validateMetadata([element]);
    expect(findings).toHaveLength(3);
    // Order: status, priority, sprint
    expect(findings[0].message).toContain("unknown status 'invalid'");
    expect(findings[1].message).toContain("unknown priority 'urgent'");
    expect(findings[2].message).toContain("sprint 'bad'");
  });

  it('should preserve element order in findings', () => {
    const elem1 = baseElement({
      id: 'first',
      title: 'First',
      metadata: { status: 'bad1' },
    });
    const elem2 = baseElement({
      id: 'second',
      title: 'Second',
      metadata: { priority: 'bad2' },
    });
    const findings = validateMetadata([elem1, elem2]);
    expect(findings).toHaveLength(2);
    expect(findings[0].id).toBe('first');
    expect(findings[1].id).toBe('second');
  });

  it('should validate PhoFast COMPS metadata with no findings', () => {
    // Build the 8 PhoFast components from the fixture
    const phofastComps: PlanElement[] = [
      {
        id: 'phofast.api.auth',
        kind: 'component',
        title: 'Auth Service',
        description: 'Handles login tokens',
        technology: 'JWT / Passport.js',
        links: [{ raw: './index.ts#L6-L13', path: 'src/api/auth/index.ts', name: null, lines: { start: 6, end: 13 }, title: 'Token verify logic' }],
        metadata: { status: 'done', owner: 'kien', sprint: 'S14', priority: 'high' },
        parent: 'phofast.api',
        source: { file: 'src/api/auth/auth.c4', line: 4 },
      },
      {
        id: 'phofast.api.orders',
        kind: 'component',
        title: 'Order Service',
        description: 'Creates and tracks food orders',
        technology: 'Node / Express',
        links: [{ raw: './index.ts#L7-L14', path: 'src/api/orders/index.ts', name: null, lines: { start: 7, end: 14 }, title: 'Order routes' }],
        metadata: { status: 'in-progress', owner: 'jay', sprint: 'S15', priority: 'high' },
        parent: 'phofast.api',
        source: { file: 'src/api/orders/orders.c4', line: 4 },
      },
      {
        id: 'phofast.api.payments',
        kind: 'component',
        title: 'Payment Service',
        description: 'Charges the customer via Stripe',
        technology: 'Stripe SDK',
        links: [{ raw: './stripe.ts', path: 'src/api/payments/stripe.ts', name: null, lines: null, title: 'Entrypoint' }],
        metadata: { status: 'done', owner: 'kien', sprint: 'S14', priority: 'high' },
        parent: 'phofast.api',
        source: { file: 'src/api/payments/payments.c4', line: 4 },
      },
      {
        id: 'phofast.api.menu',
        kind: 'component',
        title: 'Menu Service',
        description: 'Serves the menu and prices',
        technology: 'Node / Express',
        links: [{ raw: './index.ts', path: 'src/api/menu/index.ts', name: null, lines: null, title: 'Entrypoint' }],
        metadata: { status: 'done', owner: 'kien', sprint: 'S13', priority: 'medium' },
        parent: 'phofast.api',
        source: { file: 'src/api/menu/menu.c4', line: 4 },
      },
      {
        id: 'phofast.api.notify',
        kind: 'component',
        title: 'Notification Service',
        description: 'Texts the customer when food is ready',
        technology: 'Twilio SMS',
        links: [{ raw: './index.ts', path: 'src/api/notify/index.ts', name: null, lines: null, title: 'Entrypoint' }],
        metadata: { status: 'planned', owner: 'jay', sprint: 'S14', priority: 'medium' },
        parent: 'phofast.api',
        source: { file: 'src/api/notify/notify.c4', line: 4 },
      },
      {
        id: 'phofast.web.checkout',
        kind: 'component',
        title: 'Checkout Page',
        description: 'Cart review and pay button',
        technology: 'React',
        links: [{ raw: './Checkout.tsx#L3-L14', path: 'src/web/pages/Checkout.tsx', name: null, lines: { start: 3, end: 14 }, title: 'Checkout component' }],
        metadata: { status: 'in-progress', owner: 'jay', sprint: 'S15', priority: 'high' },
        parent: 'phofast.web',
        source: { file: 'src/web/pages/pages.c4', line: 4 },
      },
      {
        id: 'phofast.web.menupage',
        kind: 'component',
        title: 'Menu Page',
        description: 'Lists dishes from the Menu Service',
        technology: 'React',
        links: [{ raw: './Menu.tsx', path: 'src/web/pages/Menu.tsx', name: null, lines: null, title: 'Entrypoint' }],
        metadata: { status: 'done', owner: 'kien', sprint: 'S13', priority: 'medium' },
        parent: 'phofast.web',
        source: { file: 'src/web/pages/pages.c4', line: 16 },
      },
      {
        id: 'phofast.web.reviews',
        kind: 'component',
        title: 'Reviews Widget',
        description: 'Star ratings per dish',
        technology: 'React',
        links: [{ raw: './Reviews.tsx', path: 'src/web/pages/Reviews.tsx', name: null, lines: null, title: 'Entrypoint' }],
        metadata: { status: 'abandoned', owner: 'kien', sprint: 'S12', priority: 'low' },
        parent: 'phofast.web',
        source: { file: 'src/web/pages/pages.c4', line: 28 },
      },
    ];

    const findings = validateMetadata(phofastComps);
    expect(findings).toHaveLength(0);
  });

  describe('uid rules (P14-T9)', () => {
    const counter = () => { let n = 0; return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'); };
    const UID_A = counter()();

    it('duplicate uid in two elements gives one duplicate-uid warning naming both fqns and file:line', () => {
      const b = baseElement({ id: 'b.comp', metadata: { uid: UID_A }, source: { file: 'x.c4', line: 9 } });
      const a = baseElement({ id: 'a.comp', metadata: { uid: UID_A }, source: { file: 'x.c4', line: 3 } });
      const findings = validateMetadata([b, a]);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        severity: 'warning',
        rule: 'duplicate-uid',
        id: 'a.comp',
        message: `uid ${UID_A} is used by a.comp (x.c4:3), b.comp (x.c4:9)`,
      });
    });

    it('duplicate uid across two source files is found', () => {
      const a = baseElement({ id: 'a.comp', metadata: { uid: UID_A }, source: { file: 'one.c4', line: 2 } });
      const b = baseElement({ id: 'b.comp', metadata: { uid: UID_A }, source: { file: 'two.c4', line: 7 } });
      const findings = validateMetadata([a, b]);
      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('duplicate-uid');
      expect(findings[0].message).toContain('one.c4:2');
      expect(findings[0].message).toContain('two.c4:7');
    });

    it('three elements with one uid give one finding naming all three', () => {
      const els = ['c', 'a', 'b'].map((n, i) =>
        baseElement({ id: `${n}.comp`, metadata: { uid: UID_A }, source: { file: 'x.c4', line: i + 1 } }),
      );
      const findings = validateMetadata(els);
      expect(findings).toHaveLength(1);
      expect(findings[0].id).toBe('a.comp');
      for (const n of ['a', 'b', 'c']) expect(findings[0].message).toContain(`${n}.comp`);
    });

    it('malformed uid gives invalid-metadata', () => {
      const findings = validateMetadata([baseElement({ title: 'Bad', metadata: { uid: 'not-a-uuid' } })]);
      expect(findings).toEqual([
        { severity: 'warning', rule: 'invalid-metadata', id: 'test.element', message: "Bad: uid 'not-a-uuid' is not a UUID" },
      ]);
    });

    it('elements without uid give no uid finding', () => {
      const els = [
        baseElement({ id: 'a.comp', metadata: { status: 'planned' } }),
        baseElement({ id: 'b.comp', metadata: { status: 'planned' } }),
        baseElement({ id: 'c.comp', metadata: {} }),
      ];
      expect(validateMetadata(els)).toHaveLength(0);
    });
  });

  describe('tags (P16-B11)', () => {
    it('valid tags and a missing tags key give no finding', () => {
      expect(validateMetadata([baseElement({ metadata: { tags: 'billing, api-v2' } })])).toHaveLength(0);
      expect(validateMetadata([baseElement({ metadata: { status: 'planned' } })])).toHaveLength(0);
    });

    it('one warning per bad entry, case as written', () => {
      const findings = validateMetadata([baseElement({ title: 'T', metadata: { tags: 'ok, Billing, a b' } })]);
      expect(findings).toEqual([
        { severity: 'warning', rule: 'invalid-metadata', id: 'test.element', message: "T: tag 'Billing' should be lower-case letters, digits and dashes" },
        { severity: 'warning', rule: 'invalid-metadata', id: 'test.element', message: "T: tag 'a b' should be lower-case letters, digits and dashes" },
      ]);
    });
  });

  describe('subregion-misplaced (Phase 28; b456: was layer-misplaced)', () => {
    const el = (id: string, kind: string, parent: string | null, links: PlanElement['links'] = []) => baseElement({ id, kind, parent, links, title: id });
    const link = { raw: 'src/a.ts', path: 'src/a.ts', name: null, lines: null, title: null };   // metadata is empty in every case: the rule runs before the no-metadata skip
    const rules = (els: PlanElement[]) => validateMetadata(els).filter((f) => f.rule === 'subregion-misplaced').map((f) => f.id);

    it.each([
      ['directly in a container', [el('s', 'system', null), el('s.c', 'container', 's'), el('s.c.l', 'subregion', 's.c')], []],
      ['under a system', [el('s', 'system', null), el('s.l', 'subregion', 's')], ['s.l']],
      ['at the top level', [el('l', 'subregion', null)], ['l']],
      ['inside a subregion', [el('s.c', 'container', null), el('s.c.a', 'subregion', 's.c'), el('s.c.a.b', 'subregion', 's.c.a')], ['s.c.a.b']],
      ['with a link', [el('s.c', 'container', null), el('s.c.l', 'subregion', 's.c', [link])], ['s.c.l']],
      ['holding a component', [el('s.c', 'container', null), el('s.c.l', 'subregion', 's.c'), el('s.c.l.x', 'component', 's.c.l')], []],
    ])('subregion %s', (_name, els, expected) => {
      expect(rules(els as PlanElement[])).toEqual(expected);
    });
  });

  describe('shared (b454): only on a subregion, only true', () => {
    it.each([
      ['subregion', 'true', []],
      ['subregion', 'yes', ["L: shared 'yes' should be 'true'"]],
      ['subregion', 'TRUE', ["L: shared 'TRUE' should be 'true'"]],
      ['component', 'true', ['L: shared is only for a subregion, not a component']],
      ['container', 'false', ['L: shared is only for a subregion, not a container']],
    ])('on a %s with shared %p', (kind, shared, messages) => {
      const findings = validateMetadata([baseElement({ kind, title: 'L', metadata: { shared } })]).filter((f) => f.rule === 'invalid-metadata');   // a subregion at the top level is also subregion-misplaced
      expect(findings).toEqual(messages.map((message) => ({ severity: 'warning', rule: 'invalid-metadata', id: 'test.element', message })));
    });
  });

  describe('viewport (b304, H9): <W>x<H>, whole numbers 10 to 99999', () => {
    const invalid = (metadata: Record<string, string>) =>
      validateMetadata([baseElement({ kind: 'screen', title: 'S', metadata })]).filter((f) => f.rule === 'invalid-metadata');

    it.each(['abc', '00x00', '9x800', '100000x800', '1280x'])('%p gives one invalid-metadata', (viewport) => {
      expect(invalid({ viewport })).toEqual([{
        severity: 'warning', rule: 'invalid-metadata', id: 'test.element',
        message: `S: viewport '${viewport}' should be <W>x<H>, whole numbers 10 to 99999`,
      }]);
    });

    it.each(['1280x800', ' 1440x900 '])('%p gives none', (viewport) => {
      expect(invalid({ viewport })).toEqual([]);
    });

    it('no viewport gives none', () => {
      expect(invalid({ owner: 'K' })).toEqual([]);
    });
  });

  describe('shape (C1 C2, b834): only on a person, only person or robot', () => {
    it.each([
      ['person', 'robot', []],
      ['person', 'person', []],
      ['person', 'android', ["P: shape 'android' should be person or robot"]],
      ['external', 'robot', ['P: shape is only for a person, not a external']],
      ['container', 'person', ['P: shape is only for a person, not a container']],
    ])('on a %s with shape %p', (kind, shape, messages) => {
      const findings = validateMetadata([baseElement({ kind, title: 'P', metadata: { shape } })]).filter((f) => f.rule === 'invalid-metadata');
      expect(findings).toEqual(messages.map((message) => ({ severity: 'warning', rule: 'invalid-metadata', id: 'test.element', message })));
    });
  });

  describe('role (b908): only on a component, only foundation', () => {
    it.each([
      ['component', 'foundation', []],
      ['component', 'base', ["P: role 'base' should be foundation"]],
      ['container', 'foundation', ['P: role is only for a component, not a container']],
      ['subregion', 'foundation', ['P: role is only for a component, not a subregion']],
    ])('on a %s with role %p', (kind, role, messages) => {
      const findings = validateMetadata([baseElement({ kind, title: 'P', metadata: { role } })]).filter((f) => f.rule === 'invalid-metadata');
      expect(findings).toEqual(messages.map((message) => ({ severity: 'warning', rule: 'invalid-metadata', id: 'test.element', message })));
    });
  });

  describe('INVALID_META_HEADS (b304, S9)', () => {
    it('every invalid-metadata message starts with "<title>: " + one head, and every head is used', () => {
      // one element per rule, in the order of the heads (the subregion is also subregion-misplaced at the top level, filtered out)
      const metas: Record<string, string>[] = [
        { status: 'bogus' }, { priority: 'urgent' }, { sprint: 'x' }, { status: 'done' }, { uid: 'nope' },
        { tags: 'Billing' }, { shared: 'true' }, { shared: 'yes' }, { viewport: '00x00' }, { shape: 'robot' }, { shape: 'android' },
        { role: 'foundation' }, { role: 'base' },
      ];
      const els = metas.map((metadata, i) => baseElement({ id: `e${i}`, kind: i === 7 ? 'subregion' : i === 10 ? 'person' : i === 11 ? 'container' : 'component', title: `T${i}`, metadata }));
      const messages = validateMetadata(els).filter((f) => f.rule === 'invalid-metadata').map((f) => {
        const title = els.find((e) => e.id === f.id)!.title;
        expect(f.message.startsWith(`${title}: `)).toBe(true);
        return f.message.slice(title.length + 2);
      });
      expect(messages).toHaveLength(els.length);
      const headOf = (rest: string) => INVALID_META_HEADS.filter((h) => rest.startsWith(h));
      expect(messages.map(headOf)).toEqual(INVALID_META_HEADS.map((h) => [h]));
    });
  });
});
