import { readFileSync } from 'fs';
import { join } from 'path';
import { renderViewHtml } from '../src/page/html';
import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { storageModel } from './helpers/storage-view';
import { simHtml, simModel } from './helpers/sim-view';
import { makeBus } from './helpers/link-bus';

// Phase 25 UI12 (b762): viewer/sim-present.js, present mode (C4PM_SIM.hooks present / presentGo / presentEnd / presenting /
// presentKey). The page is simHtml() (test/helpers/sim-view.ts): flow s-1 (7 steps: io, io, arch, arch (unverified), storage
// with rows, arch with changed rows, io with durationSec 6) and journey s-2 (outside, s-1 inline, outside: 9 steps, 3 stages).

const IDS = ['pres', 'simbar', 'view-toast', 'btn-gear', 'settings-pop'];
type Timer = { id: number; fn: () => void; ms: number };
// Own fake timers (the harness ones drop the delay): the page's setTimeout calls queue here with their ms.
function load(opts: { html?: string; globals?: Record<string, unknown> } = {}) {
  const timers: Timer[] = [];
  let seq = 0;
  const globals = {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ id: ++seq, fn, ms }); return seq; },
    clearTimeout: (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...(opts.globals || {}),
  };
  const h = runViewerScripts(opts.html ?? simHtml(), { extraIds: IDS, globals });
  const flush = () => { const run = timers.splice(0); run.forEach((t) => t.fn()); };
  return { h, timers, flush };
}
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const doc = (h: HarnessResult) => h.sandbox.document as any;
const byId = (h: HarnessResult, id: string) => doc(h).getElementById(id) as FakeEl & { hidden?: boolean };
const pres = (h: HarnessResult) => byId(h, 'pres');
const q = (h: HarnessResult, sel: string) => pres(h).querySelector(sel)!;
const qa = (h: HarnessResult, sel: string) => pres(h).querySelectorAll(sel);
const text = (e: FakeEl) => serializeText(e).replace(/\s+/g, ' ').trim();
const texts = (h: HarnessResult, sel: string) => qa(h, sel).map(text);
const button = (h: HarnessResult, start: string) => qa(h, '.tbb').find((b) => b.textContent.startsWith(start)) as FakeEl & { disabled?: boolean };
const topLine = (h: HarnessResult) => q(h, '.pres-card').children[0].children.map(text);   // "Step n/N", stage, chips
const presenting = (h: HarnessResult) => byId(h, 'root').classList.contains('presenting');
function key(h: HarnessResult, k: string) {
  const e = { key: k, target: { tagName: 'DIV' }, prevented: 0, stopped: 0, preventDefault() { e.prevented++; }, stopPropagation() { e.stopped++; } };
  doc(h).dispatch('keydown', e);
  return e;
}
// Records C4PM_CAM.fitCamIn arguments and flyTo targets (read at call time).
function spyCam(h: HarnessResult) {
  const CAM = win(h).C4PM_CAM;
  const fit = CAM.fitCamIn;
  const log = { fits: [] as any[][], flies: [] as any[] };
  CAM.fitCamIn = (...a: any[]) => { log.fits.push(a); return fit(...a); };
  CAM.flyTo = (t: any) => { log.flies.push(t); };
  return log;
}

describe('a page without s-items', () => {
  it('sim-present.js does nothing (no C4PM_SIM, #pres untouched)', () => {
    const { h } = load({ html: renderViewHtml(storageModel()) });
    expect(SIM(h)).toBeUndefined();
    expect(pres(h).hidden).toBeUndefined();
  });
});

