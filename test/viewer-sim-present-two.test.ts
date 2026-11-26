import { runViewerScripts, serializeText } from './helpers/viewer-harness';
import type { FakeEl, HarnessResult } from './helpers/viewer-harness';
import { simHtml } from './helpers/sim-view';
import { makeBus } from './helpers/link-bus';
import type { Bus } from './helpers/link-bus';

// Phase 25 UI17-3 (b849): present across two windows, the leader side (viewer/sim-present.js). Two pages of the sim sample
// (simHtml(): flow s-1 = io, io, arch, arch, storage, arch, io) over one in-memory BroadcastChannel bus (makeBus). The
// window that presents (the leader) gives each step to the lowest-id other map window showing the step's view (P.owner);
// when that is another window, the leader shows the head pill, the line "Step n plays in the <View> window" and the
// controls (#pres.away): no card, no view switch, no fly. Its 'sim' posts carry pres { lead, owner, playing, sec }.

const IDS = ['pres', 'simbar', 'view-toast', 'btn-gear', 'settings-pop'];
type Timer = { id: number; fn: () => void; ms: number };
// One page with its own fake timers (they keep the ms) on the shared channel.
function page(BroadcastChannel: unknown, more: Record<string, unknown> = {}) {
  const timers: Timer[] = [];
  let seq = 0;
  const globals = {
    BroadcastChannel,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ id: ++seq, fn, ms }); return seq; },
    clearTimeout: (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...more,
  };
  const h = runViewerScripts(simHtml(), { extraIds: IDS, globals });
  return { h, timers };
}
const stepTimers = (t: Timer[]) => t.filter((x) => x.ms >= 1000);   // a step timer waits the step's seconds (4 s, 6 s, ...)
const win = (h: HarnessResult) => h.sandbox.window as any;
const SIM = (h: HarnessResult) => win(h).C4PM_SIM;
const linkId = (h: HarnessResult): string => win(h).C4PM_LINK.id();
const mode = (h: HarnessResult) => win(h).C4PM_MODE.get();
const pres = (h: HarnessResult) => (h.sandbox.document as any).getElementById('pres') as FakeEl & { hidden?: boolean };
const qa = (h: HarnessResult, sel: string) => pres(h).querySelectorAll(sel);
const text = (e: FakeEl) => serializeText(e).replace(/\s+/g, ' ').trim();
const away = (h: HarnessResult) => pres(h).classList.contains('away');
const button = (h: HarnessResult, start: string) => qa(h, '.tbb').find((b) => b.textContent.startsWith(start)) as FakeEl & { disabled?: boolean };
// The 'sim' messages page h posted (counted by `from`).
const simsFrom = (bus: Bus, h: HarnessResult) => bus.sent.filter((s) => s.data.type === 'sim' && s.data.from === linkId(h)).map((s) => s.data);
const lastSim = (bus: Bus, h: HarnessResult) => { const l = simsFrom(bus, h); return l[l.length - 1]; };
// Records C4PM_CAM.fitCamIn calls and flyTo targets, as test/viewer-sim-present.test.ts does.
function spyCam(h: HarnessResult) {
  const CAM = win(h).C4PM_CAM;
  const fit = CAM.fitCamIn;
  const log = { fits: [] as any[][], flies: [] as any[] };
  CAM.fitCamIn = (...a: any[]) => { log.fits.push(a); return fit(...a); };
  CAM.flyTo = (t: any) => { log.flies.push(t); };
  return log;
}
// A (arch) and B; B switched to io (its hello tells A).
function twoPages() {
  const { bus, BroadcastChannel } = makeBus();
  const A = page(BroadcastChannel), B = page(BroadcastChannel);
  win(B.h).C4PM_MODE.set('io');
  return { bus, A, B };
}

