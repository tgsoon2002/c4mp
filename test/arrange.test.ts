import { SLOT, BEAN, PAD, HEAD, GAP, TARGET_ASPECT, FRAME_HEAD, FRAME_GAP, arrangeSlots, arrangeStack, frameSlots, regionFromSlots, fitScale, regionScale, regionScaleFor } from '../src/view/arrange';

// P14-I2: pure arrangement. Slots only; regionFromSlots is the one place that sizes a region.

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  a.x < b.x + SLOT.w && b.x < a.x + SLOT.w && a.y < b.y + SLOT.h && b.y < a.y + SLOT.h;

describe('arrangeStack (Phase 28 LK-G)', () => {
  // group of each child (0..framed-1 = layers in declared order, anything else = no layer) -> expected slots
  const top = HEAD + PAD + FRAME_HEAD;
  it.each([
    ['two layers and a loose child: layer 0, then layer 1 (one row, centred), then the loose child; 2 columns', [1, -1, 0, 0], 2, [
      { x: PAD + SLOT.w / 2, y: top + SLOT.h + FRAME_GAP + FRAME_HEAD },
      { x: PAD + SLOT.w / 2, y: top + 2 * SLOT.h + 2 * FRAME_GAP + FRAME_HEAD },
      { x: PAD, y: top },
      { x: PAD + SLOT.w, y: top },
    ]],
    ['an empty layer takes no room', [2, 0], 3, [
      { x: PAD, y: top + SLOT.h + FRAME_GAP + FRAME_HEAD },
      { x: PAD, y: top },
    ]],
  ])('%s', (_n, groupOf, framed, want) => {
    expect(arrangeStack(groupOf as number[], framed as number).slots).toEqual(want);
  });

  // b454: the shared layer (4th argument = its group) is a side column right of the stack.
  it.each([
    ['no shared layer', [1, -1, 0, 0, 1, 1, 0], 2, -1],
    ['a shared layer with no member', [1, -1, 0, 0, 1], 3, 2],
    ['a shared layer holding every child', [0, 0, 0], 2, 0],
    ['a shared index that is no layer', [1, 0, -1], 2, 5],
  ])('%s: the plain stack, same slots', (_n, groupOf, framed, shared) => {
    expect(arrangeStack(groupOf as number[], framed as number, SLOT, shared as number)).toEqual(arrangeStack(groupOf as number[], framed as number));
  });

  const side = PAD + SLOT.w + FRAME_GAP;   // left edge of the side column next to a one-column stack
  it.each([
    ['the last layer shared: two columns keep it no taller than the one-row stack', [0, 1, 1], 2, 1, [
      { x: PAD, y: top },
      { x: side, y: top },
      { x: side + SLOT.w, y: top },
    ]],
    ['the first layer shared: the next layer moves up, the loose child stays last on the left', [0, 1, -1], 2, 0, [
      { x: side, y: top },
      { x: PAD, y: top },
      { x: PAD, y: top + SLOT.h + FRAME_GAP },
    ]],
  ])('%s', (_n, groupOf, framed, shared, want) => {
    expect(arrangeStack(groupOf as number[], framed as number, SLOT, shared as number).slots).toEqual(want);
  });

  it('a larger stack: the side column is right of every stack slot, top aligned, no taller than the stack, no overlap', () => {
    const groupOf = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, -1, 3, 3, 3];
    const shared = 3;
    const slots = arrangeStack(groupOf, 4, SLOT, shared).slots;
    const sideSlots = slots.filter((_, i) => groupOf[i] === shared);
    const stack = slots.filter((_, i) => groupOf[i] !== shared);
    expect(Math.min(...sideSlots.map((s) => s.x))).toBeGreaterThanOrEqual(Math.max(...stack.map((s) => s.x + SLOT.w)) + FRAME_GAP);
    expect(Math.min(...sideSlots.map((s) => s.y))).toBe(top);
    expect(Math.max(...sideSlots.map((s) => s.y))).toBeLessThanOrEqual(Math.max(...stack.map((s) => s.y)));
    slots.forEach((a, i) => slots.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
  });
});

describe('frameSlots (SR2 b457): the boxes of a hand-placed subregion', () => {
  const frame = { x: 100, y: 200, w: 2 * SLOT.w + PAD + 40, h: 400 };   // room for 2 columns: 70 to spare, 35 each side
  it.each([
    ['3 boxes: 2 columns centred across the frame, the last row centred, the first row FRAME_HEAD below the top', 3, frame, [
      { x: 135, y: 240 },
      { x: 135 + SLOT.w, y: 240 },
      { x: 135 + SLOT.w / 2, y: 240 + SLOT.h },
    ], 400],
    ['1 box in a wide frame: one column, centred', 1, frame, [{ x: 100 + (frame.w - SLOT.w) / 2, y: 240 }], 400],
    ['a frame narrower than a slot: one column; too low for 2 rows, it grows downward (Q4)', 2, { x: 0, y: 50, w: 200, h: 100 }, [
      { x: -50, y: 90 },
      { x: -50, y: 90 + SLOT.h },
    ], FRAME_HEAD + 2 * SLOT.h + PAD / 2],
    ['no box: no slot, the frame height kept', 0, frame, [], 400],
  ])('%s', (_n, count, f, slots, h) => {
    expect(frameSlots(count as number, f as typeof frame)).toEqual({ slots, h });
  });
});

