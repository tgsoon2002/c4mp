import { lookupElement, pickOne, closestItems, LookupItem } from '../src/util/lookup';

const UID_A = '00000000-0000-4000-8000-000000000001';
const UID_B = '00000000-0000-4000-8000-000000000002';

describe('lookupElement', () => {
  const cases: {
    name: string;
    query: string;
    items: LookupItem[];
    opts?: { all?: boolean };
    ids: string[];
    tier: string | null;
  }[] = [
    {
      name: 'uid exact wins even when another item has that text as title',
      query: UID_B,
      items: [
        { uid: UID_A, id: 'web', title: 'Web', level: 'container' },
        { uid: UID_B, id: 'api', title: UID_B, level: 'container' },
      ],
      ids: ['api'],
      tier: 'uid',
    },
    {
      name: 'id exact',
      query: 'app.web',
      items: [
        { id: 'app.web', title: 'Web', level: 'component' },
        { id: 'web', title: 'Other', level: 'component' },
      ],
      ids: ['app.web'],
      tier: 'id',
    },
    {
      name: 'fqn exact',
      query: 'shop.app.web',
      items: [{ id: 'web', fqn: 'shop.app.web', title: 'Web', level: 'component' }],
      ids: ['web'],
      tier: 'fqn',
    },
    {
      name: 'localId collision gives two matches',
      query: 'web',
      items: [
        { id: 'a.web', fqn: 'a.web', title: 'A', level: 'component' },
        { id: 'b.web', fqn: 'b.web', title: 'B', level: 'component' },
      ],
      ids: ['a.web', 'b.web'],
      tier: 'localId',
    },
    {
      name: 'title is case-insensitive',
      query: 'auth',
      items: [{ id: 'login', title: 'Auth', level: 'component' }],
      ids: ['login'],
      tier: 'title',
    },
    {
      name: 'no match gives empty result',
      query: 'nothing-here',
      items: [{ id: 'web', title: 'Web', level: 'component' }],
      ids: [],
      tier: null,
    },
    {
      name: 'blank query gives empty result',
      query: '   ',
      items: [{ id: 'web', title: 'Web', level: 'component' }],
      ids: [],
      tier: null,
    },
    {
      name: 'default returns only the first tier (id), not the title hit',
      query: 'web',
      items: [
        { id: 'web', title: 'Web', level: 'component' },
        { id: 'app.web', title: 'Web', level: 'component' },
      ],
      ids: ['web'],
      tier: 'id',
    },
    {
      name: 'all: true returns the union of tiers 2-5',
      query: 'web',
      items: [
        { id: 'web', title: 'Web', level: 'component' },
        { id: 'app.web', title: 'Web', level: 'component' },
      ],
      opts: { all: true },
      ids: ['app.web', 'web'],
      tier: 'id',
    },
    {
      name: 'all: true still returns only the uid match',
      query: UID_A,
      items: [
        { uid: UID_A, id: 'web', title: 'Web', level: 'component' },
        { id: 'other', title: UID_A, level: 'component' },
      ],
      opts: { all: true },
      ids: ['web'],
      tier: 'uid',
    },
  ];

  it.each(cases)('$name', ({ query, items, opts, ids, tier }) => {
    const result = lookupElement(query, items, opts);
    expect(result.matches.map((m) => m.id)).toEqual(ids);
    expect(result.tier).toBe(tier);
  });
});

describe('pickOne', () => {
  const item: LookupItem = { id: 'web', title: 'Web', level: 'component' };
  const other: LookupItem = { id: 'app.web', title: 'Web', level: 'component' };

  it('0 matches gives none', () => {
    const r = pickOne({ matches: [], tier: null });
    expect(r).toEqual({ ok: false, reason: 'none', matches: [] });
  });

  it('2 matches gives ambiguous with the candidates', () => {
    const r = pickOne({ matches: [item, other], tier: 'title' });
    expect(r).toEqual({ ok: false, reason: 'ambiguous', matches: [item, other] });
  });

  it('1 match is ok', () => {
    expect(pickOne({ matches: [item], tier: 'id' })).toEqual({ ok: true, item });
  });
});

describe('closestItems', () => {
  const items: LookupItem[] = [
    { id: 'zeta', title: 'Zeta', level: 'component' },
    { id: 'services', title: 'Services', level: 'component' },
    { id: 'web-service', title: 'Web', level: 'component' },
    { id: 'serv-api', title: 'Api', level: 'component' },
    { id: 'alpha', title: 'Alpha', level: 'component' },
    { id: 'beta', title: 'Beta', level: 'component' },
    { id: 'gamma', title: 'Gamma', level: 'component' },
  ];

  it('returns at most 5, substring hits first, deterministic', () => {
    const first = closestItems('serv', items).map((i) => i.id);
    const second = closestItems('serv', items).map((i) => i.id);
    expect(first).toHaveLength(5);
    expect(first.slice(0, 3)).toEqual(['serv-api', 'services', 'web-service']);
    expect(second).toEqual(first);
  });

  it('respects a custom n', () => {
    expect(closestItems('serv', items, 2)).toHaveLength(2);
  });
});