describe('the step owner (UI17-3)', () => {
  it('alone: a drawn step plays here (no #pres.away, the card, the fly); the post says lead and owner = this window', () => {
    const { bus, BroadcastChannel } = makeBus();
    const A = page(BroadcastChannel);
    const cam = spyCam(A.h);
    SIM(A.h).hooks.present('s-1', 2);
    expect(away(A.h)).toBe(false);
    expect(qa(A.h, '.pres-card').length).toBe(1);
    expect(qa(A.h, '.pres-away')).toEqual([]);
    expect(cam.flies.length).toBe(1);
    expect(lastSim(bus, A.h)).toMatchObject({ sim: 's-1', step: 2, pres: { lead: true, owner: linkId(A.h), playing: false, sec: 4 } });
  });

  it('B shows io: A (arch) presents an io step -> away: head pill + "Step 1 plays in the IO window", no view switch, no fly', () => {
    const { bus, A, B } = twoPages();
    expect(SIM(A.h).steps('s-1')[0].view).toBe('io');
    const cam = spyCam(A.h);
    SIM(A.h).hooks.present('s-1', 0);
    expect(away(A.h)).toBe(true);
    expect(pres(A.h).children.map((c) => c.className)).toEqual(['pres-head', 'pres-away', 'pres-ctl']);
    expect(text(qa(A.h, '.pres-away')[0])).toBe('Step 1 plays in the IO window');
    expect(qa(A.h, '.pres-card')).toEqual([]);
    expect(mode(A.h)).toBe('arch');
    expect([cam.fits, cam.flies]).toEqual([[], []]);
    expect(lastSim(bus, A.h)).toMatchObject({ sim: 's-1', step: 0, pres: { lead: true, owner: linkId(B.h) } });
    expect(SIM(B.h).step()).toBe(0);   // B follows the step through the link (sim.js)
  });

  it('away: the controls stay in the leader (dots, Back, Play, Next, Exit work); Play keeps the leader timer', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    expect(qa(A.h, '.tbb').map((b) => b.textContent)).toEqual(['‹ Back', '▶ Play', 'Next ›', '⛶ Full screen', '⧉ Two windows', 'Exit ✕']);
    expect(qa(A.h, '.pres-dot').length).toBe(7);
    button(A.h, 'Next').click();
    expect([SIM(A.h).step(), away(A.h), text(qa(A.h, '.pres-away')[0])]).toEqual([1, true, 'Step 2 plays in the IO window']);
    button(A.h, '▶').click();
    expect(stepTimers(A.timers).map((t) => t.ms)).toEqual([4000]);   // the leader's timer runs while away
    const st = stepTimers(A.timers)[0]; A.timers.splice(A.timers.indexOf(st), 1); st.fn();   // the timer: step 3 (arch, A owns it); its post says playing
    expect([SIM(A.h).step(), away(A.h)]).toEqual([2, false]);
    expect(lastSim(bus, A.h).pres).toMatchObject({ playing: true, owner: linkId(A.h), sec: 4 });
    button(A.h, '‹').click();
    expect([SIM(A.h).step(), away(A.h)]).toEqual([1, true]);
    button(A.h, 'Exit').click();
    expect(SIM(A.h).hooks.presenting()).toBe(false);
  });

  it('same pages: an arch step plays in A (A flies, owner A); a storage step too (A switches to storage)', () => {
    const { bus, A } = twoPages();
    const cam = spyCam(A.h);
    SIM(A.h).hooks.present('s-1', 0);
    SIM(A.h).hooks.presentGo(2);
    expect([away(A.h), mode(A.h), cam.flies.length]).toEqual([false, 'arch', 1]);
    expect(qa(A.h, '.pres-card').length).toBe(1);
    expect(lastSim(bus, A.h).pres.owner).toBe(linkId(A.h));
    SIM(A.h).hooks.presentGo(4);
    expect([away(A.h), mode(A.h), cam.flies.length]).toEqual([false, 'storage', 2]);
    expect(lastSim(bus, A.h)).toMatchObject({ step: 4, pres: { owner: linkId(A.h) } });
  });

  it('B leaves (pagehide) while A is away on its io step: A plays it here (mode io, fly), same step, the timer still pending', () => {
    const { bus, A, B } = twoPages();
    const cam = spyCam(A.h);
    SIM(A.h).hooks.present('s-1', 0);
    button(A.h, '▶').click();
    const timer = stepTimers(A.timers).map((t) => t.id);
    expect(timer.length).toBe(1);
    B.h.fireWindowEvent('pagehide');
    expect([away(A.h), mode(A.h), SIM(A.h).step(), cam.flies.length]).toEqual([false, 'io', 0, 1]);
    expect(qa(A.h, '.pres-card').length).toBe(1);
    expect(stepTimers(A.timers).map((t) => t.id)).toEqual(timer);
    expect(lastSim(bus, A.h)).toMatchObject({ step: 0, pres: { owner: linkId(A.h), playing: true } });
  });

  it('a peer that switches to the step view takes it over (onPeers, no step change); switching away gives it back', () => {
    const { bus, BroadcastChannel } = makeBus();
    const A = page(BroadcastChannel), B = page(BroadcastChannel);
    win(B.h).C4PM_MODE.set('storage');
    const cam = spyCam(A.h);
    SIM(A.h).hooks.present('s-1', 2);   // arch: B shows storage, A plays it
    expect([away(A.h), cam.flies.length]).toEqual([false, 1]);
    const posts = simsFrom(bus, A.h).length;
    win(B.h).C4PM_MODE.set('arch');
    expect([away(A.h), mode(A.h), SIM(A.h).step(), cam.flies.length]).toEqual([true, 'arch', 2, 1]);
    expect(simsFrom(bus, A.h).length).toBe(posts + 1);   // the re-post with the new owner
    expect(lastSim(bus, A.h)).toMatchObject({ step: 2, pres: { owner: linkId(B.h) } });
    win(B.h).C4PM_MODE.set('storage');
    expect([away(A.h), SIM(A.h).step(), cam.flies.length]).toEqual([false, 2, 2]);
    expect(lastSim(bus, A.h).pres.owner).toBe(linkId(A.h));
  });

  it('a sequence-only window (map: false) on io owns nothing: A plays the io step itself', () => {
    const { bus, BroadcastChannel } = makeBus();
    const A = page(BroadcastChannel);
    page(BroadcastChannel, { location: { href: 'file:///x.html#io&seqonly', hash: '#io&seqonly' } });
    expect(win(A.h).C4PM_LINK.peers()).toMatchObject([{ view: 'io', map: false }]);
    SIM(A.h).hooks.present('s-1', 0);
    expect([away(A.h), mode(A.h)]).toEqual([false, 'io']);
    expect(lastSim(bus, A.h).pres.owner).toBe(linkId(A.h));
  });
});

