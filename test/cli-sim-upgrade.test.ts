import * as fs from 'fs';
import * as path from 'path';
import { makeSimRepo, runSimCli } from './helpers/simHarness';
import type { SimRepo } from './helpers/simHarness';
import { listing } from './helpers/planEditHarness';
import { planNoScan } from '../src/scan/planScan';

// b899 slice 4: `c4pm sim upgrade` and `--owner` on the sim write commands, in-process on a tmp repo.

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let repo: SimRepo;
afterEach(() => { fs.rmSync(repo.root, { recursive: true, force: true }); });

const ownerOfTotal = (): unknown => planNoScan(repo.root)?.elements.find((e) => e.id === 'shop.api.cart.total')?.metadata.owner;
const targets = (id: string): unknown[] => (repo.read(id).steps as Array<{ target: unknown }>).map((s) => s.target);

describe('c4pm sim upgrade', () => {
  beforeEach(() => {
    repo = makeSimRepo('c4pm-sim-up-', {
      's-1': { kind: 'flow', title: 'Buy', steps: [{ target: 'shop.api.cart.addItem', view: 'arch' }, { target: 'src/cart.ts#total', view: 'arch' }] },
    });
  });

  it('dry run writes nothing; --yes stores uids; a second run has nothing to do', async () => {
    const before = listing(repo.root);
    const dry = await runSimCli(['upgrade', '--repo', repo.root]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('dry run: nothing written. Add --yes to apply.');
    expect(listing(repo.root)).toEqual(before);

    const wet = JSON.parse((await runSimCli(['upgrade', '--repo', repo.root, '--yes', '--json'])).stdout);
    expect(wet).toMatchObject({ ok: true, command: 'sim upgrade', dryRun: false, written: true });
    for (const t of targets('s-1')) expect(String(t)).toMatch(UID);

    const again = JSON.parse((await runSimCli(['upgrade', '--repo', repo.root, '--json'])).stdout);
    expect(again.changes).toContain('  every ref is a uid already');
    expect(again.written).toBe(false);
  });
});

describe('--owner on sim write commands', () => {
  beforeEach(() => { repo = makeSimRepo('c4pm-sim-owner-', { 's-1': { kind: 'flow', title: 'Buy', steps: [{ target: 'u-add', view: 'io' }] } }); });

  it('step add --owner names the owner of the function it adds to the plan', async () => {
    const r = await runSimCli(['step', 'add', 's-1', '--target', 'src/cart.ts#total', '--owner', 'Jay', '--repo', repo.root, '--yes']);
    expect(r.code).toBe(0);
    expect(ownerOfTotal()).toBe('Jay');
  });

  it('apply --owner does the same', async () => {
    const file = path.join(repo.root, 'spec.json');
    fs.writeFileSync(file, JSON.stringify({ sims: [{ kind: 'flow', title: 'Sum', steps: [{ target: 'src/cart.ts#total', view: 'arch' }] }] }));
    const r = await runSimCli(['apply', file, '--owner', 'Jay', '--repo', repo.root, '--yes']);
    expect(r.code).toBe(0);
    expect(ownerOfTotal()).toBe('Jay');
  });
});