describe('start', () => {
  it('▶ (act present) at the cursor: #root.presenting, #pres shown, the strip hidden, the c-item cleared; the head pill', () => {
    const { h } = load();
    const S = SIM(h);
    S.select('s-1');
    S.go(2);
    win(h).C4PM_MAP.select('api/routes');
    S.act('present');
    expect([presenting(h), pres(h).hidden, S.hooks.presenting(), byId(h, 'simbar').hidden]).toEqual([true, false, true, true]);
    expect(win(h).C4PM_MAP.selectedId()).toBeNull();
    expect(S.step()).toBe(2);
    const head = q(h, '.pres-head');
    expect(head.children.map((c) => c.className)).toEqual(['sim-ico', '', 'pres-n', 'vchip arch']);
    expect(head.children[0].innerHTML).toBe(S.icon('flow'));
    expect(head.children.slice(1).map(text)).toEqual(['s-1 · Place an order', '3/7', 'Architecture view']);
  });

  it('the list ▶ (hooks.present(id, 0)) starts at step 1 and selects the s-item', () => {
    const { h } = load();
    SIM(h).hooks.present('s-2', 0);
    expect([SIM(h).selected(), SIM(h).step(), presenting(h)]).toEqual(['s-2', 0, true]);
    SIM(h).hooks.present('s-9', 0);   // an unknown id: nothing changes
    expect(SIM(h).selected()).toBe('s-2');
  });
});