// UI17-4a (b850): the helper (a window that did not start present) follows the leader's 'sim' posts with pres.lead:
// #root.presenting, the card when it owns the step (it flies in its own view, never switches view), the away look when
// the leader or another window owns it; the bar runs while playing on an owned step; it never sets a step timer.
const presenting = (h: HarnessResult) => ((h.sandbox.document as any).getElementById('root') as FakeEl).classList.contains('presenting');
const stepTexts = (h: HarnessResult) => qa(h, '.pres-n').map(text);   // the head pill's "n/N" (+ the card's "Step n/N")
describe('the helper follows the leader (UI17-4a)', () => {
  it('F1 B shows io, A (arch) presents s-1 at step 0 (io): B presents, builds the card, flies in io, sets no step timer', () => {
    const { A, B } = twoPages();
    const camB = spyCam(B.h);
    SIM(A.h).hooks.present('s-1', 0);
    expect([presenting(B.h), pres(B.h).hidden, away(B.h), qa(B.h, '.pres-card').length]).toEqual([true, false, false, 1]);
    expect(stepTexts(B.h)).toEqual(['1/7', 'Step 1/7']);   // the head pill, the card
    expect([camB.fits.length, camB.flies.length, mode(B.h)]).toEqual([1, 1, 'io']);
    expect(stepTimers(B.timers)).toEqual([]);
    expect(SIM(B.h).hooks.presentState()).toBeNull();   // only the leader posts pres
    expect(away(A.h)).toBe(true);   // A (the leader) is away: B plays it
  });

  it('F2 A goes to an arch step: B shows the away look "Step 3 plays in the Architecture window" and does not fly', () => {
    const { A, B } = twoPages();
    const camB = spyCam(B.h);
    SIM(A.h).hooks.present('s-1', 0);
    SIM(A.h).hooks.presentGo(2);
    expect([away(B.h), qa(B.h, '.pres-card').length, mode(B.h)]).toEqual([true, 0, 'io']);
    expect(text(qa(B.h, '.pres-away')[0])).toBe('Step 3 plays in the Architecture window');
    expect(stepTexts(B.h)).toEqual(['3/7']);   // the head pill only (no card)
    expect(camB.flies.length).toBe(1);   // the io step 1 only
    expect(away(A.h)).toBe(false);
  });

  it('F3 A plays on a B-owned io step: B\'s bar runs (--pres-sec) without a timer; A\'s timer steps and B follows', () => {
    const { A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    button(A.h, '▶').click();   // play re-posts step 1 with playing (UI17-4c)
    SIM(A.h).hooks.presentGo(1);   // the next post says playing (io, B owns it)
    const prog = qa(B.h, '.pres-prog')[0] as FakeEl & { style: Record<string, string> };
    expect([prog.classList.contains('on'), prog.classList.contains('run'), prog.style['--pres-sec']]).toEqual([true, true, '4s']);
    expect(stepTimers(B.timers)).toEqual([]);
    expect(stepTimers(A.timers).length).toBe(1);
    A.timers.splice(0).find((t) => t.ms >= 1000)!.fn();   // A's timer: step 3 (arch)
    expect(SIM(A.h).step()).toBe(2);
    expect([away(B.h), stepTexts(B.h), stepTimers(B.timers)]).toEqual([true, ['3/7'], []]);
  });

  it('F4 a sequence-only page never enters present on the leader\'s messages', () => {
    const { BroadcastChannel } = makeBus();
    const A = page(BroadcastChannel);
    const Q = page(BroadcastChannel, { location: { href: 'file:///x.html#io&seqonly', hash: '#io&seqonly' } });
    SIM(A.h).hooks.present('s-1', 0);
    SIM(A.h).hooks.presentGo(1);
    expect([presenting(Q.h), pres(Q.h).hidden === false, pres(Q.h).children.length, SIM(Q.h).hooks.presenting()]).toEqual([false, false, 0, false]);
  });

  it('F5 the same leader message twice (and a playing change on the same step): B flies once', () => {
    const { A, B } = twoPages();
    const camB = spyCam(B.h);
    SIM(A.h).hooks.present('s-1', 0);
    SIM(A.h).hooks.presentGo(0);   // the same step and owner again
    button(A.h, '▶').click();
    SIM(A.h).hooks.presentGo(0);   // same step and owner, now playing
    expect(qa(B.h, '.pres-prog')[0].classList.contains('run')).toBe(true);
    expect(camB.flies.length).toBe(1);
  });

  it('F6 the helper never takes a step itself: A leaves while B is away on its arch step -> B keeps io, posts no pres', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 2);   // arch: A owns it, B is away
    expect(away(B.h)).toBe(true);
    const posts = simsFrom(bus, B.h).length;
    A.h.fireWindowEvent('pagehide');   // B's peers change (onPeers)
    // UI17-5 (on purpose): the leader left, so B ends present (E3) instead of taking the step
    expect([mode(B.h), presenting(B.h)]).toEqual(['io', false]);
    expect(simsFrom(bus, B.h).slice(posts).filter((d) => d.pres)).toEqual([]);
  });
});

