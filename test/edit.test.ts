import * as path from 'path';
import { buildView } from '../src/page/html';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const E = require('../viewer/edit.js');

type N = any;
const mk = (id: string, x: number, y: number, w: number, h: number, children: N[] = [], headerH = 100): N => {
  const n: N = { id, x, y, w, h, headerH, children, bubble: { x: x + (w - 40) / 2, y: y + (h - 20) / 2, w: 40, h: 20 } };
  children.forEach(c => { c.parent = n; });
  return n;
};
// root(0,0,1000,1000) > A(100,200,400,400) > [a1(150,320,100,100), a2(300,320,100,100)] ; B(600,200,200,200)
function tree() {
  const a1 = mk('a1', 150, 320, 100, 100);
  const a2 = mk('a2', 300, 320, 100, 100);
  const A = mk('A', 100, 200, 400, 400, [a1, a2]);
  const B = mk('B', 600, 200, 200, 200);
  const root = mk('root', 0, 0, 1000, 1000, [A, B]);
  return { root, A, B, a1, a2 };
}
const cam = { s: 2, tx: 0, ty: 0 };
const rect = (n: N) => ({ x: n.x, y: n.y, w: n.w, h: n.h });

describe('edit.js pure math', () => {
  test('moving a node moves every descendant (region + bubble) by the same delta', () => {
    const t = tree();
    const before = [t.A, t.a1, t.a2].map(n => ({ r: rect(n), b: { ...n.bubble } }));
    const op = { type: 'move', n: t.A, start: { x: 0, y: 0 }, r0: rect(t.A) };
    E.applyDrag(op, { x: 60, y: -20 }, cam); // world delta (30, -10)
    [t.A, t.a1, t.a2].forEach((n, i) => {
      expect(n.x).toBe(before[i].r.x + 30);
      expect(n.y).toBe(before[i].r.y - 10);
      expect(n.w).toBe(before[i].r.w);
      expect(n.bubble.x).toBe(before[i].b.x + 30);
      expect(n.bubble.y).toBe(before[i].b.y - 10);
    });
    expect(t.B.x).toBe(600); // sibling untouched
  });

  test('resize stops at minRegion (bubble + children + padding) and recentres the bubble', () => {
    const t = tree();
    const m = E.minRegion(t.A);
    // children right edge 400, pad = 100*0.3 = 30 -> 430 - 100 = 330 ; bottom 420+30-200 = 250 ; bubble 60x40
    expect(m).toEqual({ w: 330, h: 250 });
    const op = { type: 'resize', n: t.A, rx: true, ry: true, start: { x: 0, y: 0 }, r0: rect(t.A) };
    E.applyDrag(op, { x: -2000, y: -2000 }, cam);
    expect(t.A.w).toBe(330);
    expect(t.A.h).toBe(250);
    expect(t.A.bubble.x).toBe(t.A.x + (330 - 40) / 2);
    E.applyDrag(op, { x: 100, y: 0 }, cam); // grow w by 50 world
    expect(t.A.w).toBe(450);
    expect(t.A.h).toBe(400); // r0.h + 0 (drag is absolute from r0)
  });

  test('a child pushed past its parent edge grows every ancestor; ancestors never shrink', () => {
    const t = tree();
    const op = { type: 'move', n: t.a2, start: { x: 0, y: 0 }, r0: rect(t.a2) };
    E.applyDrag(op, { x: 400, y: 0 }, cam); // +200 world: a2 right = 600 > A right 500
    expect(t.A.x + t.A.w).toBe(600 + 30);
    expect(t.A.x).toBe(100);
    expect(t.root.x + t.root.w).toBe(1000); // still contains everything, not changed
    // move back: parent must not shrink
    const w = t.A.w;
    E.applyDrag({ ...op, r0: rect(t.a2) }, { x: -100, y: 0 }, cam);
    expect(t.A.w).toBeGreaterThanOrEqual(w);
    // grow to the left/top too
    const op2 = { type: 'move', n: t.a1, start: { x: 0, y: 0 }, r0: rect(t.a1) };
    E.applyDrag(op2, { x: -1000, y: -1000 }, cam); // -500 world
    expect(t.A.x).toBe(t.a1.x - 30);
    expect(t.A.y).toBe(t.a1.y - 100 - 30);
  });

  describe('editTarget', () => {
    const setup = () => {
      const t = tree();
      // screen rects at cam s=2: _R = region * 2
      [t.root, t.A, t.B, t.a1, t.a2].forEach((n: N) => { n._R = { x: n.x * 2, y: n.y * 2, w: n.w * 2, h: n.h * 2 }; });
      [t.root, t.A].forEach((n: N) => { n._tv = 1; });
      [t.B, t.a1, t.a2].forEach((n: N) => { n._tv = 0; });
      return t;
    };
    test('resize within 8px of an open region right edge, bottom edge and corner', () => {
      const t = setup(); const open = [t.root, t.A];
      const R = t.A._R;
      expect(E.editTarget({ x: R.x + R.w + 5, y: R.y + 50 }, open, null, cam)).toMatchObject({ type: 'resize', n: t.A, rx: true, ry: false });
      expect(E.editTarget({ x: R.x + 50, y: R.y + R.h - 6 }, open, null, cam)).toMatchObject({ type: 'resize', n: t.A, rx: false, ry: true });
      expect(E.editTarget({ x: R.x + R.w, y: R.y + R.h }, open, null, cam)).toMatchObject({ type: 'resize', rx: true, ry: true });
      expect(E.editTarget({ x: R.x + R.w + 9, y: R.y + 50 }, open, t.root, cam)).toBeNull();
    });
    test('b925: left edge, top edge (outer half only) and all four corners resize; the header below the top grip still moves', () => {
      const t = setup(); const open = [t.root, t.A];
      const R = t.A._R;
      const at = (x: number, y: number, hit: N = null) => E.editTarget({ x, y }, open, hit, cam);
      expect(at(R.x - 5, R.y + 50)).toMatchObject({ type: 'resize', n: t.A, lx: true, ty: false, rx: false, ry: false });
      expect(at(R.x + 100, R.y - 5)).toMatchObject({ type: 'resize', n: t.A, ty: true, lx: false, rx: false, ry: false });
      expect(at(R.x + 100, R.y + 3)).toMatchObject({ type: 'resize', ty: true });
      expect(at(R.x + 100, R.y + 4, t.A)).toMatchObject({ type: 'move', n: t.A }); // the half-way line is the header
      expect(at(R.x + 100, R.y + 10, t.A)).toMatchObject({ type: 'move', n: t.A }); // inner half: header band moves
      expect(at(R.x, R.y)).toMatchObject({ lx: true, ty: true, rx: false, ry: false });
      expect(at(R.x + R.w, R.y)).toMatchObject({ rx: true, ty: true, lx: false, ry: false });
      expect(at(R.x, R.y + R.h)).toMatchObject({ lx: true, ry: true, rx: false, ty: false });
      expect(at(R.x + R.w, R.y + R.h)).toMatchObject({ rx: true, ry: true, lx: false, ty: false });
    });
    test('move on a closed bubble and on an open region header band', () => {
      const t = setup(); const open = [t.root, t.A];
      expect(E.editTarget({ x: 700 * 2 - 150, y: 300 * 2 }, open, t.B, cam)).toEqual({ type: 'moveBubble', n: t.B }); // T1d: closed shape moves only its bubble
      const R = t.A._R;
      expect(E.editTarget({ x: R.x + 50, y: R.y + 100 * 2 - 1 }, open, t.A, cam)).toEqual({ type: 'move', n: t.A });
    });
    test('null on a blueprint body and on the root; a subregion frame moves by its label band, its body pans (SR2)', () => {
      const t = setup(); const open = [t.root, t.A];
      const R = t.A._R;
      expect(E.editTarget({ x: R.x + 50, y: R.y + 100 * 2 + 5 }, open, t.A, cam)).toBeNull();
      expect(E.editTarget({ x: 10, y: 10 }, open, t.root, cam)).toBeNull();
      // frame (110,210,300,100), label band headerH 20 -> screen y 420..460 at s=2
      const L = { id: 'L', kind: 'subregion', parent: t.A, children: [], scale: 1, headerH: 20, x: 110, y: 210, w: 300, h: 100, _R: { x: 220, y: 420, w: 600, h: 200 } };
      expect(E.editTarget({ x: 300, y: 430 }, open, L, cam)).toEqual({ type: 'move', n: L });
      expect(E.editTarget({ x: 300, y: 500 }, open, L, cam)).toBeNull();
      // root's own edge never resizes
      expect(E.editTarget({ x: 2000, y: 500 }, open, null, cam)).toBeNull();
    });
  });
});

