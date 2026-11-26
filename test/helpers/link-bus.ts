// P20-T5-H (b262): a fake BroadcastChannel for the window-link tests. Two page instances (two harness runs) talk over it:
// it delivers synchronously through one shared in-memory bus, per channel name, never back to the sender.
// Phase 25 UI3: makeBus({ async: true }) queues the deliveries until bus.flush(), as a real channel delivers after the
// current script: a window that joins gets its answers after all its scripts loaded (sim.js registers 'sim' after link.js).
// Used by test/viewer-link.test.ts and test/viewer-sim-present-two.test.ts (UI17-3).

export interface Bus { sent: Array<{ name: string; data: any }>; open: Set<any>; flush(): void }

export function makeBus(opts: { async?: boolean } = {}): { bus: Bus; BroadcastChannel: any } {
  const queue: Array<() => void> = [];
  const bus: Bus = {
    sent: [], open: new Set(),
    flush() { while (queue.length) queue.shift()!(); },
  };
  class FakeBC {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    closed = false;
    constructor(public name: string) { bus.open.add(this); }
    postMessage(data: unknown) {
      if (this.closed) throw new Error('closed');
      const copy = JSON.parse(JSON.stringify(data));
      bus.sent.push({ name: this.name, data: copy });
      bus.open.forEach((o: FakeBC) => {
        if (o === this || o.name !== this.name) return;
        const deliver = () => { if (o.onmessage && !o.closed) o.onmessage({ data: JSON.parse(JSON.stringify(copy)) }); };
        if (opts.async) queue.push(deliver); else deliver();
      });
    }
    close() { this.closed = true; bus.open.delete(this); }
  }
  return { bus, BroadcastChannel: FakeBC };
}