// UI17-4b (b860): the helper's input goes to the leader (G2 → / Next, G3 Space: a plain 'sim' or a { pres: { req } }
// request; the leader decides and posts), and a new s-item from the leader keeps it following (G4: sim.js's select no
// longer ends the helper's present, so Exit still restores its first view).
const key = (k: string) => ({ key: k, code: k === ' ' ? 'Space' : k, preventDefault() {} });
const playLabel = (h: HarnessResult) => (button(h, '▶') ? '▶ Play' : button(h, '❚❚') ? '❚❚ Pause' : '');
describe('the helper\'s input goes to the leader (UI17-4b)', () => {
  it('G1 A goes to step 3: B\'s map draws step 3 (C4PM_STATE.map.sim.step) and B posts nothing for it', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    const posts = simsFrom(bus, B.h).length;
    SIM(A.h).hooks.presentGo(2);
    expect(win(B.h).C4PM_STATE.map.sim).toMatchObject({ id: 's-1', step: 2 });
    expect(simsFrom(bus, B.h).length).toBe(posts);
  });

  it('G2 B presses → (and clicks Next): A takes the next step and posts it with pres; B shows it; B sent one plain \'sim\' each', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    const posts = simsFrom(bus, B.h).length, postsA = simsFrom(bus, A.h).length;
    expect(SIM(B.h).hooks.presentKey(key('ArrowRight'))).toBe(true);
    expect(SIM(A.h).step()).toBe(1);
    expect(simsFrom(bus, A.h).length).toBe(postsA + 1);   // A decides the owner and posts the step
    expect(lastSim(bus, A.h)).toMatchObject({ sim: 's-1', step: 1, pres: { lead: true, owner: linkId(B.h) } });
    expect(simsFrom(bus, B.h).slice(posts)).toEqual([{ type: 'sim', from: linkId(B.h), view: 'io', sim: 's-1', step: 1 }]);
    expect([stepTexts(B.h), away(B.h), SIM(B.h).step()]).toEqual([['2/7', 'Step 2/7'], false, 1]);
    button(B.h, 'Next').click();   // step 3 is arch: A plays it, B is away
    expect([SIM(A.h).step(), away(A.h), away(B.h), stepTexts(B.h)]).toEqual([2, false, true, ['3/7']]);
    expect(simsFrom(bus, B.h).slice(posts).map((d) => d.pres)).toEqual([undefined, undefined]);
    expect(stepTimers(B.timers)).toEqual([]);
  });

  it('G3 B presses Space: B asks { pres: { req: play } } and A plays (A has the step timer); on a playing step Pause pauses A', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    const posts = simsFrom(bus, B.h).length;
    SIM(B.h).hooks.presentKey(key(' '));
    expect(simsFrom(bus, B.h).slice(posts)).toEqual([{ type: 'sim', from: linkId(B.h), view: 'io', sim: 's-1', step: 0, pres: { req: 'play' } }]);
    expect([stepTimers(A.timers).length, playLabel(A.h), SIM(A.h).step()]).toEqual([1, '❚❚ Pause', 0]);
    expect(stepTimers(B.timers)).toEqual([]);
    stepTimers(A.timers)[0].fn();   // A's timer: step 2; its post says playing, so B shows Pause
    expect([SIM(A.h).step(), playLabel(B.h)]).toEqual([1, '❚❚ Pause']);
    SIM(B.h).hooks.presentKey(key(' '));   // Space on a playing step asks pause
    expect(lastSim(bus, B.h).pres).toEqual({ req: 'pause' });
    expect([stepTimers(A.timers), playLabel(A.h), SIM(A.h).step()]).toEqual([[], '▶ Play', 1]);
  });

  it('G4 a new s-item from A keeps B presenting; B\'s Exit ends both (UI17-5); A\'s own select ends A\'s present and B\'s', () => {
    const { A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    SIM(A.h).hooks.present('s-2', 0);   // the leader presents another s-item: select (remote in B) + its step 1
    expect([presenting(B.h), SIM(B.h).hooks.presenting(), SIM(B.h).selected(), stepTexts(B.h)[0]]).toEqual([true, true, 's-2', '1/9']);
    // UI17-5 (on purpose): B's Exit asks A; A's end message ends B (B's restore posts nothing), then A's restore select
    // (A had no s-item) reaches B: the s-item follows the leader, the view stays B's own
    SIM(B.h).hooks.presentKey(key('Escape'));
    A.h.frames.runToCompletion();
    B.h.frames.runToCompletion();
    expect([SIM(A.h).hooks.presenting(), presenting(B.h), SIM(B.h).selected(), mode(B.h)]).toEqual([false, false, null, 'io']);

    const two = twoPages();
    SIM(two.A.h).hooks.present('s-1', 0);
    SIM(two.A.h).select('s-2');   // sim.js ends the leader's present on its own select (kept)
    // UI17-5 (on purpose): that end posts the end message too, so B ends (else B's Exit would ask a leader that no longer presents)
    expect([SIM(two.A.h).hooks.presenting(), presenting(two.B.h), SIM(two.B.h).hooks.presenting(), SIM(two.B.h).selected()]).toEqual([false, false, false, 's-2']);
  });
});

