import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadQueryContext } from '../src/query/context';
import type { QueryContext } from '../src/query/context';
import { closestIds, getModel, resolveElementId } from '../src/query/elements';
import { buildViewModel } from '../src/view/model';

const FIX = path.join(__dirname, 'fixtures');
const UID = '11111111-2222-4333-8444-555555555555';

const ctxOf = (name: string): QueryContext => loadQueryContext(path.join(FIX, name));

describe('getModel', () => {
  it('is memoised per context and not shared between contexts', () => {
    const a = ctxOf('level4');
    expect(getModel(a)).toBe(getModel(a));
    expect(getModel(ctxOf('level4'))).not.toBe(getModel(a));
  });

  it("'' as summary only changes ViewModel.summary", () => {
    for (const name of ['level4', 'phofast', 'sample']) {
      const ctx = ctxOf(name);
      const plan = ctx.plan ?? undefined;
      const a = JSON.parse(JSON.stringify(getModel(ctx)));
      const b = JSON.parse(JSON.stringify(buildViewModel(ctx.snapshot, 'SOME SUMMARY', plan)));
      expect(a.summary).toBe('');
      expect(b.summary).toBe('SOME SUMMARY');
      delete a.summary;
      delete b.summary;
      expect(a).toEqual(b);
    }
  });
});

describe('resolveElementId', () => {
  it('phofast: id (claim mode id = plan fqn)', () => {
    const r = resolveElementId(ctxOf('phofast'), 'phofast.api.auth');
    expect(r.tier).toBe('id');
    expect(r.matches).toEqual([{ id: 'phofast.api.auth', title: 'Auth Service', level: 'component' }]);
  });

  it('phofast: local id', () => {
    const r = resolveElementId(ctxOf('phofast'), 'auth');
    expect(r.tier).toBe('localId');
    expect(r.matches.map((m) => m.id)).toEqual(['phofast.api.auth']);
  });

  it('phofast: title is case-insensitive', () => {
    const r = resolveElementId(ctxOf('phofast'), 'auth service');
    expect(r.tier).toBe('title');
    expect(r.matches.map((m) => m.id)).toEqual(['phofast.api.auth']);
  });

  it('phofast: ambiguous title returns every match, sorted by id', () => {
    const r = resolveElementId(ctxOf('phofast'), 'Api');
    expect(r.tier).toBe('title');
    expect(r.matches.map((m) => m.id)).toEqual(['phofast.api', 'phofast/api']);
  });

  it('sample (folder mode): id with a slash, and a container id', () => {
    const ctx = ctxOf('sample');
    expect(resolveElementId(ctx, 'api/services').matches.map((m) => m.level)).toEqual(['component']);
    expect(resolveElementId(ctx, 'worker').matches.map((m) => m.level)).toEqual(['container']);
  });

  it('level4: miss gives no matches, null tier and suggestions', () => {
    const ctx = ctxOf('level4');
    expect(resolveElementId(ctx, 'nope-zzz')).toEqual({ matches: [], tier: null });
    expect(resolveElementId(ctx, '   ')).toEqual({ matches: [], tier: null });
    expect(closestIds(ctx, 'bill').map((m) => m.id)).toContain('billing');
    expect(closestIds(ctx, 'nope-zzz', 2)).toHaveLength(2);
  });

  describe('with a uid in the plan', () => {
    let repo: string;
    beforeAll(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-qelem-'));
      fs.cpSync(path.join(FIX, 'level4'), repo, { recursive: true });
      const planFile = path.join(repo, 'c4', 'plan.c4');
      const text = fs.readFileSync(planFile, 'utf8');
      const head = "billing = component 'Billing' {";
      expect(text).toContain(head);
      fs.writeFileSync(planFile, text.replace(head, `${head}\n    metadata {\n      uid '${UID}'\n    }`));
    });
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('uid wins and the match carries the uid', () => {
      const r = resolveElementId(loadQueryContext(repo), UID);
      expect(r.tier).toBe('uid');
      expect(r.matches).toEqual([{ id: 'billing', uid: UID, title: 'Billing', level: 'component' }]);
    });
  });
});