describe('edit.js history (undo/redo)', () => {
  const byId = (t: N) => { const m: Record<string, N> = {}; [t.root, t.A, t.B, t.a1, t.a2].forEach((n: N) => { m[n.id] = n; }); return m; };
  const full = (t: N) => JSON.stringify([t.root, t.A, t.B, t.a1, t.a2].map((n: N) => [n.id, n.x, n.y, n.w, n.h, n.bubble]));
  const edit = (t: N, h: N, n: N, dx: number, dy: number) => {
    const before = E.snapshotRects(E.editNodes(n));
    E.applyDrag({ type: 'move', n, start: { x: 0, y: 0 }, r0: rect(n) }, { x: dx * 2, y: dy * 2 }, cam);
    E.pushEdit(h, before, E.snapshotRects(E.editNodes(n)));
  };

  test('editNodes = node + descendants + ancestors', () => {
    const t = tree();
    expect(E.editNodes(t.A).map((n: N) => n.id).sort()).toEqual(['A', 'a1', 'a2', 'root']);
    expect(E.editNodes(t.a1).map((n: N) => n.id).sort()).toEqual(['A', 'a1', 'root']);
  });

  test('undo restores descendants and a grown ancestor exactly; redo reapplies', () => {
    const t = tree(), h = { undo: [], redo: [] }, ids = byId(t);
    const orig = full(t);
    edit(t, h, t.a2, 300, 0); // grows A (and root stays)
    const edited = full(t);
    expect(edited).not.toBe(orig);
    expect(E.undo(h, ids)).toBe(true);
    expect(full(t)).toBe(orig);
    expect(E.redo(h, ids)).toBe(true);
    expect(full(t)).toBe(edited);
    edit(t, h, t.A, -40, 25); // move parent with its children
    const edited2 = full(t);
    E.undo(h, ids); E.undo(h, ids);
    expect(full(t)).toBe(orig);
    expect(E.undo(h, ids)).toBe(false);
    E.redo(h, ids); E.redo(h, ids);
    expect(full(t)).toBe(edited2);
    expect(E.redo(h, ids)).toBe(false);
  });

  test('snapshots are deep copies; undo removes a bubble that did not exist', () => {
    const t = tree(), ids = byId(t);
    const s = E.snapshotRects([t.B]);
    t.B.bubble.x += 5;
    expect(s[0].bubble.x).toBe(t.B.bubble.x - 5);
    const h = { undo: [], redo: [] };
    const nb = E.snapshotRects([t.B]); delete t.B.bubble;
    E.pushEdit(h, nb, E.snapshotRects([t.B]));
    E.undo(h, ids);
    expect(t.B.bubble).toEqual(nb[0].bubble);
  });

  test('a new edit after an undo drops the redo branch', () => {
    const t = tree(), h: N = { undo: [], redo: [] }, ids = byId(t);
    edit(t, h, t.B, 10, 0);
    E.undo(h, ids);
    expect(h.redo.length).toBe(1);
    edit(t, h, t.B, 0, 10);
    expect(h.redo.length).toBe(0);
    expect(E.redo(h, ids)).toBe(false);
  });

  test('the stack stops at 100, dropping the oldest', () => {
    const t = tree(), h: N = { undo: [], redo: [] };
    for (let i = 0; i < 105; i++) edit(t, h, t.B, 1, 0);
    expect(h.undo.length).toBe(100);
    expect(h.undo[0].before.find((r: N) => r.id === 'B').x).toBe(605);
  });
});