// UI17-4c (b861): the leader fixes. Play / Pause re-posts (H1); the first post of a present already carries the owner
// (H2); the bar restarts after an owner change (H3); the last window to start present leads (H4: pres.since, an older
// leader yields and follows); the bar runs the same in both windows while playing (H5).
const prog = (h: HarnessResult) => qa(h, '.pres-prog')[0] as FakeEl & { style: Record<string, string> };
const running = (h: HarnessResult) => prog(h).classList.contains('run');
// Two pages on a queued bus (makeBus async: a message arrives at bus.flush(), as a real channel delivers after the current
// script) with one shared clock (each page's Date.now reads clock.t): two windows can start present before either hears
// the other.
function racePages() {
  const { bus, BroadcastChannel } = makeBus({ async: true });
  const clock = { t: 1000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const A = page(BroadcastChannel, { Date: FakeDate }), B = page(BroadcastChannel, { Date: FakeDate });
  bus.flush();
  win(B.h).C4PM_MODE.set('io');
  bus.flush();
  return { bus, clock, A, B };
}
describe('the leader fixes (UI17-4c)', () => {
  it('H1 A presses Play: A posts the step with pres.playing true at once and B shows Pause; Pause posts playing false', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);
    const posts = simsFrom(bus, A.h).length;
    button(A.h, '▶').click();
    expect(simsFrom(bus, A.h).slice(posts).map((d) => [d.step, d.pres.playing])).toEqual([[0, true]]);
    expect([playLabel(A.h), playLabel(B.h)]).toEqual(['❚❚ Pause', '❚❚ Pause']);
    button(A.h, '❚❚').click();
    expect(simsFrom(bus, A.h).slice(posts).map((d) => [d.step, d.pres.playing])).toEqual([[0, true], [0, false]]);
    expect([playLabel(A.h), playLabel(B.h)]).toEqual(['▶ Play', '▶ Play']);
  });

  it('H2 B shows io: A (arch) starts present at step 0 (io): A\'s first \'sim\' post of the present already names B the owner', () => {
    const { bus, A, B } = twoPages();
    const posts = simsFrom(bus, A.h).length;
    SIM(A.h).hooks.present('s-1', 0);
    const mine = simsFrom(bus, A.h).slice(posts);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.map((d) => d.pres.owner)).toEqual(mine.map(() => linkId(B.h)));
  });

  it('H3 playing on an A-owned arch step, B switches to arch (B owns it now): A\'s bar runs again after the re-render', () => {
    const { A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 2);   // arch: A plays it, B (io) is away
    button(A.h, '▶').click();
    expect(running(A.h)).toBe(true);
    const timers = stepTimers(A.timers).map((t) => t.id);
    win(B.h).C4PM_MODE.set('arch');
    expect([away(A.h), running(A.h), prog(A.h).style['--pres-sec']]).toEqual([true, true, '4s']);
    expect(stepTimers(A.timers).map((t) => t.id)).toEqual(timers);   // the visual bar only: the step timer stays
  });

  it('H4 A presents, then B starts its own present later: A yields and follows B; B leads', () => {
    const { bus, clock, A, B } = racePages();
    SIM(A.h).hooks.present('s-1', 0);
    button(A.h, '▶').click();
    clock.t = 2000;
    SIM(B.h).hooks.present('s-1', 0);   // before B hears A: two leaders until the messages arrive
    bus.flush();
    expect(SIM(A.h).hooks.presentState()).toBeNull();   // A follows: only the leader posts pres
    expect(SIM(B.h).hooks.presentState()).toMatchObject({ pres: { lead: true, since: 2000 } });
    expect([SIM(A.h).hooks.presenting(), presenting(A.h), stepTimers(A.timers)]).toEqual([true, true, []]);
    expect([away(A.h), qa(A.h, '.pres-card').length, mode(A.h)]).toEqual([true, 0, 'arch']);   // io step: B plays it
    SIM(B.h).hooks.presentGo(2);   // B leads: its arch step plays in A (the helper builds the card)
    bus.flush();
    expect([SIM(A.h).step(), away(A.h), qa(A.h, '.pres-card').length, stepTimers(A.timers)]).toEqual([2, false, 1, []]);
  });

  it('H4 the reverse: B started present before A (B is older): A keeps leading and B follows A', () => {
    const { bus, clock, A, B } = racePages();
    clock.t = 1000;
    SIM(B.h).hooks.present('s-1', 0);
    clock.t = 2000;
    SIM(A.h).hooks.present('s-1', 0);
    bus.flush();
    expect(SIM(A.h).hooks.presentState()).toMatchObject({ pres: { lead: true, since: 2000 } });
    expect(SIM(B.h).hooks.presentState()).toBeNull();
    expect([away(A.h), away(B.h), qa(B.h, '.pres-card').length]).toEqual([true, false, 1]);   // io step: B plays it for A
  });

  it('H5 A plays on an A-owned arch step: B (away) runs the bar over pres.sec; A pauses: B\'s bar stops', () => {
    const { A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 2);
    expect(away(B.h)).toBe(true);
    button(A.h, '▶').click();
    expect([running(B.h), prog(B.h).style['--pres-sec'], stepTimers(B.timers)]).toEqual([true, '4s', []]);
    button(A.h, '❚❚').click();
    expect([running(B.h), playLabel(B.h)]).toEqual([false, '▶ Play']);
  });
});

