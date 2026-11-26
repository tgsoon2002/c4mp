import * as fs from 'fs';
import * as path from 'path';
import vm from 'vm';

// Phase 30 SV8 (b795): viewer/live.js in a small vm with a scripted C4PM_LIVE.request, a fake DOM and a queued setTimeout.

const SRC = fs.readFileSync(path.join(__dirname, '..', 'viewer', 'live.js'), 'utf8');

type Ans = { status: number; json: unknown } | 'network-error';
interface Btn { tag: string; className?: string; textContent?: string; type?: string; click?: () => void; addEventListener(ev: string, fn: () => void): void }

function run(opts: { live?: boolean; error?: string | null; isDirty?: (() => boolean) | null; answers?: Ans[] }) {
  const requests: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const events = { reload: 0, save: 0 };
  const header = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
  const kids: Btn[] = [];
  const badge = {
    _text: '', hidden: true, title: '',
    get textContent() { return this._text; },
    set textContent(v: string) { this._text = v; kids.length = 0; },
    get firstChild() { return kids[0] ?? null; },
    removeChild(c: Btn) { kids.splice(kids.indexOf(c), 1); },
    appendChild(c: Btn) { kids.push(c); return c; },
    insertBefore(c: Btn, ref: Btn | null) { kids.splice(ref ? kids.indexOf(ref) : kids.length, 0, c); return c; },
  };
  const live: Record<string, unknown> = {
    generation: 1, stamps: {}, settings: {}, error: opts.error ?? null,
    request: (_m: string, p: string) => {
      requests.push(p);
      const a = answers.shift();
      if (a === undefined) return new Promise(() => {});
      return a === 'network-error' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(a);
    },
  };
  if (opts.isDirty) live.isDirty = opts.isDirty;
  const ctx: Record<string, unknown> = {
    location: { reload: () => { events.reload++; } },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    C4PM_VIEWSTATE: { save: () => { events.save++; } },
    C4PM_BRAND: { spinner: (px: number) => ({ tag: 'spinner', px }) },   // Phase 35 C (b945): brand.js
    document: {
      getElementById: (id: string) => (id === 'header' ? header : id === 'live-badge' ? badge : null),
      createElement: (tag: string): Btn => {
        const l: Record<string, () => void> = {};
        return { tag, addEventListener: (ev, fn) => { l[ev] = fn; }, click: () => l.click() };
      },
    },
  };
  if (opts.live !== false) ctx.C4PM_LIVE = live;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  return { requests, timers, events, header, badge, kids, settle, answers };
}

const IDLE = { status: 200, json: { generation: 1, building: false, error: null } };
const LIVE_TEXT = 'Live: the map is up to date';
const NEW_DATA = 'New data. Your unsaved edits keep this page as it is. ';

