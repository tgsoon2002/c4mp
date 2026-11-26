// link.js: link the selection between the windows of one page (P20-T5-0, b254; T5-H b262 fills it in).
// Loaded after map.js (src/view/html.ts VIEWER_SCRIPTS), so it can subscribe to C4PM_MAP.onSelect and C4PM_MODE.onChange at load.
//
// CONTRACT  window.C4PM_LINK = { status, send, light, on, post, id, peers, onPeers }
//   status()  -> string shown under the 'Window link' row of the settings popup (settings.js DEF.link.status, drawn by
//                controls.js buildSettings each time the popup opens):
//                'off' | 'not available (each window works alone)' | 'no other window yet' | '<n> other window(s)'.
//   send(id)  tell the other windows that node `id` (or null) is selected (message type 'sel'). No-op while the link is
//                off or not available. The C4PM_MAP.onSelect subscription below calls it for every local selection.
//   light(ids) tell the other windows to light arch nodes `ids` (message type 'light', b130); same no-op rule as send.
//   on(type, fn) Phase 25 (UI3): fn(message) for every message of `type` another window posts (after the peer count).
//   post(type, payload, opts?) UI3: send a message of `type` carrying the payload's fields (type / from / view override
//                same-named payload fields); same no-op rule as send. opts.replay: remember this payload as the last of its
//                type and re-send it to a window that says hello later (as 'light' does). The four built-in types
//                (hello, bye, sel, light) are not free: on / post throw for them. A type nobody registered is dropped.
//                Used by sim.js: type 'sim', payload { sim: s-id | null, step: 0-based index | null }, replayed.
//   id()      UI17 (b767): this window's random link id (the `from` of its messages).
//   peers()   UI17: the other windows, [{ id, view: their C4PM_MODE view | null, map: false for a window that shows no map }]
//                sorted by id (a copy). Learnt from every accepted message (hello / sel / light / a registered type), minus bye.
//   onPeers(fn) UI17: fn() after any change of the peer list or of a peer's view / map; throws when fn is not a function.
//   The setting itself (C4PM_SETTINGS 'link', on|off, default on) is defined in settings.js; set 'off' closes the
//   channel, clears the remote light and the peer count; set 'on' opens it again.
//
// P20-T5-H (b262). Channel 'c4pm-link:' + C4PM_DATA.repoPath (pages of different repos never talk).
// Message { type: 'hello'|'bye'|'sel'|'light'|<a type registered with on()>, ids (light only): node ids, from: this window's random id, view: C4PM_MODE.get(), id: node id|null }.
//   UI17: the sequence-only window (hash part '&seqonly', UI14) adds map: false to every message; other windows add no map key.
//   'hello' on open and on every mode change; a hello from a window not yet counted is answered by one hello (so both
//   sides count each other); 'bye' on pagehide and on setting off. Peers = the distinct `from` ids seen via hello/sel, minus bye.
//   A received 'sel' lights the id with C4PM_MAP.setHighlight([id]) (never takes the local selection); null clears the
//   light; an id unknown in this window's current tree is ignored. The remote light shares map.hi with the board item
//   light: the last one set wins, and a mode switch (loadTree) clears it.
// No BroadcastChannel, or its constructor throws -> status 'not available', nothing else changes: the one tolerated catch.
(function () {
  const WIN = Math.random().toString(36).slice(2, 11);
  const peers = new Map();   // UI17: id -> { view, map }
  const peerFns = [];        // UI17: fn() registered with onPeers, called after any change of peers
  // UI17: the sequence-only window (UI14) shows no map: its messages say map:false
  const NO_MAP = (window.location && window.location.hash || '').split('&').slice(1).indexOf('seqonly') >= 0;
  let channel = null;      // the open BroadcastChannel, else null
  let lastLight = null;    // b130: ids of the last 'light' sent, re-sent to a window that says hello later
  let available = true;    // false once a channel could not be made
  const handlers = {};     // Phase 25 (UI3): generic type -> [fn(message)], registered with on()
  const replay = {};       // UI3: generic type -> the last payload posted with { replay: true }, re-sent to a window that joins later
  const RESERVED = ['hello', 'bye', 'sel', 'light'];
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const enabled = () => window.C4PM_SETTINGS.get('link') === 'on';

  // UI17: message `o` with map: false added in the sequence-only window; no map key otherwise.
  function stamp(o) {
    if (NO_MAP) o.map = false;
    return o;
  }

  // UI17: tell the onPeers listeners that the peer list or a peer's view / map changed.
  function peersChanged() {
    peerFns.forEach(fn => fn());
  }

  function post(type, id) {
    if (!channel) return;
    channel.postMessage(stamp({ type, from: WIN, view: window.C4PM_MODE.get(), id: id === undefined ? null : id }));
  }

  function postIds(type, ids) {
    if (!channel) return;
    channel.postMessage(stamp({ type, from: WIN, view: window.C4PM_MODE.get(), id: null, ids }));
  }

  // UI3: a generic message: the payload's fields, then type / from / view (those three always win).
  function postData(type, payload) {
    if (!channel) return;
    channel.postMessage(stamp(Object.assign({}, payload, { type, from: WIN, view: window.C4PM_MODE.get() })));
  }

  function checkType(fnName, type) {
    if (typeof type !== 'string' || !type || RESERVED.indexOf(type) >= 0) {
      throw new Error('C4PM_LINK.' + fnName + ': ' + JSON.stringify(type) + ' is not a free message type');
    }
  }

  function onMessage(ev) {
    const d = ev && ev.data;
    if (!d || d.from === WIN) return;
    if (d.type === 'bye') { if (peers.delete(d.from)) peersChanged(); return; }
    // Phase 25 (UI3): a generic type registered with on() is accepted too; any other type is dropped.
    if (d.type !== 'hello' && d.type !== 'sel' && d.type !== 'light' && !own(handlers, d.type)) return;
    const fresh = !peers.has(d.from);
    const was = peers.get(d.from);
    const now = { view: d.view || null, map: d.map !== false };   // UI17
    peers.set(d.from, now);
    if (fresh || was.view !== now.view || was.map !== now.map) peersChanged();
    if (d.type === 'hello' && fresh) {
      post('hello');
      if (lastLight) postIds('light', lastLight);   // b130: a new window gets the last light
      Object.keys(replay).forEach(type => postData(type, replay[type]));   // UI3: and the last payload of every replayed type
    }
    if (d.type === 'light') {
      // b130: ids unknown in this tree are dropped; none known (and some sent) = ignored, like 'sel'; an empty list clears
      const ids = (Array.isArray(d.ids) ? d.ids : []).filter(id => window.C4PM_MAP.nodeById(id));
      if (ids.length || !(Array.isArray(d.ids) && d.ids.length)) window.C4PM_MAP.setHighlight(ids);
    }
    if (d.type === 'sel') {
      if (d.id === null || d.id === undefined) window.C4PM_MAP.setHighlight([]);
      else if (window.C4PM_MAP.nodeById(d.id)) window.C4PM_MAP.setHighlight([d.id]);
    }
    if (own(handlers, d.type)) handlers[d.type].forEach(fn => fn(d));   // UI3: generic handlers, after the peer count
  }

  function open() {
    if (channel) return;
    try {
      if (typeof BroadcastChannel !== 'function') throw new Error('no BroadcastChannel');
      channel = new BroadcastChannel('c4pm-link:' + (window.C4PM_DATA.repoPath || window.C4PM_DATA.title || ''));   // b914: repoPath '' on a source-less page
      channel.onmessage = onMessage;
      available = true;
    } catch (err) {
      channel = null;
      available = false;   // each window works alone
      return;
    }
    post('hello');
  }

  function close() {
    if (!channel) return;
    post('bye');
    channel.close();
    channel = null;
    const had = peers.size > 0;
    peers.clear();
    window.C4PM_MAP.setHighlight([]);
    if (had) peersChanged();   // UI17
  }

  window.C4PM_LINK = {
    status() {
      if (!enabled()) return 'off';
      if (!available) return 'not available (each window works alone)';
      if (!peers.size) return 'no other window yet';
      return peers.size + ' other window' + (peers.size > 1 ? 's' : '');
    },
    send(id) { post('sel', id || null); },
    // b130: light arch nodes `ids` in the other windows (message type 'light'); remembered and re-sent to a window that joins later.
    light(ids) { lastLight = Array.isArray(ids) ? ids.slice() : null; if (lastLight) postIds('light', lastLight); },
    // Phase 25 (UI3): generic messages. on(type, fn): fn(message) for every message of `type` from another window.
    on(type, fn) {
      checkType('on', type);
      if (typeof fn !== 'function') throw new Error('C4PM_LINK.on: fn must be a function');
      (handlers[type] = own(handlers, type) ? handlers[type] : []).push(fn);
    },
    // post(type, payload, { replay }): send the payload's fields as a message of `type`; replay = remember it and re-send it to a
    // window that says hello later (the last one per type wins).
    post(type, payload, opts) {
      checkType('post', type);
      const data = Object.assign({}, payload);
      if (opts && opts.replay) replay[type] = data;
      postData(type, data);
    },
    // UI17: this window's link id (the `from` of its messages).
    id() { return WIN; },
    // UI17: the other windows, [{ id, view, map }] sorted by id (a copy).
    peers() {
      return Array.from(peers.keys()).sort().map(id => ({ id, view: peers.get(id).view, map: peers.get(id).map }));
    },
    // UI17: fn() after any change of the peer list or of a peer's view / map.
    onPeers(fn) {
      if (typeof fn !== 'function') throw new Error('C4PM_LINK.onPeers: fn must be a function');
      peerFns.push(fn);
    },
  };
  window.C4PM_SETTINGS.setStatus('link', () => window.C4PM_LINK.status());   // LAY-12b: the popup's status line, registered here

  window.C4PM_MAP.onSelect(node => window.C4PM_LINK.send(node ? node.id : null));
  window.C4PM_MODE.onChange(() => post('hello'));
  window.C4PM_SETTINGS.onChange((key, value) => {
    if (key !== 'link') return;
    if (value === 'on') open(); else close();
  });
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => post('bye'));
  if (enabled()) open();
})();