describe('exportLayout (P10-T2c)', () => {
  // root=system, A=container, a1/a2=components, B=slice (never exported)
  const setup = () => {
    const t = tree();
    t.root.kind = 'system'; t.A.kind = 'container'; t.a1.kind = 'component'; t.a2.kind = 'component'; t.B.kind = 'slice';
    const flat = [t.root, t.A, t.B, t.a1, t.a2];
    E.growParents(t.a1); // the hand-built tree is slightly inconsistent; settle it so only the edit changes anything
    const orig: N = {};
    flat.forEach(n => { orig[n.id] = { ...rect(n), bubble: { ...n.bubble }, bubbleMoved: false }; });
    const move = (n: N, dx: number, dy: number) =>
      E.applyDrag({ type: 'move', n, start: { x: 0, y: 0 }, r0: rect(n) }, { x: dx * cam.s, y: dy * cam.s }, cam);
    return { t, flat, orig, move };
  };

  test('nothing changed -> version 2 and no nodes', () => {
    const { flat, orig } = setup();
    expect(E.exportLayout(flat, orig)).toEqual({ version: 2, nodes: {} });
  });

  test('moving a component exports its offset from the parent and its size; others absent', () => {
    const { t, flat, orig, move } = setup();
    move(t.a1, 10, 5);
    expect(E.exportLayout(flat, orig)).toEqual({ version: 2, nodes: { a1: { rx: 60, ry: 135, rw: 100, rh: 100 } } });
  });

  test('moving a container lists only the container (children keep their relative offsets)', () => {
    const { t, flat, orig, move } = setup();
    move(t.A, 30, 40);
    expect(E.exportLayout(flat, orig)).toEqual({ version: 2, nodes: { A: { rx: 130, ry: 230, rw: 400, rh: 410 } } });
  });

  test('root uses absolute x,y; values are rounded to integers', () => {
    const { t, flat, orig } = setup();
    t.root.x = 10.4; t.root.w = 1000.6;
    expect(E.exportLayout(flat, orig).nodes.root).toEqual({ rx: 10, ry: 0, rw: 1001, rh: 1000 });
  });

  test('slices and other non-plan kinds are never listed, even when moved or resized; a subregion frame only once placed (SR2)', () => {
    const { t, flat, orig, move } = setup();
    ['file', 'function', 'method', 'class', 'slice'].forEach(k => {
      t.B.kind = k; move(t.B, 7, 7); t.B.w += 9;
      expect(E.exportLayout(flat, orig).nodes.B).toBeUndefined();
    });
    t.B.kind = 'subregion';
    expect(E.exportLayout(flat, orig).nodes.B).toBeUndefined(); // auto frame: follows its components
    t.B.placed = true;
    expect(E.exportLayout(flat, orig).nodes.B).toBeDefined();   // placed frame
  });

  test('a placed bubble exports bx,by; an unplaced one omits them; bubble-only change lists the node', () => {
    const { t, flat, orig } = setup();
    E.applyDrag({ type: 'moveBubble', n: t.a1, start: { x: 0, y: 0 }, r0: rect(t.a1) }, { x: 20, y: 10 }, cam); // +10,+5 world
    expect(E.exportLayout(flat, orig).nodes.a1).toEqual({
      bx: t.a1.bubble.x - t.A.x, by: t.a1.bubble.y - t.A.y, rx: 50, ry: 130, rw: 100, rh: 100,
    });
    t.a2.x += 0; t.a2.w += 10; E.recenterBubble(t.a2); // resized only: no bx,by
    expect(E.exportLayout(flat, orig).nodes.a2).toEqual({ rx: 200, ry: 130, rw: 110, rh: 100 });
  });
});