describe('arrangeSlots / regionFromSlots / fitScale', () => {
  it('is deterministic', () => {
    for (const n of [0, 1, 2, 7, 12, 50, 381]) {
      expect(arrangeSlots(n)).toEqual(arrangeSlots(n));
    }
  });

  it('keeps the bean size constant: BEAN 170x64 inside SLOT 300x150 with spare room', () => {
    expect(BEAN).toEqual({ w: 170, h: 64 });
    expect(SLOT).toEqual({ w: 300, h: 150 });
    expect(SLOT.w - BEAN.w).toBeGreaterThanOrEqual(60);
    expect(SLOT.h - BEAN.h).toBeGreaterThanOrEqual(60);
  });

  it('region fits its children plus padding, and slots do not overlap', () => {
    for (const n of [1, 2, 3, 7, 12, 50, 381]) {
      const slots = arrangeSlots(n).slots;
      const { w: W, h: H } = regionFromSlots(slots);
      for (const s of slots) {
        expect(s.x).toBeGreaterThanOrEqual(PAD);
        expect(s.y).toBeGreaterThanOrEqual(HEAD + PAD);
        expect(s.x + SLOT.w).toBeLessThanOrEqual(W - PAD);
        expect(s.y + SLOT.h).toBeLessThanOrEqual(H - PAD);
      }
      if (n <= 50) {
        for (let i = 0; i < slots.length; i++) {
          for (let j = i + 1; j < slots.length; j++) {
            expect(overlaps(slots[i], slots[j])).toBe(false);
          }
        }
      }
    }
  });

  it('region is computed from the slots only (same result on repeat)', () => {
    for (const n of [1, 2, 3, 7, 12, 50, 381]) {
      const slots = arrangeSlots(n).slots;
      expect(regionFromSlots(slots)).toEqual(regionFromSlots(slots));
    }
  });

  it('regionFromSlots works for hand-made slots (any arranger)', () => {
    const row2 = [{ x: PAD, y: HEAD + PAD }, { x: PAD + SLOT.w, y: HEAD + PAD }];
    expect(regionFromSlots(row2)).toEqual({ w: 660, h: 254 });
    const L = [
      { x: PAD, y: HEAD + PAD },
      { x: PAD, y: HEAD + PAD + SLOT.h },
      { x: PAD + SLOT.w, y: HEAD + PAD + SLOT.h },
    ];
    expect(regionFromSlots(L)).toEqual({ w: 660, h: 404 });
    expect(regionFromSlots([])).toEqual({ w: 300, h: 150 });
  });

  it('381-child fan-out lands near the target aspect', () => {
    const slots = arrangeSlots(381).slots;
    const { w, h } = regionFromSlots(slots);
    console.log(`381 fan-out region: w=${w} h=${h} ratio/target=${(w / h / TARGET_ASPECT).toFixed(4)}`);
    expect(w / h / TARGET_ASPECT).toBeGreaterThanOrEqual(0.85);
    expect(w / h / TARGET_ASPECT).toBeLessThanOrEqual(1.15);
    expect(slots.length).toBe(381);
    expect(fitScale(w, h)).toBeLessThan(0.1);
  });

  it('empty and single-child regions', () => {
    expect(arrangeSlots(0)).toEqual({ slots: [] });
    expect(regionFromSlots([])).toEqual({ w: 300, h: 150 });
    expect(fitScale(300, 150)).toBe(1);
    const one = regionFromSlots(arrangeSlots(1).slots);
    expect(one.w).toBe(360);
    expect(one.h).toBe(254);
  });

  it('last row is centred', () => {
    // 5 children: 2 columns x 3 rows (score 0.296 beats 3 columns at 0.395). Full rows use x = PAD and PAD + SLOT.w;
    // the single last-row slot is centred at PAD + SLOT.w / 2, so 3 distinct x values in total.
    const slots5 = arrangeSlots(5).slots;
    expect(new Set(slots5.map(s => s.x)).size).toBe(3);
    expect(new Set(slots5.map(s => s.y)).size).toBe(3);
    const lastRow = slots5.filter(s => s.y === HEAD + PAD + 2 * SLOT.h);
    expect(lastRow).toHaveLength(1);
    expect(lastRow[0].x).toBe(PAD + SLOT.w / 2);
  });

  it('last row of 7 is symmetric around the region centre', () => {
    const slots = arrangeSlots(7).slots;
    const { w: W } = regionFromSlots(slots);
    const maxY = Math.max(...slots.map(s => s.y));
    const lastRow = slots.filter(s => s.y === maxY);
    const xFirst = Math.min(...lastRow.map(s => s.x));
    const xLast = Math.max(...lastRow.map(s => s.x));
    expect(xFirst).toBe(W - (xLast + SLOT.w));
  });

  it('regionScale leaves GAP on each side of the slot', () => {
    expect(regionScale(360, 254)).toBeCloseTo(0.4724, 3);
    expect(regionScale(960, 554)).toBeCloseTo(0.2166, 3);
    for (const [w, h] of [[360, 254], [960, 554]]) {
      const k = regionScale(w, h);
      expect(k * w).toBeLessThanOrEqual(SLOT.w - 2 * GAP + 1e-9);
      expect(k * h).toBeLessThanOrEqual(SLOT.h - 2 * GAP + 1e-9);
    }
  });

  it('regionScaleFor: wide regions keep the GAP margin, tall ones are never narrower than a bean', () => {
    expect(regionScaleFor(360, 254)).toBeCloseTo(regionScale(360, 254), 9);
    expect(regionScaleFor(960, 554)).toBeCloseTo(0.2166, 3);
    expect(regionScaleFor(660, 554)).toBeCloseTo(BEAN.w / 660, 9);
    expect(regionScaleFor(660, 554)).toBeCloseTo(0.2576, 3);
    for (const [w, h] of [[360, 254], [960, 554], [660, 554]]) {
      const k = regionScaleFor(w, h);
      expect(k * w).toBeGreaterThanOrEqual(BEAN.w - 1e-9);
      expect(k).toBeLessThanOrEqual(fitScale(w, h) + 1e-9);
    }
  });
});