describe('the caption card', () => {
  it('per step: Step n/N, view chip, target line with the call, caption, state, rows tables, the keys line', () => {
    const { h } = load();
    const S = SIM(h);
    S.hooks.present('s-1', 3);
    const st = S.steps()[3];
    expect(topLine(h)).toEqual(['Step 4/7', 'Architecture view', '? unverified']);
    expect(q(h, '.pres-target').textContent).toBe(S.stepTarget(st) + '   ·   ' + S.nameOfId(st.call.from, S.byId('s-1')) + ' → ' + S.nameOfId(st.call.to, S.byId('s-1')) + ' (create(order))');
    expect(text(q(h, '.pres-unver'))).toBe('Unverified (sim-step-unverified, info): no call found from Routes to OrderService.create. Drawn dashed on the map and in the sequence.');
    expect(qa(h, '.pres-rows')).toEqual([]);   // no rows known yet at step 4
    S.hooks.presentGo(0);
    expect(texts(h, '.pres-state')).toEqual(['state: signed out']);
    expect(q(h, '.pres-state').children[0].textContent).toBe('signed out');
    expect(text(q(h, '.pres-keys'))).toBe('← → step · Space play / pause · F full screen · Esc exit · 4 s per step when playing');
    S.hooks.presentGo(4);
    expect(qa(h, '.pres-cap')).toEqual([]);   // no caption on step 5
    const rows = () => q(h, '.pres-rows').innerHTML;   // built (escaped) by C4PM_SIM.rowsTableHtml
    expect(rows()).toBe(S.rowsTableHtml(S.tableStateAt('s-1', 4)));
    expect(rows().match(/<table>/g)!.length).toBe(1);
    expect(rows()).toContain('<tr class="ins">');   // the first rows are new
    S.hooks.presentGo(5);
    expect(rows()).toContain('<td class="chg"><s>10</s> → 9</td>');
    S.hooks.presentGo(6);
    expect(text(q(h, '.pres-keys'))).toMatch(/· 6 s per step when playing$/);
    expect(rows()).toMatch(/<caption>[^<]* · unchanged<\/caption>/);   // as after step 6
    S.hooks.presentGo(2);
    expect(text(q(h, '.pres-cap'))).toBe('POST /orders');
  });

  it('the dots (done / cur / out / sep) and buttons; Back off on step 1, Next off on the last; a dot goes there', () => {
    const { h } = load();
    const S = SIM(h);
    S.hooks.present('s-2', 1);
    const dots = qa(h, '.pres-dot');
    expect(dots.length).toBe(9);
    expect(dots.map((d) => d.className.replace('pres-dot', '').trim())).toEqual(['done out', 'cur sep', '', '', '', '', '', '', 'out sep']);
    expect(qa(h, '.tbb').map((b) => b.textContent)).toEqual(['‹ Back', '▶ Play', 'Next ›', '⛶ Full screen', '⧉ Two windows', 'Exit ✕']);
    dots[8].click();
    expect(S.step()).toBe(8);
    expect([button(h, '‹').disabled, button(h, 'Next').disabled]).toEqual([false, true]);
    S.hooks.presentGo(0);
    expect([button(h, '‹').disabled, button(h, 'Next').disabled]).toEqual([true, false]);
    button(h, 'Next').click();
    expect(S.step()).toBe(1);
  });

  it('journey: the stage line; an outside step: #pres.outside, channel icon, from / to line, goal, no fly', () => {
    const { h } = load();
    const S = SIM(h);
    const cam = spyCam(h);
    S.hooks.present('s-2', 0);
    expect(pres(h).classList.contains('outside')).toBe(true);
    expect(topLine(h)).toEqual(['Step 1/9', 'Stage 1 · Discover', 'outside the system · email']);
    const chip = q(h, '.pres-head').children[3];
    expect([chip.className, text(chip)]).toEqual(['vchip out', 'outside the system']);
    expect(text(q(h, '.pres-ico'))).toBe('✉');
    expect(text(q(h, '.pres-target'))).toBe('Reads the newsletter');
    expect(texts(h, '.pres-state')[0]).toBe('from Newsletter tool to Customer · not drawn in any view');
    expect([cam.fits, cam.flies]).toEqual([[], []]);
    S.hooks.presentGo(1);
    expect(pres(h).classList.contains('outside')).toBe(false);
    expect(topLine(h).slice(0, 2)).toEqual(['Step 2/9', 'Stage 2 · Buy · flow s-1 step 1']);
    expect(texts(h, '.pres-state')).toContain('goal: Place the order');
    S.hooks.presentGo(8);
    expect(texts(h, '.pres-state')[0]).toBe('to Customer · not drawn in any view');   // no sender
  });

  // UI17-5 (b851): ⧉ opens the second window through C4PM_OPEN (viewer/openView.js), or says why it cannot.
  it('⧉ Two windows: no window link -> the link note; with the link it opens the IO window (present started in arch); link off -> the note', () => {
    const LINK_NOTE = 'Two windows need the window link (gear: Window link On).';
    const note = (h: HarnessResult) => q(h, '.pn-note') as FakeEl & { hidden?: boolean };
    const { h } = load();   // no BroadcastChannel: the link is not available
    SIM(h).hooks.present('s-1', 2);
    expect(note(h).hidden).toBe(true);
    button(h, '⧉').click();
    expect([note(h).hidden, text(note(h)), SIM(h).step(), presenting(h)]).toEqual([false, LINK_NOTE, 2, true]);

    const calls: unknown[][] = [];
    const { BroadcastChannel } = makeBus();
    const two = load({ globals: {
      BroadcastChannel, location: { href: 'file:///x.html#arch', hash: '#arch' },
      open: (...a: unknown[]) => { calls.push(a); return { focus() {} }; },
    } });
    SIM(two.h).hooks.present('s-1', 2);   // arch: no view switch
    button(two.h, '⧉').click();
    expect(calls).toEqual([['file:///x.html#io&bare', 'c4pm-io', 'popup,width=1280,height=800']]);
    expect([note(two.h).hidden, text(note(two.h)), presenting(two.h)]).toEqual([false, expect.stringMatching(/^Two windows: /), true]);
    win(two.h).C4PM_SETTINGS.set('link', 'off');
    button(two.h, '⧉').click();
    expect([calls.length, text(note(two.h))]).toEqual([1, LINK_NOTE]);
  });
});