describe('edit.js independent bubble position (P10-T1d)', () => {
  const bubbleOp = (n: N) => ({ type: 'moveBubble', n, start: { x: 0, y: 0 }, r0: rect(n) });

  test('closed-bubble drag moves only that bubble, sets bubbleMoved, region and descendants untouched', () => {
    const t = tree();
    const regionsBefore = [t.A, t.a1, t.a2].map(rect), a1b = { ...t.a1.bubble };
    const ab = { ...t.A.bubble };
    E.applyDrag(bubbleOp(t.A), { x: 20, y: -10 }, cam); // world (10,-5)
    expect(t.A.bubble.x).toBe(ab.x + 10);
    expect(t.A.bubble.y).toBe(ab.y - 5);
    expect(t.A.bubbleMoved).toBe(true);
    expect([t.A, t.a1, t.a2].map(rect)).toEqual(regionsBefore);
    expect(t.a1.bubble).toEqual(a1b);
    expect(t.a1.bubbleMoved).toBeUndefined();
    // absolute from the start: dragging again to the origin restores the position
    const op = bubbleOp(t.B);
    E.applyDrag(op, { x: 100, y: 0 }, cam); E.applyDrag(op, { x: 0, y: 0 }, cam);
    expect(t.B.bubble.x).toBe(600 + (200 - 40) / 2);
  });

  test('region-header move carries the node bubble with it (offset kept) and descendants', () => {
    const t = tree();
    t.A.bubble.x += 15; t.A.bubbleMoved = true;
    const off = { x: t.A.bubble.x - t.A.x, y: t.A.bubble.y - t.A.y }, a1b = { ...t.a1.bubble };
    E.applyDrag({ type: 'move', n: t.A, start: { x: 0, y: 0 }, r0: rect(t.A) }, { x: 40, y: 20 }, cam); // (20,10)
    expect(t.A.bubble.x - t.A.x).toBe(off.x);
    expect(t.A.bubble.y - t.A.y).toBe(off.y);
    expect(t.a1.bubble.x).toBe(a1b.x + 20);
    expect(t.A.bubbleMoved).toBe(true);
  });

  test('resize re-centres an unplaced bubble but keeps a placed bubble offset (clamped inside)', () => {
    const t = tree();
    const op = (n: N) => ({ type: 'resize', n, rx: true, ry: true, start: { x: 0, y: 0 }, r0: rect(n) });
    t.B.bubble.x = t.B.x + 20; t.B.bubble.y = t.B.y + 30; t.B.bubbleMoved = true; // placed, offset (20,30)
    E.applyDrag(op(t.B), { x: 100, y: 100 }, cam); // 200x200 -> 250x250
    expect(t.B.bubble.x - t.B.x).toBe(20);
    expect(t.B.bubble.y - t.B.y).toBe(30);
    E.applyDrag(op(t.A), { x: 100, y: 100 }, cam); // unplaced A re-centres
    expect(t.A.bubble.x).toBe(t.A.x + (t.A.w - 40) / 2);
    // clamp: shrink B so the offset no longer fits
    t.B.bubble.x = t.B.x + 150; t.B.bubble.w = 40;
    E.applyDrag({ ...op(t.B), r0: { ...rect(t.B), w: 200 } }, { x: -2000, y: 0 }, cam); // min width = 60
    expect(t.B.bubble.x + t.B.bubble.w).toBeLessThanOrEqual(t.B.x + t.B.w);
    expect(t.B.bubble.x).toBeGreaterThanOrEqual(t.B.x);
  });

  test('b925: left/top resize keeps the opposite edge, children and bubble in place; clamps at the content; a placed bubble keeps its world position', () => {
    const t = tree();
    const op = (n: N, f: N) => ({ type: 'resize', n, ...f, start: { x: 0, y: 0 }, r0: rect(n) });
    const kids = [t.a1, t.a2].map((k: N) => [rect(k), { ...k.bubble }]);
    E.applyDrag(op(t.A, { lx: true }), { x: -100, y: 0 }, cam); // 50 world left
    expect([t.A.x, t.A.w, t.A.y, t.A.h]).toEqual([50, 450, 200, 400]);
    expect(t.A.x + t.A.w).toBe(500);
    expect(t.A.bubble.x).toBe(50 + (450 - 40) / 2); // unplaced: still centred
    E.applyDrag(op(t.A, { lx: true }), { x: 5000, y: 0 }, cam); // clamp: a1 left 150 - pad 30
    expect([t.A.x, t.A.w]).toEqual([120, 380]);
    E.applyDrag(op(t.A, { ty: true }), { x: 0, y: -100 }, cam);
    expect([t.A.y, t.A.h, t.A.x]).toEqual([150, 450, 120]);
    expect(t.A.y + t.A.h).toBe(600);
    E.applyDrag(op(t.A, { ty: true }), { x: 0, y: 5000 }, cam); // clamp: a1 top 320 - header 100 - pad 30
    expect([t.A.y, t.A.h]).toEqual([190, 410]);
    expect([t.a1, t.a2].map((k: N) => [rect(k), { ...k.bubble }])).toEqual(kids);
    // placed bubble: world position kept, and it limits the origin
    const B = t.B; // (600,200,200,200)
    B.bubble.x = 610; B.bubble.y = 260; B.bubbleMoved = true;
    E.applyDrag(op(B, { lx: true, ty: true }), { x: -200, y: -200 }, cam);
    expect([B.x, B.y, B.w, B.h]).toEqual([500, 100, 300, 300]);
    expect([B.bubble.x, B.bubble.y]).toEqual([610, 260]);
    E.applyDrag(op(B, { lx: true, ty: true }), { x: 5000, y: 5000 }, cam);
    expect([B.x, B.y]).toEqual([610, 260]);
    expect([B.bubble.x, B.bubble.y]).toEqual([610, 260]);
  });

  test('b925: left/top resize never jumps past the start edge when the content is closer than pad (+header)', () => {
    const op = (n: N, f: N) => ({ type: 'resize', n, ...f, start: { x: 0, y: 0 }, r0: rect(n) });
    const t = tree(); // A.y 200, a1 top 320: header 100 + pad 30 would want y <= 190
    t.a1.x = 110; t.a1.bubble.x = 110; // A.x 100, a1 left 110: pad 30 would want x <= 80
    const go = (f: N, dx: number, dy: number) => { const q = tree(); q.a1.x = 110; q.a1.bubble.x = 110; E.applyDrag(op(q.A, f), { x: dx * 2, y: dy * 2 }, cam); return q.A; };
    expect([go({ ty: true }, 0, 0).y, go({ ty: true }, 0, 0).h]).toEqual([200, 400]);
    expect([go({ ty: true }, 0, -20).y, go({ ty: true }, 0, -20).h]).toEqual([180, 420]);
    expect([go({ ty: true }, 0, 20).y, go({ ty: true }, 0, 20).h]).toEqual([200, 400]);
    expect([go({ lx: true }, 0, 0).x, go({ lx: true }, 0, 0).w]).toEqual([100, 400]);
    expect([go({ lx: true }, -20, 0).x, go({ lx: true }, -20, 0).w]).toEqual([80, 420]);
    expect([go({ lx: true }, 20, 0).x, go({ lx: true }, 20, 0).w]).toEqual([100, 400]);
    expect(t.A.y).toBe(200);
  });

  test('childBounds / growParents / minRegion consider each child bubble as well as its region', () => {
    const t = tree();
    t.a2.bubble.x = 900; // user placed far right, outside a2's region and A
    expect(E.childBounds(t.A).x1).toBe(940);
    expect(E.minRegion(t.A).w).toBe(940 + 30 - 100);
    E.applyDrag(bubbleOp(t.a2), { x: 0, y: 0 }, cam); // zero-length drag: bubble stays, growParents runs
    expect(t.A.x + t.A.w).toBe(940 + 30);
    expect(t.A.bubbleMoved).toBeUndefined();
  });

  test('a bubble dragged outside its parent grows the parent (ancestors too)', () => {
    const t = tree();
    E.applyDrag(bubbleOp(t.a2), { x: 2000, y: 0 }, cam); // +1000 world
    expect(t.a2.bubble.x).toBe(1330); // 330 + 1000
    expect(t.A.x + t.A.w).toBe(1330 + 40 + 30); // bubble right + A's padding (headerH 100 * 0.3)
    expect(t.root.x + t.root.w).toBe(1400 + 30);
  });

  test('snapshots, undo and redo include bubbleMoved', () => {
    const t = tree(), h: N = { undo: [], redo: [] };
    const before = E.snapshotRects(E.editNodes(t.a1));
    E.applyDrag(bubbleOp(t.a1), { x: 30, y: 0 }, cam);
    E.pushEdit(h, before, E.snapshotRects(E.editNodes(t.a1)));
    const ids = { root: t.root, A: t.A, B: t.B, a1: t.a1, a2: t.a2 };
    const moved = { ...t.a1.bubble };
    expect(before.find((r: N) => r.id === 'a1').bubbleMoved).toBe(false);
    E.undo(h, ids);
    expect(t.a1.bubbleMoved).toBeUndefined();
    expect(t.a1.bubble.x).toBe(150 + 30);
    E.redo(h, ids);
    expect(t.a1.bubbleMoved).toBe(true);
    expect(t.a1.bubble).toEqual(moved);
  });
});

