// b207: `real-repo-check.js --write --only X` updates only X's baseline entry and keeps the other repos.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const check = require('../scripts/real-repo-check.js') as {
  nextBaseline(previous: { repos: Record<string, unknown> } | null, fresh: { repos: Record<string, unknown> }, only: string[] | null): { repos: Record<string, unknown> };
};

describe('scripts/real-repo-check.js nextBaseline', () => {
  const previous = { repos: { fd: { elements: 1 }, fmt: { elements: 2 }, hono: { elements: 3 } } };

  it('with --only, replaces only the named entries and keeps the others in their order', () => {
    const next = check.nextBaseline(previous, { repos: { fmt: { elements: 20 } } }, ['fmt']);
    expect(next).toEqual({ repos: { fd: { elements: 1 }, fmt: { elements: 20 }, hono: { elements: 3 } } });
    expect(Object.keys(next.repos)).toEqual(['fd', 'fmt', 'hono']);
  });

  it('without --only, or with no previous baseline, is the fresh run', () => {
    const fresh = { repos: { fd: { elements: 10 } } };
    expect(check.nextBaseline(previous, fresh, null)).toEqual(fresh);
    expect(check.nextBaseline(null, fresh, ['fd'])).toEqual(fresh);
  });
});