describe('the camera', () => {
  it('a step of this view flies at once: fitCamIn(stepRect, 0.85, 50, card height + 34)', () => {
    const { h } = load();
    const S = SIM(h);
    S.select('s-1');
    const cam = spyCam(h);
    S.hooks.present('s-1', 2);
    expect(win(h).C4PM_MODE.get()).toBe('arch');
    expect(cam.fits).toEqual([[win(h).C4PM_SIMSTRIP.stepRect(S.steps()[2]), 0.85, 50, 34]]);
    expect(cam.flies.length).toBe(1);
  });

  it('a step of another view switches the view (hash), then flies after the switch', () => {
    const loc = { href: 'file:///x.html#arch', hash: '#arch' };
    const { h } = load({ globals: { location: loc } });
    const S = SIM(h);
    const cam = spyCam(h);
    S.hooks.present('s-1', 4);
    expect(loc.hash).toBe('#storage');
    expect(cam.flies).toEqual([]);
    h.fireWindowEvent('hashchange');
    expect(win(h).C4PM_MODE.get()).toBe('storage');
    expect(cam.fits).toEqual([[win(h).C4PM_SIMSTRIP.stepRect(S.steps()[4]), 0.85, 50, 34]]);
  });

  it('a fly sets map.openBand to the band beside the caption card (b786); Esc (endPresent) clears it', () => {
    const { h } = load();
    const S = SIM(h);
    S.select('s-1');
    spyCam(h);
    S.hooks.present('s-1', 2);
    expect(win(h).C4PM_STATE.map.openBand).toEqual({ top: 50, bottom: 34 });
    key(h, 'Escape');
    expect(presenting(h)).toBe(false);
    expect(win(h).C4PM_STATE.map.openBand).toBeNull();
  });
});

describe('keys (capture: they beat every other key handler)', () => {
  it('→ / PageDown next, ← / PageUp back, Space play / pause, F full screen, Esc exit; not presenting: left alone', () => {
    const requests: string[] = [];
    const { h } = load();
    doc(h).documentElement.requestFullscreen = () => { requests.push('full'); return Promise.resolve(); };
    const S = SIM(h);
    S.hooks.present('s-1', 2);
    expect([key(h, 'ArrowRight').prevented, S.step()]).toEqual([1, 3]);
    key(h, 'PageDown');
    expect(S.step()).toBe(4);
    key(h, 'ArrowLeft');
    key(h, 'PageUp');
    expect(S.step()).toBe(2);
    key(h, ' ');
    expect(button(h, '❚❚').textContent).toBe('❚❚ Pause');
    key(h, ' ');
    expect(button(h, '▶').textContent).toBe('▶ Play');
    key(h, 'f');
    expect(requests).toEqual(['full']);
    const e = key(h, 'x');
    expect([e.prevented, e.stopped]).toEqual([0, 0]);
    key(h, 'Escape');
    expect(presenting(h)).toBe(false);
    expect(S.hooks.presentKey({ key: 'ArrowRight' })).toBe(false);
  });

  it('Esc with a b-item selected ends present mode; the board (bubble listener) never sees it', () => {
    const { h } = load();
    const board: string[] = [];
    doc(h).addEventListener('keydown', (e: any) => board.push(e.key));
    win(h).C4PM_BOARD = { selectedId: () => 'b1' };
    SIM(h).hooks.present('s-1', 0);
    const e = key(h, 'Escape');
    expect([presenting(h), e.stopped > 0, board]).toEqual([false, true, []]);
  });

  it('full screen is guarded: no API = nothing thrown; exit leaves full screen', () => {
    const { h } = load();
    SIM(h).hooks.present('s-1', 0);
    expect(() => key(h, 'F')).not.toThrow();
    const exits: string[] = [];
    doc(h).fullscreenElement = {};
    doc(h).exitFullscreen = () => { exits.push('exit'); return Promise.resolve(); };
    key(h, 'Escape');
    expect(exits).toEqual(['exit']);
  });

  it('with Alt / Meta / Ctrl / Shift held the keys go to the browser (step, play, full screen unchanged; not prevented); Esc still exits', () => {
    const MODS = ['altKey', 'metaKey', 'ctrlKey', 'shiftKey'];
    const KEYS = ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', ' ', 'f', 'F'];
    const modKey = (h: HarnessResult, k: string, mod: string) => {
      const e: any = { key: k, [mod]: true, target: { tagName: 'DIV' }, defaultPrevented: false, stopped: 0,
        preventDefault() { e.defaultPrevented = true; }, stopPropagation() { e.stopped++; } };
      doc(h).dispatch('keydown', e);
      return e;
    };
    const requests: string[] = [];
    const { h } = load();
    doc(h).documentElement.requestFullscreen = () => { requests.push('full'); return Promise.resolve(); };
    const S = SIM(h);
    S.hooks.present('s-1', 2);
    const at = S.step();
    const seen = KEYS.flatMap((k) => MODS.map((mod) => {
      const e = modKey(h, k, mod);
      return [k, mod, S.step(), e.defaultPrevented, e.stopped].join(' ');
    }));
    expect(seen).toEqual(KEYS.flatMap((k) => MODS.map((mod) => [k, mod, at, false, 0].join(' '))));
    expect([presenting(h), button(h, '▶').textContent, requests]).toEqual([true, '▶ Play', []]);
    MODS.forEach((mod) => {
      S.hooks.present('s-1', 2);
      const e = modKey(h, 'Escape', mod);
      expect([mod, presenting(h), e.defaultPrevented, e.stopped > 0]).toEqual([mod, false, true, true]);
    });
  });
});