describe('new two-phase tree (P14-I8): parent-local units, resize grows ancestors (b268)', () => {
  // root (scale 1) > P (container, scale 0.1) > c (component, scale 0.1). World units.
  const newTree = () => {
    const c = mk('c', 1100, 1200, 60, 40);
    const P = mk('P', 1000, 1000, 600, 400, [c], 100);
    const root = mk('root', 0, 0, 4000, 3000, [P], 100);
    root.scale = 1; P.scale = 0.1; c.scale = 0.1;
    root.kind = 'system'; P.kind = 'container'; c.kind = 'component';
    return { root, P, c };
  };
  const snap = (ns: N[]) => {
    const o: N = {};
    ns.forEach(n => { o[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h, bubble: { ...n.bubble }, bubbleMoved: false }; });
    return o;
  };

  test('drag moves the child by dX world; exported bx and rx change by dX/scale in parent-local units', () => {
    const { root, P, c } = newTree();
    const orig = snap([root, P, c]);
    E.applyDrag({ type: 'move', n: c, start: { x: 0, y: 0 }, r0: rect(c) }, { x: 10, y: 4 }, cam); // world (5,2)
    expect(c.x).toBe(1105);
    expect(c.y).toBe(1202);
    const out = E.exportLayout([root, P, c], orig);
    expect(out.nodes.c.bx).toBe(1150); // bubble x (1110 + 5 - 1000) / 0.1
    expect(out.nodes.c.rx).toBe(1200); // slot left (1135 - 15 - 1000) / 0.1
  });

  test('a drag past the parent body is clamped so the slot stays inside; no ancestor changes size', () => {
    const { root, P, c } = newTree();
    E.applyDrag({ type: 'move', n: c, start: { x: 0, y: 0 }, r0: rect(c) }, { x: 4000, y: 0 }, cam); // +2000 world
    const rightEdge = P.x + P.w - 30 * 0.1; // PAD * parent scale
    expect(c.x + c.w / 2 + 300 * 0.1 / 2).toBeCloseTo(rightEdge);
    E.applyDrag({ type: 'move', n: c, start: { x: 0, y: 0 }, r0: rect(c) }, { x: 0, y: -4000 }, cam); // -2000 world
    const topEdge = P.y + P.headerH;
    expect(c.y + c.h / 2 - 150 * 0.1 / 2).toBeCloseTo(topEdge);
    expect([P.x, P.y, P.w, P.h, root.x, root.y, root.w, root.h]).toEqual([1000, 1000, 600, 400, 0, 0, 4000, 3000]);
    expect(c.bubbleMoved).toBe(true);
  });

  // b268: real resize of a new-tree region. P (scale 0.1) holds c; only P's box changes.
  const edgeOf = (n: N) => { n._R = { x: n.x * 2, y: n.y * 2, w: n.w * 2, h: n.h * 2 }; return n._R; };
  const resize = (n: N, rx: boolean, ry: boolean, dx: number, dy: number) =>
    E.applyDrag({ type: 'resize', n, rx, ry, start: { x: 0, y: 0 }, r0: rect(n) }, { x: dx * 2, y: dy * 2 }, cam); // world (dx, dy)

  test('b268: editTarget gives resize grips on an open new-tree region edge', () => {
    const { root, P, c } = newTree();
    [root, c].forEach(edgeOf); const R = edgeOf(P);
    root._tv = 1; P._tv = 1; c._tv = 0;
    expect(E.editTarget({ x: R.x + R.w + 3, y: R.y + 50 }, [root, P], null, cam)).toMatchObject({ type: 'resize', n: P, rx: true, ry: false });
    expect(E.editTarget({ x: R.x + 50, y: R.y + R.h - 3 }, [root, P], null, cam)).toMatchObject({ type: 'resize', n: P, rx: false, ry: true });
  });

  test('b268: right edge changes only w, bottom edge only h; children, x, y and scale stay', () => {
    const { root, P, c } = newTree();
    const kid = { ...rect(c), b: { ...c.bubble }, s: c.scale };
    resize(P, true, false, 100, 50);
    expect([P.x, P.y, P.w, P.h, P.scale]).toEqual([1000, 1000, 700, 400, 0.1]);
    resize(P, false, true, 100, 50);
    expect([P.x, P.y, P.w, P.h]).toEqual([1000, 1000, 700, 450]);
    expect({ ...rect(c), b: c.bubble, s: c.scale }).toEqual(kid);
    expect(P.bubble.x).toBe(1000 + (P.w - 40) / 2); // unplaced bubble recentred
    expect(root.w).toBe(4000);
  });

  test('b268: shrinking stops at the children plus PAD x scale', () => {
    const { P, c } = newTree();
    resize(P, true, true, -5000, -5000);
    expect(P.w).toBeCloseTo(c.x + c.w + 30 * 0.1 - P.x);
    expect(P.h).toBeCloseTo(c.y + c.h + 30 * 0.1 - P.y);
    expect(E.minRegion(P)).toEqual({ w: P.w, h: P.h });
  });

  test('b268: ancestors grow (right/bottom only, top-left fixed) when a child passes their edge, and only then', () => {
    const { root, P, c } = newTree();
    resize(c, true, false, 600, 0); // c right edge -> 1760 > P right 1600
    expect(P.x + P.w).toBeCloseTo(1760 + 30 * 0.1);
    expect([P.x, P.y, P.h]).toEqual([1000, 1000, 400]);
    expect([root.w, root.h]).toEqual([4000, 3000]); // 1763 is inside root: no growth
    resize(P, true, false, 3000, 0); // P right edge -> 4763 > root
    expect(root.w).toBeCloseTo(P.x + P.w + 30);
    expect([root.x, root.y, root.h]).toEqual([0, 0, 3000]);
  });

  test('b268: export gives rw/rh for the node and its grown ancestor; undo and redo restore', () => {
    const { root, P, c } = newTree();
    const nodes = [root, P, c], orig = snap(nodes);
    const ids: N = { root, P, c };
    const before = E.snapshotRects(E.editNodes(c));
    resize(c, true, false, 600, 0);
    const after = E.snapshotRects(E.editNodes(c));
    const out = E.exportLayout(nodes, orig);
    expect(out.nodes.c.rw).toBe(Math.round(660 / 0.1));
    expect(out.nodes.c.rh).toBe(Math.round(40 / 0.1));
    expect(out.nodes.P.rw).toBe(Math.round(763 / 0.1));
    expect(out.nodes.P.rh).toBe(Math.round(400 / 0.1));
    expect(out.nodes.root).toBeUndefined();
    const h = { undo: [] as N[], redo: [] as N[] };
    E.pushEdit(h, before, after);
    E.undo(h, ids);
    expect([c.w, P.w]).toEqual([60, 600]);
    expect(E.exportLayout(nodes, orig)).toEqual({ version: 2, nodes: {} });
    E.redo(h, ids);
    expect([c.w, P.w]).toEqual([660, 763]);
  });

  test('the new-tree root is never editable and never exported', () => {
    const { root, P, c } = newTree();
    const orig = snap([root, P, c]);
    root.bubble.x += 50; root.bubbleMoved = true;
    expect(E.editTarget({ x: 10, y: 10 }, [], root, cam)).toBeNull();
    root._R = { x: 0, y: 0, w: root.w * 2, h: root.h * 2 }; root._tv = 1;
    expect(E.editTarget({ x: root._R.x + root._R.w + 5, y: 500 }, [root], null, cam)).toBeNull();
    expect(E.exportLayout([root, P, c], orig).nodes.root).toBeUndefined();
  });

  test('an unmoved new tree exports nothing', () => {
    const { root, P, c } = newTree();
    expect(E.exportLayout([root, P, c], snap([root, P, c]))).toEqual({ version: 2, nodes: {} });
  });

  test('SLOT and PAD in edit.js equal src/view/arrange.ts (regex the numbers)', () => {
    const fs = require('fs');
    const arrange = fs.readFileSync(path.join(__dirname, '..', 'src/view/arrange.ts'), 'utf8');
    const edit = fs.readFileSync(path.join(__dirname, '..', 'viewer/edit.js'), 'utf8');
    const slot = (src: string) => src.match(/SLOT = \{ w: (\d+), h: (\d+) \}/)!.slice(1, 3);
    const pad = (src: string) => src.match(/PAD = (\d+)/)![1];
    expect(slot(edit)).toEqual(slot(arrange));
    expect(pad(edit)).toBe(pad(arrange));
  });
});