// UI17-5 (b851): ending present everywhere. The leader's end posts 'sim' { pres: { end: true } } (replayed) before its
// restore; a helper that gets it from its leader ends and restores without posting (E1). A helper's Esc / Exit only asks
// the leader ({ pres: { req: 'exit' } }); the leader's end then ends it (E2). The leader's window leaving ends the helper
// (E3). A helper that starts its own present leads, the old leader yields and keeps its first remembered view (E4). A window
// that joins after the end is not drawn into it (E5).
// Two pages on the sync bus with one shared clock (Date.now reads clock.t), so the later start wins for sure (4c since).
function clockPages() {
  const { bus, BroadcastChannel } = makeBus();
  const clock = { t: 1000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const A = page(BroadcastChannel, { Date: FakeDate }), B = page(BroadcastChannel, { Date: FakeDate });
  win(B.h).C4PM_MODE.set('io');
  return { bus, clock, A, B };
}
const settle = (...hs: HarnessResult[]) => hs.forEach((h) => h.frames.runToCompletion());   // whenSized frames
describe('ending present everywhere (UI17-5)', () => {
  it('E1 A leads, B follows; A\'s Exit posts pres.end (replay) before its restore; B leaves present and posts nothing', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 2);   // arch: A plays it, B (io) is away
    expect(presenting(B.h)).toBe(true);
    const postsA = simsFrom(bus, A.h).length, postsB = simsFrom(bus, B.h).length;
    button(A.h, 'Exit').click();
    settle(A.h, B.h);
    const mine = simsFrom(bus, A.h).slice(postsA);
    expect(mine[0]).toMatchObject({ sim: 's-1', step: 2, pres: { end: true } });
    expect(mine.length).toBeGreaterThan(1);   // then the restore (its select posts, the other windows follow it)
    expect(mine.slice(1).filter((d) => d.pres)).toEqual([]);
    expect([presenting(A.h), presenting(B.h), SIM(B.h).hooks.presenting(), pres(B.h).hidden]).toEqual([false, false, false, true]);
    expect(simsFrom(bus, B.h).slice(postsB)).toEqual([]);
  });

  it('E2 B presses Esc: B only asks { pres: { req: exit } }; A ends, B ends by A\'s end message; each back in its own view', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 4);   // storage: A switches to storage and plays it
    expect([mode(A.h), presenting(B.h)]).toEqual(['storage', true]);
    const postsB = simsFrom(bus, B.h).length;
    expect(SIM(B.h).hooks.presentKey(key('Escape'))).toBe(true);
    settle(A.h, B.h);
    expect(simsFrom(bus, B.h).slice(postsB)).toEqual([{ type: 'sim', from: linkId(B.h), view: 'io', sim: 's-1', step: 4, pres: { req: 'exit' } }]);
    expect([SIM(A.h).hooks.presenting(), presenting(A.h), SIM(B.h).hooks.presenting(), presenting(B.h)]).toEqual([false, false, false, false]);
    expect([mode(A.h), mode(B.h)]).toEqual(['arch', 'io']);
  });

  it('E3 B follows; A\'s window leaves (pagehide): B ends present, keeps its view and posts nothing', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 0);   // io: B plays it
    expect([presenting(B.h), away(B.h)]).toEqual([true, false]);
    const postsB = simsFrom(bus, B.h).length;
    A.h.fireWindowEvent('pagehide');
    settle(B.h);
    expect([presenting(B.h), SIM(B.h).hooks.presenting(), mode(B.h)]).toEqual([false, false, 'io']);
    expect(simsFrom(bus, B.h).slice(postsB)).toEqual([]);
  });

  it('E4 B follows, then starts its own present: B leads, A yields; A\'s Exit later restores A\'s view from before its first present', () => {
    const { bus, clock, A, B } = clockPages();
    SIM(A.h).hooks.present('s-1', 4);   // storage: A switches from arch to storage
    expect([mode(A.h), presenting(B.h)]).toEqual(['storage', true]);
    clock.t = 2000;
    SIM(B.h).hooks.present('s-1', 0);   // the helper starts its own present
    expect(SIM(B.h).hooks.presentState()).toMatchObject({ pres: { lead: true, since: 2000 } });
    expect(lastSim(bus, B.h)).toMatchObject({ sim: 's-1', step: 0, pres: { lead: true } });
    expect([SIM(A.h).hooks.presentState(), SIM(A.h).hooks.presenting(), away(A.h), stepTimers(A.timers)]).toEqual([null, true, true, []]);
    const postsA = simsFrom(bus, A.h).length;
    button(A.h, 'Exit').click();   // A follows now: its Exit asks B
    settle(A.h, B.h);
    expect(simsFrom(bus, A.h).slice(postsA)).toEqual([{ type: 'sim', from: linkId(A.h), view: 'storage', sim: 's-1', step: 0, pres: { req: 'exit' } }]);
    expect([SIM(A.h).hooks.presenting(), SIM(B.h).hooks.presenting()]).toEqual([false, false]);
    expect([mode(A.h), mode(B.h)]).toEqual(['arch', 'io']);
  });

  it('E5 a window that joins after A ended (async bus, replay) does not enter present', () => {
    const { bus, BroadcastChannel } = makeBus({ async: true });
    const loc = { href: 'file:///x.html#arch', hash: '#arch' };
    const A = page(BroadcastChannel, { location: loc });
    bus.flush();
    SIM(A.h).hooks.present('s-1', 4);   // storage: the view switch waits for the hashchange
    A.h.fireWindowEvent('hashchange');
    bus.flush();
    expect(mode(A.h)).toBe('storage');
    button(A.h, 'Exit').click();   // the restore waits for its hashchange (not fired): nothing posted by it yet
    bus.flush();
    const C = page(BroadcastChannel);
    bus.flush();
    expect(SIM(C.h).selected()).toBe('s-1');   // C got A's replayed 'sim' message
    expect([SIM(C.h).hooks.presenting(), presenting(C.h)]).toEqual([false, false]);
  });
});