describe('auto-play', () => {
  it('each step waits its durationSec (default 4 s): the bar gets --pres-sec and runs; the last step stops', () => {
    const { h, timers, flush } = load();
    const S = SIM(h);
    S.hooks.present('s-1', 4);
    timers.length = 0;
    button(h, '▶').click();
    expect(timers.map((t) => t.ms)).toEqual([4000]);
    const prog = q(h, '.pres-prog');
    expect([prog.classList.contains('on'), prog.classList.contains('run'), prog.style['--pres-sec']]).toEqual([true, true, '4s']);
    flush();
    expect([S.step(), timers.map((t) => t.ms)]).toEqual([5, [4000]]);
    flush();
    expect([S.step(), timers.map((t) => t.ms)]).toEqual([6, [6000]]);   // step 7 has durationSec 6
    expect(q(h, '.pres-prog').style['--pres-sec']).toBe('6s');
    flush();
    expect([S.step(), timers, button(h, '▶').textContent]).toEqual([6, [], '▶ Play']);
    expect(q(h, '.pres-prog').classList.contains('on')).toBe(false);
  });

  it('Play at the last step starts again at step 1; a step change while paused schedules nothing', () => {
    const { h, timers } = load();
    const S = SIM(h);
    S.hooks.present('s-1', 6);
    timers.length = 0;
    key(h, 'ArrowLeft');
    expect(timers).toEqual([]);
    key(h, 'ArrowRight');
    key(h, ' ');
    expect([S.step(), button(h, '❚❚').textContent, timers.map((t) => t.ms)]).toEqual([0, '❚❚ Pause', [4000]]);
    key(h, 'Escape');
    expect(timers).toEqual([]);
  });
});

describe('exit', () => {
  it('restores the view, the camera, the c-item, no s-item; #pres hidden and empty', () => {
    const { h } = load();
    const S = SIM(h);
    const W = win(h);
    W.C4PM_MAP.select('api/routes');
    const before = { s: 2, tx: 5, ty: 6 };
    W.C4PM_STATE.map.cam = { ...before };
    const cam = spyCam(h);
    S.hooks.present('s-1', 0);
    expect(W.C4PM_MODE.get()).toBe('io');
    button(h, 'Exit').click();
    expect([presenting(h), pres(h).hidden, pres(h).children, pres(h).classList.contains('outside')]).toEqual([false, true, [], false]);
    expect(W.C4PM_MODE.get()).toBe('arch');
    expect(cam.flies[cam.flies.length - 1]).toEqual(before);
    expect([S.selected(), S.step(), W.C4PM_MAP.selectedId()]).toEqual([null, null, 'api/routes']);
  });

  it('restores the selected s-item and its cursor, and the strip shows again', () => {
    const { h } = load();
    const S = SIM(h);
    S.select('s-1');
    S.go(1);
    S.hooks.present('s-2', 3);
    expect(S.selected()).toBe('s-2');
    key(h, 'Escape');
    expect([S.selected(), S.step(), byId(h, 'simbar').hidden]).toEqual(['s-1', 1, false]);
  });

  it('selecting another s-item while presenting ends present mode without restoring', () => {
    const { h } = load();
    const S = SIM(h);
    S.hooks.present('s-1', 2);
    S.select('s-2');
    expect([presenting(h), S.selected(), S.step(), S.hooks.presenting()]).toEqual([false, 's-2', null, false]);
  });
});