// C1 B2 (b832): at C1 the root is a holder (kind context, n.holder set by map.js buildParents). Its children (the system,
// persons, externals) are top nodes like a root: never moved, resized or exported. The holder itself never grows.
describe('C1 holder (b832)', () => {
  // H (holder, scale 1) > [S (system, open, scale 0.1) > c (component, closed), p (person), x (external)]. World units.
  const holderTree = () => {
    const c = mk('c', 200, 300, 60, 40);
    const S = mk('S', 100, 100, 1500, 1200, [c], 100);
    const p = mk('p', 1700, 100, 100, 80);
    const x = mk('x', 1700, 400, 100, 80);
    const H = mk('H', 0, 0, 2000, 1500, [S, p, x], 0);
    H.kind = 'context'; H.holder = true; S.kind = 'system'; c.kind = 'component'; p.kind = 'person'; x.kind = 'external';
    H.scale = 1; S.scale = 0.1; c.scale = 0.1; p.scale = 0.1; x.scale = 0.1;
    [H, S, c, p, x].forEach(n => { n._R = { x: n.x * 2, y: n.y * 2, w: n.w * 2, h: n.h * 2 }; });
    H._tv = 1; S._tv = 1; c._tv = 0; p._tv = 0; x._tv = 0;
    return { H, S, c, p, x, all: [H, S, c, p, x] };
  };
  const snapOf = (ns: N[]) => {
    const o: N = {};
    ns.forEach(n => { o[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h, bubble: { ...n.bubble }, bubbleMoved: false }; });
    return o;
  };

  test('isTop: a root and a holder child are top nodes; a component is not', () => {
    const { H, S, c, p, x } = holderTree();
    expect([H, S, p, x].map(E.isTop)).toEqual([true, true, true, true]);
    expect(E.isTop(c)).toBe(false);
  });

  test('editTarget: no grip and no header move on the system; no move on a person or an external; the component still moves', () => {
    const { S, c, p, x } = holderTree();
    const R = S._R;
    expect(E.editTarget({ x: R.x + R.w + 3, y: R.y + 50 }, [S], null, cam)).toBeNull();         // right edge
    expect(E.editTarget({ x: R.x + 50, y: R.y + R.h - 3 }, [S], null, cam)).toBeNull();         // bottom edge
    expect(E.editTarget({ x: R.x + 50, y: R.y + 10 }, [S], S, cam)).toBeNull();                 // header band
    expect(E.editTarget({ x: p._R.x + 5, y: p._R.y + 5 }, [S], p, cam)).toBeNull();
    expect(E.editTarget({ x: x._R.x + 5, y: x._R.y + 5 }, [S], x, cam)).toBeNull();
    expect(E.editTarget({ x: c._R.x + 5, y: c._R.y + 5 }, [S], c, cam)).toMatchObject({ type: 'moveBubble', n: c });
  });

  test('exportLayout: a moved system or person is never exported (new and old tree); a moved component is', () => {
    const { S, c, p, all } = holderTree();
    const orig = snapOf(all);
    [S, p].forEach(n => { n.x += 40; n.y += 20; n.bubble.x += 40; n.bubble.y += 20; });
    let out = E.exportLayout(all, orig);
    expect(out.nodes.S).toBeUndefined();
    expect(out.nodes.p).toBeUndefined();
    c.x += 30; c.bubble.x += 30;
    out = E.exportLayout(all, orig);
    expect(Object.keys(out.nodes)).toEqual(['c']);
    all.forEach(n => { delete n.scale; });                                  // old tree: rel() path
    out = E.exportLayout(all, orig);
    expect(Object.keys(out.nodes)).toEqual(['c']);
  });

  test('growParents: the component grown past the system grows the system; the holder never changes', () => {
    const { H, S, c } = holderTree();
    E.applyDrag({ type: 'resize', n: c, rx: true, ry: false, start: { x: 0, y: 0 }, r0: rect(c) }, { x: 4000, y: 0 }, cam); // +2000 world
    expect(c.x + c.w).toBe(2260);                                            // past S (1600) and past H (2000)
    expect(S.x + S.w).toBeCloseTo(2260 + 30 * 0.1);
    expect([H.x, H.y, H.w, H.h]).toEqual([0, 0, 2000, 1500]);
    expect(E.editNodes(c)).toEqual([c, S]);                                  // undo history stops at the holder too
  });
});

