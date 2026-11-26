// sim-flow.js: the flow steps of an s-item at one depth (Phase 25 b853 S2, the flow depth switch). Pure: no DOM, no state.
// A depth is a per-window view of the same steps: consecutive original steps whose boxes at that depth are equal merge
// into one flow step. The server (src/view/simModel.ts buildViewSims, b853 S1) gives each step `at[d]` (its boxes and its
// arrow lanes at depth d) and each s-item `depth[d]` ({ groups: original step indexes per flow step, lanes }); this file
// only assembles the groups into flow steps. The original step index stays the cursor everywhere (C4PM_SIM.step()).
// Loaded just before sim.js (src/page/html.ts VIEWER_SCRIPTS); sim.js and the later sim-*.js files read C4PM_SIMFLOW.
// Spec: the b853 spec, section 1 "FlowStep" and section 3 S2.
//
// A page without s-items (no C4PM_DATA.sims, or an empty list): this file returns at once, C4PM_SIMFLOW stays undefined.
//
// CONTRACT  window.C4PM_SIMFLOW = { DEPTHS, flowSteps, flowIndex, lanesAt, allLanes }
//   DEPTHS          ['context', 'container', 'component', 'code'] (C4 level names, widest first).
//   flowSteps(sim, d, isArch)  -> FlowStep[] of `sim` at depth d; isArch(id) -> boolean says whether a box id is an arch
//                   node (sim.js passes id => has('arch', id)). A sim without steps gives [].
//   flowIndex(flow, i)  -> the index in `flow` of the FlowStep whose members hold original index i; null when i is null
//                   or no FlowStep holds it.
//   lanesAt(sim, d) -> sim.depth[d].lanes, or sim.lanes on the fallback.
//   allLanes(sim)   -> sim.lanes, then every depth's lanes whose id is not listed yet (for names: nameOfId).
//   An unknown depth throws (flowSteps, lanesAt), like C4PM_SIM.act.
// FlowStep = { i, n (0-based / 1-based in the flow at this depth), first, last, members (original indexes, ascending),
//   view (the first member's), views (every member's, in order of first appearance), stage, flow, inFlow, goal, outside
//   (the first member's; an outside step is always alone), targets, rows (every member's, in order, not rolled up), boxes
//   (union of the members' at[d].boxes, in order), archIds (code: the members' arch target nodeIds; else the boxes for
//   which isArch), arrows [{ from, to, label, reply, unverified }] (code: the members' call.from / call.to; else at[d].from
//   / at[d].to, and every arrow whose from === to is dropped there, also in a one-member group: a self-arrow means
//   nothing at context / container / component; at code an arrow inside one box is dropped only when another member's
//   arrow crosses; one per from>to, the first wins), call (null | arrows[0] as { from, to, fromLane, toLane, label,
//   reply }, its lanes = that member's at[d].from / to), captions (the members' captions in order), caption
//   (captions[0]), state (the last member that has one: the state after the group), durationSec (one member:
//   its own; merged: the sum of the members' seconds, 4 for a step without one, as sim-present.js secOf),
//   unverified, unconnected (the first member that has one), missing (union) }.
// A one-member group is a copy of the original step with the keys above set, so at code it equals today's step (apart
// from the added keys, and call.fromLane / toLane = at.code.from / to).
// Fallback: when sim.depth[d] or some step's at[d] is missing, or the groups do not list every step once in order (a
// hand-built or old page): identity groups and lanes = sim.lanes. Every depth then behaves like code, nothing throws.
(function () {
  'use strict';
  const data = window.C4PM_DATA;
  const sims = data && data.sims;
  if (!Array.isArray(sims) || !sims.length) return;   // no s-items: C4PM_SIMFLOW stays undefined

  const DEPTHS = Object.freeze(['context', 'container', 'component', 'code']);
  const DEFAULT_SEC = 4;   // the present seconds of a step without durationSec (sim-present.js DEFAULT_SEC)

  function checkDepth(d) {
    if (DEPTHS.indexOf(d) < 0) throw new Error('C4PM_SIMFLOW: unknown depth ' + d);
  }

  const stepsOf = sim => (sim && Array.isArray(sim.steps) ? sim.steps : []);

  // The server groups of `sim` at d when they can be used: every step has at[d] and the groups list 0..n-1 once, in order.
  function groupsAt(sim, d) {
    const steps = stepsOf(sim);
    const dep = sim && sim.depth && sim.depth[d];
    if (!dep || !Array.isArray(dep.groups)) return null;
    if (!steps.every(st => st && st.at && st.at[d])) return null;
    let next = 0;
    for (const g of dep.groups) {
      if (!Array.isArray(g) || !g.length) return null;
      for (const i of g) if (i !== next++) return null;
    }
    return next === steps.length ? dep.groups : null;
  }

  const pushNew = (list, v) => { if (list.indexOf(v) < 0) list.push(v); };

  // The arrows of a group: each member's arrow ({ ..., fromLane, toLane } kept for `call`). Above code (with at[d]) every
  // self-arrow is dropped; at code (and on the fallback) the inside-one-box ones only when another crosses. One per
  // from>to (the first wins).
  function arrowsOf(members, d, useAt) {
    const all = [];
    const code = !useAt || d === 'code';
    members.forEach(st => {
      if (!st.call) return;
      const at = useAt ? st.at[d] : null;
      all.push({
        from: code ? st.call.from : at.from, to: code ? st.call.to : at.to,
        fromLane: at ? at.from : st.call.fromLane, toLane: at ? at.to : st.call.toLane,
        label: st.call.label, reply: !!st.call.reply, unverified: !!st.unverified,
      });
    });
    const crossing = all.filter(a => a.from !== a.to);
    const keep = crossing.length || !code ? crossing : all;
    const seen = new Set();
    return keep.filter(a => {
      const k = a.from + '>' + a.to;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // One flow step from the original steps `members` (ascending), at flow index k.
  function assemble(members, k, d, useAt, isArch) {
    const first = members[0], last = members[members.length - 1], one = members.length === 1;
    const views = [], boxes = [], archTargets = [];
    members.forEach(st => {
      pushNew(views, st.view);
      if (useAt) st.at[d].boxes.forEach(b => pushNew(boxes, b));
      st.targets.forEach(t => { if (t.view === 'arch' && t.nodeId) pushNew(archTargets, t.nodeId); });
    });
    const code = !useAt || d === 'code';
    const marks = arrowsOf(members, d, useAt);
    const a0 = marks[0];
    const captions = members.map(st => st.caption).filter(c => c);
    const fs = one ? Object.assign({}, first) : {
      view: first.view, stage: first.stage, flow: first.flow, inFlow: first.inFlow, goal: first.goal, outside: first.outside,
    };
    if (!one) {
      Object.keys(fs).forEach(key => { if (fs[key] === undefined) delete fs[key]; });
      fs.targets = [].concat(...members.map(st => st.targets));
      fs.rows = [].concat(...members.map(st => st.rows || []));
      if (captions.length) fs.caption = captions[0];
      const stated = members.slice().reverse().find(st => st.state);
      if (stated) fs.state = stated.state;
      fs.durationSec = members.reduce((sum, st) => sum + (st.durationSec > 0 ? st.durationSec : DEFAULT_SEC), 0);
      const firstHas = key => { const st = members.find(m => m[key]); return st ? st[key] : undefined; };
      ['unverified', 'unconnected'].forEach(key => { const v = firstHas(key); if (v !== undefined) fs[key] = v; });
      const missing = [];
      members.forEach(st => (st.missing || []).forEach(m => pushNew(missing, m)));
      if (missing.length) fs.missing = missing;
    }
    return Object.assign(fs, {
      i: k, n: k + 1, first: first.i, last: last.i, members: members.map(st => st.i), views, boxes,
      archIds: code ? archTargets : boxes.filter(b => isArch(b)),
      arrows: marks.map(a => ({ from: a.from, to: a.to, label: a.label, reply: a.reply, unverified: a.unverified })),
      call: a0 ? { from: a0.from, to: a0.to, fromLane: a0.fromLane, toLane: a0.toLane, label: a0.label, reply: a0.reply } : null,
      captions,
    });
  }

  function flowSteps(sim, d, isArch) {
    checkDepth(d);
    if (typeof isArch !== 'function') throw new Error('C4PM_SIMFLOW.flowSteps: isArch must be a function');
    const steps = stepsOf(sim);
    const groups = groupsAt(sim, d);
    const useAt = groups !== null;
    return (groups || steps.map((_, i) => [i])).map((g, k) => assemble(g.map(i => steps[i]), k, d, useAt, isArch));
  }

  function flowIndex(flow, i) {
    if (i === null || i === undefined || !Array.isArray(flow)) return null;
    const k = flow.findIndex(fs => fs.members.indexOf(i) >= 0);
    return k < 0 ? null : k;
  }

  function lanesAt(sim, d) {
    checkDepth(d);
    const own = (sim && sim.lanes) || [];
    return groupsAt(sim, d) ? sim.depth[d].lanes || own : own;
  }

  function allLanes(sim) {
    const out = ((sim && sim.lanes) || []).slice();
    const ids = new Set(out.map(l => l.id));
    DEPTHS.forEach(d => {
      const dep = sim && sim.depth && sim.depth[d];
      ((dep && dep.lanes) || []).forEach(l => { if (!ids.has(l.id)) { ids.add(l.id); out.push(l); } });
    });
    return out;
  }

  window.C4PM_SIMFLOW = { DEPTHS, flowSteps, flowIndex, lanesAt, allLanes };
})();