// b853 S6 (b867): each window presents the flow steps of its own depth; only original step indexes cross windows (the
// 'sim' message step). At container s-1's steps group [[0,1],[2,3],[4],[5],[6]].
describe('flow depth across windows (b853 S6)', () => {
  // b853 S6b (on purpose): the helper presents at the LEADER's depth now (was: its own, Step 2/5 here); its own depth stays
  it('D1 A at code, B at container: A\'s post step 3 -> B shows A\'s 4/7; B\'s Next and Space reach A as original indexes', () => {
    const { bus, A, B } = twoPages();
    SIM(B.h).setDepth('container');
    SIM(A.h).hooks.present('s-1', 3);   // arch: A plays it, B (io) is away
    expect(lastSim(bus, A.h)).toMatchObject({ sim: 's-1', step: 3, pres: { lead: true, depth: 'code' } });
    expect([stepTexts(A.h), stepTexts(B.h), qa(B.h, '.pres-dot').length, SIM(B.h).depth()]).toEqual([['4/7', 'Step 4/7'], ['4/7'], 7, 'container']);
    const postsB = simsFrom(bus, B.h).length;
    SIM(B.h).hooks.presentKey(key(' '));   // the play request carries the leader's own step: A stays on step 3
    expect(simsFrom(bus, B.h).slice(postsB).map((d) => [d.step, d.pres])).toEqual([[3, { req: 'play' }]]);
    expect([SIM(A.h).step(), playLabel(A.h)]).toEqual([3, '❚❚ Pause']);
    button(B.h, 'Next').click();   // B's next flow step at A's depth (code) = original step 4
    expect(simsFrom(bus, B.h).slice(postsB).map((d) => d.step)).toEqual([3, 4]);
    expect([SIM(A.h).step(), stepTexts(A.h)[0], stepTexts(B.h)[0]]).toEqual([4, '5/7', '5/7']);
  });

  it('D2 a depth change while presenting: the card follows the cursor (Step k/N), the step timer stays', () => {
    const { A, B } = twoPages();
    SIM(A.h).hooks.present('s-1', 3);
    button(A.h, '▶').click();
    const timers = stepTimers(A.timers).map((t) => t.id);
    SIM(A.h).setDepth('container');
    expect([stepTexts(A.h), SIM(A.h).step(), qa(A.h, '.pres-dot').length]).toEqual([['2/5', 'Step 2/5'], 3, 5]);
    expect(stepTimers(A.timers).map((t) => t.id)).toEqual(timers);
    SIM(B.h).setDepth('component');   // the helper too
    SIM(B.h).setDepth('container');
    expect(stepTexts(B.h)).toEqual(['2/5']);
  });
});