describe('subregion frames (SR2): move carries members, resize, footprint clamp, placed, undo, export', () => {
  // root (scale 1) > C (container, scale 0.1, body y 1100..1797 x 1003..1997) > a, b (subregion L), c (subregion M).
  // Frames carry the container's scale (server contract) and a label band headerH 4. Slot = 30 x 15 world.
  const frameTree = () => {
    const a = mk('a', 1100, 1200, 20, 10); a.subregion = 'L';
    const b = mk('b', 1200, 1200, 20, 10); b.subregion = 'L';
    const c = mk('c', 1100, 1500, 20, 10); c.subregion = 'M';
    const C = mk('C', 1000, 1000, 1000, 800, [a, b, c], 100);
    const root = mk('root', 0, 0, 4000, 3000, [C], 100);
    const frame = (id: string): N => ({ id, kind: 'subregion', parent: C, scale: 0.1, headerH: 4, x: 0, y: 0, w: 0, h: 0 });
    const L = frame('L'), M = frame('M');
    C.subregions = [L, M];
    root.scale = 1; C.scale = 0.1; [a, b, c].forEach(k => { k.scale = 0.1; k.kind = 'component'; });
    root.kind = 'system'; C.kind = 'container';
    E.placeFrames(C); // auto: L (1001.5, 1193.5, 997, 17.5), M (1001.5, 1493.5, 997, 17.5)
    return { root, C, a, b, c, L, M };
  };
  const placeL = (L: N) => Object.assign(L, { x: 1050, y: 1180, w: 300, h: 50, placed: true }); // as the server sets a saved frame
  const moveOp = (n: N) => ({ type: 'move', n, start: { x: 0, y: 0 }, r0: rect(n) });
  const drag = (op: N, dx: number, dy: number) => E.applyDrag(op, { x: dx * cam.s, y: dy * cam.s }, cam); // world (dx, dy)
  const resize = (n: N, rx: boolean, ry: boolean, dx: number, dy: number) =>
    drag({ type: 'resize', n, rx, ry, start: { x: 0, y: 0 }, r0: rect(n) }, dx, dy);
  const ids = (ns: N[]) => ns.map((n: N) => n.id).sort();

  test('moveNew on a frame moves the frame and every member by one delta; others stay; repeated calls are absolute', () => {
    const { C, a, b, c, L } = frameTree();
    placeL(L);
    const op = moveOp(L);
    drag(op, 100, 200);
    expect(rect(L)).toEqual({ x: 1150, y: 1380, w: 300, h: 50 });
    expect([a.x, a.y, b.x, b.y]).toEqual([1200, 1400, 1300, 1400]);
    expect(a.bubble.x).toBe(1090 + 100); // members move as a whole (bubble too)
    expect([c.x, c.y]).toEqual([1100, 1500]);
    expect(rect(C)).toEqual({ x: 1000, y: 1000, w: 1000, h: 800 });
    drag(op, 150, 200); // same drag, pointer further: absolute from r0
    expect([L.x, a.x, b.x]).toEqual([1200, 1250, 1350]);
  });

  test('the clamp keeps the frame and its member slots inside the container body (footprint)', () => {
    const { C, b, L } = frameTree();
    placeL(L);
    b.x = 1900; // member outside the frame: slot 1895..1925
    expect(E.footprint(L)).toEqual({ x: 1050, y: 1180, w: 1925 - 1050, h: 50 });
    drag(moveOp(L), 500, 0); // the frame alone could go +500; its member's slot stops it at +72
    expect(L.x).toBeCloseTo(1122);
    expect(b.x + b.w / 2 + 300 * 0.1 / 2).toBeCloseTo(C.x + C.w - 30 * 0.1);
    drag(moveOp(L), -2000, -2000);
    expect(L.x).toBeCloseTo(C.x + 30 * 0.1);
    expect(L.y).toBeCloseTo(C.y + C.headerH);
    expect(rect(C)).toEqual({ x: 1000, y: 1000, w: 1000, h: 800 });
  });

  test('placed is set by a frame move and by a frame resize, never by a box move; an auto frame moves without a jump', () => {
    const { a, c, L, M } = frameTree();
    expect([L.placed, M.placed]).toEqual([undefined, undefined]);
    drag(moveOp(L), 0, 50); // auto L spans the container width (half a PAD in): it moves down, not sideways
    expect([L.x, L.y, a.y]).toEqual([1001.5, 1243.5, 1250]);
    expect(L.placed).toBe(true);
    resize(M, true, false, -500, 0);
    expect(M.w).toBeCloseTo(497);
    expect(M.placed).toBe(true);
    drag(moveOp(c), 10, 0);
    expect(c.placed).toBeUndefined();
    expect(c.bubbleMoved).toBe(true);
  });

  test('resize keeps the members where they are and stops at minRegion; past the container edge it grows the container', () => {
    const { root, C, a, b, L } = frameTree();
    placeL(L);
    const kids = [a, b].map(rect);
    resize(L, true, true, -5000, -5000);
    expect([L.x, L.y]).toEqual([1050, 1180]);
    expect(L.w).toBeCloseTo(300 * 0.1 / 2);
    expect(L.h).toBeCloseTo(4 + 30 * 0.1);
    expect(E.minRegion(L)).toEqual({ w: L.w, h: L.h });
    expect([a, b].map(rect)).toEqual(kids);
    expect(rect(C)).toEqual({ x: 1000, y: 1000, w: 1000, h: 800 });
    resize(L, true, false, 1000, 0); // right edge -> 2065, past C (2000)
    expect(C.x + C.w).toBeCloseTo(2065 + 30 * 0.1);
    expect([C.x, C.y, C.h, root.w]).toEqual([1000, 1000, 800, 4000]);
  });

  test('b925: a frame resized from its left/top keeps its members, stops at minRegion and is placed', () => {
    const { a, b, L } = frameTree();
    L.x = 1050; L.y = 1180; L.w = 300; L.h = 50; // unplaced: the resize must set placed
    const kids = [a, b].map(rect);
    drag({ type: 'resize', n: L, lx: true, ty: true, start: { x: 0, y: 0 }, r0: rect(L) }, 5000, 5000);
    expect(L.placed).toBe(true);
    expect([L.x + L.w, L.y + L.h]).toEqual([1350, 1230]); // right/bottom edges stay
    expect(L.w).toBeCloseTo(E.minRegion(L).w);
    expect(L.h).toBeCloseTo(E.minRegion(L).h);
    expect([a, b].map(rect)).toEqual(kids);
  });

  test('editNodes(frame) includes the members; editNodes(container) includes its frames', () => {
    const { C, L } = frameTree();
    expect(ids(E.editNodes(L))).toEqual(['C', 'L', 'a', 'b', 'root']);
    expect(ids(E.editNodes(C))).toEqual(['C', 'L', 'M', 'a', 'b', 'c', 'root']);
  });

  test('undo restores the frame, its members and placed; redo reapplies', () => {
    const t = frameTree(), { a, b, L } = t, h = { undo: [] as N[], redo: [] as N[] };
    const byId: N = {}; Object.values(t).forEach((n: N) => { byId[n.id] = n; });
    const start = [L, a, b].map(rect);
    const before = E.snapshotRects(E.editNodes(L));
    drag(moveOp(L), 0, 60);
    const after = E.snapshotRects(E.editNodes(L));
    E.pushEdit(h, before, after);
    const moved = [L, a, b].map(rect);
    expect(before.find((r: N) => r.id === 'L').placed).toBe(false);
    expect(after.find((r: N) => r.id === 'L').placed).toBe(true);
    E.undo(h, byId);
    expect([L, a, b].map(rect)).toEqual(start);
    expect(L.placed).toBeUndefined();
    E.redo(h, byId);
    expect([L, a, b].map(rect)).toEqual(moved);
    expect(L.placed).toBe(true);
  });

  test('shift(container) carries its placed frames; so does moving the container', () => {
    const { C, a, L } = frameTree();
    placeL(L);
    E.shift(C, 10, 20);
    expect([L.x, L.y, a.x, a.y]).toEqual([1060, 1200, 1110, 1220]);
    drag(moveOp(C), 100, 50);
    expect([L.x, L.y, C.x, C.y]).toEqual([1160, 1250, 1110, 1070]);
  });

  test('placeFrames skips placed frames (a placed shared frame is not the side column)', () => {
    const { C, L, M } = frameTree();
    L.sharedColumn = true;
    E.placeFrames(C); // auto: L is the side column, M ends 2 x inset left of it
    expect(M.w).toBeCloseTo(1095 - 1.5 - 3 - 1001.5);
    placeL(L);
    E.placeFrames(C);
    expect(rect(L)).toEqual({ x: 1050, y: 1180, w: 300, h: 50 });
    expect([M.x, M.y]).toEqual([1001.5, 1493.5]);
    expect(M.w).toBeCloseTo(997);
  });

  test('export: an auto frame is never listed; a placed frame is, in container-local units with no bx,by', () => {
    const t = frameTree(), { a, L, M } = t;
    placeL(L);
    const all = Object.values(t) as N[];
    const orig: N = {}; all.forEach(n => { orig[n.id] = E.rectOf(n); });
    expect(E.exportLayout(all, orig)).toEqual({ version: 2, nodes: {} });
    M.y += 100; // an auto frame that followed its components
    expect(E.exportLayout(all, orig).nodes.M).toBeUndefined();
    drag(moveOp(L), 100, 200);
    const out = E.exportLayout(all, orig);
    expect(out.nodes.L).toEqual({ rx: 2850, ry: 3975, rw: 3000, rh: 500 }); // slot centred on the frame, frame size / 0.1
    expect(Object.keys(out.nodes).sort()).toEqual(['L', 'a', 'b']);
    expect(a.bubbleMoved).toBeUndefined();
  });

  test('rectOf / setRect round-trip region, bubble (deep copy), bubbleMoved and placed', () => {
    const { a, L, M } = frameTree();
    placeL(L);
    const r = E.rectOf(L);
    expect(r).toEqual({ x: 1050, y: 1180, w: 300, h: 50, bubble: null, bubbleMoved: false, placed: true });
    const autoM = E.rectOf(M);
    E.setRect(M, r);
    expect(M.placed).toBe(true);
    E.setRect(M, autoM);
    expect(M.placed).toBeUndefined();
    expect(M.bubble).toBeUndefined();
    const ra = E.rectOf(a);
    expect(ra.bubble).toEqual(a.bubble);
    expect(ra.bubble).not.toBe(a.bubble);
  });
});

describe('edit.js is wired into the generated page', () => {
  test('buildView html contains edit.js before map.js', () => {
    const { html } = buildView({ repo: path.join(__dirname, 'fixtures/sample') });
    expect(html).toContain('C4PM_EDIT');
    expect(html.indexOf('window.C4PM_EDIT = api')).toBeLessThan(html.indexOf('window.C4PM_MAP = {'));
  });
});