describe('viewer/live.js', () => {
  it('without C4PM_LIVE: no request, no light, badge untouched', async () => {
    const r = run({ live: false });
    await r.settle();
    expect(r.requests).toEqual([]);
    expect(r.header.attrs['data-live']).toBeUndefined();
    expect(r.badge.hidden).toBe(true);
    expect(r.badge.textContent).toBe('');
  });

  it('starts live and polls since=1', async () => {
    const r = run({});
    expect(r.header.attrs['data-live']).toBe('live');
    expect(r.badge.textContent).toBe(LIVE_TEXT);
    expect(r.badge.hidden).toBe(false);
    expect(r.requests).toEqual(['api/wait?since=1']);
  });

  it('starts failed when the boot carried an error', () => {
    const r = run({ error: 'plan parse' });
    expect(r.header.attrs['data-live']).toBe('failed');
    expect(r.badge.textContent).toBe('Refresh failed: plan parse');
  });

  it('building -> updating, then idle -> live, both since=1', async () => {
    const r = run({ answers: [{ status: 200, json: { generation: 1, building: true } }, IDLE] });
    await r.settle();
    expect(r.requests).toEqual(['api/wait?since=1', 'api/wait?since=1', 'api/wait?since=1']);
    expect(r.header.attrs['data-live']).toBe('live');
  });

  it('building alone shows updating', async () => {
    const r = run({ answers: [{ status: 200, json: { generation: 1, building: true } }] });
    await r.settle();
    expect(r.header.attrs['data-live']).toBe('updating');
    expect(r.badge.textContent).toBe('Updating ...');
    // Phase 35 C (b945): the C4MP spinner (brand.js) sits in the badge in front of the text while the map rebuilds
    expect(r.kids.map((k: any) => k.tag)).toEqual(['spinner']);
  });

  it('new generation, not dirty: save once, reload once, no third request', async () => {
    const r = run({ isDirty: () => false, answers: [{ status: 200, json: { generation: 2 } }] });
    await r.settle();
    expect(r.events).toEqual({ save: 1, reload: 1 });
    expect(r.requests).toHaveLength(1);
  });

  it('new generation, dirty: held with a Reload button, polls since=2, idle keeps new, click reloads', async () => {
    const r = run({ isDirty: () => true, answers: [{ status: 200, json: { generation: 2 } }, { status: 200, json: { generation: 2, building: false } }] });
    await r.settle();
    expect(r.events.reload).toBe(0);
    expect(r.header.attrs['data-live']).toBe('new');
    expect(r.badge.textContent).toBe(NEW_DATA);
    expect(r.kids).toHaveLength(1);
    expect(r.kids[0].className).toBe('live-reload');
    expect(r.kids[0].textContent).toBe('Reload');
    expect(r.requests).toEqual(['api/wait?since=1', 'api/wait?since=2', 'api/wait?since=2']);
    r.kids[0].click!();
    expect(r.events).toEqual({ save: 1, reload: 1 });
  });

  it('error text is literal, then idle -> live', async () => {
    const r = run({ answers: [{ status: 200, json: { generation: 1, error: 'boom <b>' } }] });
    await r.settle();
    expect(r.header.attrs['data-live']).toBe('failed');
    expect(r.badge.textContent).toBe('Refresh failed: boom <b>');
    const r2 = run({ answers: [{ status: 200, json: { generation: 1, error: 'boom <b>' } }, IDLE] });
    await r2.settle();
    expect(r2.header.attrs['data-live']).toBe('live');
  });

  it('network error -> stopped, 5000 ms retry, idle -> reload (the server may have restarted)', async () => {
    const r = run({ answers: ['network-error', IDLE] });
    await r.settle();
    expect(r.header.attrs['data-live']).toBe('stopped');
    expect(r.badge.textContent).toBe('c4mp serve stopped. Retrying every 5 s; start it again with c4mp serve --repo <path>');
    expect(r.timers.map((t) => t.ms)).toEqual([5000]);
    r.timers[0].fn();
    await r.settle();
    expect(r.requests).toHaveLength(2);
    expect(r.events).toEqual({ save: 1, reload: 1 });
  });

  it('network error, dirty: back -> new data + Reload, no reload', async () => {
    const r = run({ isDirty: () => true, answers: ['network-error', IDLE, IDLE] });
    await r.settle();
    r.timers[0].fn();
    await r.settle();
    expect(r.events.reload).toBe(0);
    expect(r.header.attrs['data-live']).toBe('new');
    expect(r.kids).toHaveLength(1);
    expect(r.kids[0].className).toBe('live-reload');
    expect(r.requests).toHaveLength(4);
    expect(r.requests[3]).toBe('api/wait?since=1');
  });

  it('401 -> stopped + restarted text, no timer, no more requests', async () => {
    const r = run({ answers: [{ status: 401, json: null }] });
    await r.settle();
    expect(r.header.attrs['data-live']).toBe('stopped');
    expect(r.badge.textContent).toBe('c4mp serve was restarted. Open the link it printed.');
    expect(r.timers).toHaveLength(0);
    expect(r.requests).toHaveLength(1);
  });

  it('500 -> failed + 5000 ms retry', async () => {
    const r = run({ answers: [{ status: 500, json: null }] });
    await r.settle();
    expect(r.header.attrs['data-live']).toBe('failed');
    expect(r.badge.textContent).toBe('c4mp serve answered 500. Retrying.');
    expect(r.timers.map((t) => t.ms)).toEqual([5000]);
  });

  it('LIVE without isDirty: a new generation reloads', async () => {
    const r = run({ answers: [{ status: 200, json: { generation: 2 } }] });
    await r.settle();
    expect(r.events.reload).toBe(1);
  });

  it('the file holds no http(s) URL and no closing script tag', () => {
    expect(SRC).not.toMatch(/https?:\/\//);
    expect(SRC).not.toMatch(/<\/script/i);
  });
});