// b853 S6b (b869): while a window follows a present, its present list uses the LEADER's depth (pres.depth); its own
// depth() (strip, map, sequence) does not change and is in force again after present. A depth change in the leader
// re-posts the step, so the helper gets the new depth and owner.
const ownDepth = (h: HarnessResult) => [SIM(h).depth(), win(h).C4PM_STATE.map.sim.depth];
describe('the helper takes the leader\'s depth (b853 S6b)', () => {
  it('L1 A at container, B at code: B\'s Next moves the present from A\'s flow step 2 to 3 (both 3/5); B stays at code', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).setDepth('container');
    SIM(A.h).hooks.present('s-1', 2);   // A's flow step 2 = [2, 3] (arch, A plays it)
    expect(lastSim(bus, A.h)).toMatchObject({ sim: 's-1', step: 2, pres: { lead: true, depth: 'container' } });
    expect([stepTexts(A.h), stepTexts(B.h), qa(B.h, '.pres-dot').length]).toEqual([['2/5', 'Step 2/5'], ['2/5'], 5]);
    button(B.h, 'Next').click();   // B's next flow step (at A's depth) = original step 4 (storage, A plays it)
    expect([SIM(A.h).step(), stepTexts(A.h), stepTexts(B.h)]).toEqual([4, ['3/5', 'Step 3/5'], ['3/5']]);
    expect(ownDepth(B.h)).toEqual(['code', 'code']);
  });

  it('L2 A changes its depth container -> code while presenting: B\'s card follows (Step 7/7) by one new lead post with depth code', () => {
    const { bus, A, B } = twoPages();
    SIM(A.h).setDepth('container');
    SIM(A.h).hooks.present('s-1', 6);   // io: B plays it
    expect([stepTexts(B.h), away(B.h)]).toEqual([['5/5', 'Step 5/5'], false]);
    const postsA = simsFrom(bus, A.h).length;
    SIM(A.h).setDepth('code');
    const lead = simsFrom(bus, A.h).slice(postsA).filter((d) => d.pres && d.pres.lead);
    expect(lead.length).toBe(1);
    expect(lead[0]).toMatchObject({ step: 6, pres: { depth: 'code', owner: linkId(B.h) } });
    expect([stepTexts(A.h), stepTexts(B.h), away(B.h)]).toEqual([['7/7'], ['7/7', 'Step 7/7'], false]);
    expect(ownDepth(B.h)).toEqual(['code', 'code']);
  });

  it('L3 B shows A\'s depth only while it follows: after A\'s Exit, B\'s own depth (code) is in force; its own present has 7 steps', () => {
    const { A, B } = twoPages();
    SIM(A.h).setDepth('container');
    SIM(A.h).hooks.present('s-1', 0);   // io: B plays it at A's depth
    expect([stepTexts(B.h), ownDepth(B.h)]).toEqual([['1/5', 'Step 1/5'], ['code', 'code']]);
    button(A.h, 'Exit').click();
    settle(A.h, B.h);
    expect([presenting(B.h), SIM(B.h).depth(), SIM(B.h).flow('s-1').length]).toEqual([false, 'code', 7]);
    SIM(B.h).hooks.present('s-1', 0);   // B leads now, at its own depth
    expect(stepTexts(B.h)).toEqual(['1/7', 'Step 1/7']);
  });
});