// b853 S6 (b867): present plays the flow steps of this window's depth. At container s-1's steps group
// [[0,1],[2,3],[4],[5],[6]] (test/viewer-sim-depth.test.ts); the cursor, presentGo and the posts keep the original index.
// depthHtml() gives step 4 (index 3) a caption and step 5's rows, so the merged flow step [2, 3] has two captions and
// rows known after its last member only.
function depthHtml() {
  const m = simModel();
  const st = m.sims![0].steps;
  st[3].caption = 'Create the order';
  st[3].rows = st[4].rows;
  return simHtml(m);
}
describe('flow depth (b853 S6)', () => {
  it('container, cursor 3: Step 2/5, 5 dots, one .pres-cap per caption, the tables after the last member; Next -> step 4', () => {
    const { h } = load({ html: depthHtml() });
    const S = SIM(h);
    S.setDepth('container');
    S.select('s-1');
    S.go(3);
    S.act('present');
    expect(topLine(h)[0]).toBe('Step 2/5');
    expect(text(q(h, '.pres-head').children[2])).toBe('2/5');
    expect(qa(h, '.pres-dot').length).toBe(5);
    expect(texts(h, '.pres-cap')).toEqual(['POST /orders', 'Create the order']);
    expect(q(h, '.pres-rows').innerHTML).toBe(S.rowsTableHtml(S.tableStateAt('s-1', 3)));
    expect(S.step()).toBe(2);   // the flow step's first original index
    button(h, 'Next').click();
    expect([S.step(), topLine(h)[0]]).toEqual([4, 'Step 3/5']);
    S.hooks.presentGo(1);   // an original index (as sim.js hands it over): flow step 1 of 5
    expect([S.step(), topLine(h)[0]]).toEqual([0, 'Step 1/5']);
  });

  it('a merged step plays for the sum of its members\' seconds (4 + 4 = 8 s); the keys line says so', () => {
    const { h, timers } = load();
    const S = SIM(h);
    S.setDepth('container');
    S.hooks.present('s-1', 0);
    timers.length = 0;
    button(h, '▶').click();
    expect(timers.map((t) => t.ms)).toEqual([8000]);
    expect(q(h, '.pres-prog').style['--pres-sec']).toBe('8s');
    expect(text(q(h, '.pres-keys'))).toMatch(/· 8 s per step when playing$/);
  });
});

describe('the credit link (P22 b168) in sim.css', () => {
  const css = readFileSync(join(__dirname, '../viewer/sim.css'), 'utf8');

  it('present mode hides #made-with (the #root.presenting hide list)', () => {
    const block = css.slice(css.indexOf('#root.presenting #header'));
    expect(block.slice(0, block.indexOf('{'))).toContain('#root.presenting #made-with');
  });

  it('on a phone (<=700px) the shown sim strip sits at the bottom, so #made-with hides while the strip is shown', () => {
    const at = css.indexOf('#simbar:not([hidden]) ~ #made-with');
    expect(at).toBeGreaterThan(-1);
    const media = css.lastIndexOf('@media', at);
    expect(css.slice(media, css.indexOf('{', media))).toContain('max-width: 700px');
    expect(css.slice(at, css.indexOf('}', at))).toMatch(/\{\s*display: none;\s*$/);
  });
});
