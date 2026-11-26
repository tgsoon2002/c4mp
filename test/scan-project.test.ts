import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openProject, OpenProjectOptions } from '../src/scan/project';
import { markerAboveTmp } from './helpers/anchor';
import type { FailOn } from '../src/types';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-open-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Which store openProject must return: none (null), the project default, the --store value or config.json's store. */
type Store = 'none' | 'default' | 'explicit' | 'config';
interface Row {
  name: string;
  anchor: boolean;
  /** .c4pm/config.json sets store (needs anchor) */
  configStore?: boolean;
  /** --store given (cli.store) */
  explicit?: boolean;
  /** opts.writeTo, relative to the temp folder (the anchor) */
  writeTo?: string;
  /** an invalid cli failOn (the config error) */
  badConfig?: boolean;
  opts: OpenProjectOptions;
  /** exported: the export folder C4MP/demo-app and C4MP/.gitignore exist afterwards */
  want: { store: Store; gitignore: boolean; exported?: boolean } | { throws: RegExp };
}

const rows: Row[] = [
  { name: 'no anchor, no store asked', anchor: false, opts: {}, want: { store: 'none', gitignore: false } },
  { name: 'no anchor, store known', anchor: false, opts: { store: 'known' }, want: { store: 'none', gitignore: false } },
  { name: 'no anchor, store required', anchor: false, opts: { store: 'required' }, want: { throws: /c4mp init --repo/ } },
  { name: 'no anchor, requireAnchor', anchor: false, opts: { requireAnchor: true }, want: { throws: /c4mp init --repo/ } },
  { name: 'no anchor, --store override', anchor: false, explicit: true, opts: { store: 'required', create: true }, want: { store: 'explicit', gitignore: false } },
  { name: 'anchor, no store asked', anchor: true, opts: {}, want: { store: 'none', gitignore: false } },
  { name: 'anchor, store set but none given', anchor: true, opts: { store: 'set' }, want: { store: 'none', gitignore: false } },
  { name: 'anchor, store set from config.json', anchor: true, configStore: true, opts: { store: 'set' }, want: { store: 'config', gitignore: false } },
  { name: 'anchor, store known', anchor: true, opts: { store: 'known' }, want: { store: 'default', gitignore: false } },
  { name: 'anchor, store required', anchor: true, opts: { store: 'required' }, want: { store: 'default', gitignore: false } },
  { name: 'anchor, --store override beats config.json', anchor: true, configStore: true, explicit: true, opts: { store: 'required' }, want: { store: 'explicit', gitignore: false } },
  { name: 'anchor, create writes .c4pm/.gitignore for the default store', anchor: true, opts: { store: 'required', create: true }, want: { store: 'default', gitignore: true } },
  { name: 'anchor, create leaves .c4pm alone for a store outside it', anchor: true, explicit: true, opts: { store: 'required', create: true }, want: { store: 'explicit', gitignore: false } },
  { name: 'anchor, writeTo under .c4pm writes .c4pm/.gitignore', anchor: true, writeTo: '.c4pm/projects/code/plan', opts: {}, want: { store: 'none', gitignore: true } },
  { name: 'anchor, writeTo outside .c4pm leaves it alone', anchor: true, writeTo: 'code/arch', opts: {}, want: { store: 'none', gitignore: false } },
  { name: 'no anchor, writeTo does nothing', anchor: false, writeTo: '.c4pm/projects/code/plan', opts: {}, want: { store: 'none', gitignore: false } },
  { name: 'anchor, exportDir makes the export folder', anchor: true, opts: { exportDir: true, store: 'known' }, want: { store: 'default', gitignore: false, exported: true } },
  { name: 'no anchor, exportDir throws the init hint', anchor: false, opts: { exportDir: true }, want: { throws: /c4mp init --repo/ } },
  { name: 'no anchor, exportDir: the config error comes first', anchor: false, badConfig: true, opts: { exportDir: true }, want: { throws: /failOn must be/ } },
];

// a .git/.c4pm above the temp dir gives every temp folder an anchor: the no-anchor rows cannot run there
const runnable = markerAboveTmp() ? rows.filter((r) => r.anchor) : rows;

describe('openProject', () => {
  test.each(runnable)('$name', ({ anchor, configStore, explicit, writeTo, badConfig, opts: rowOpts, want }) => {
    const opts: OpenProjectOptions = writeTo ? { ...rowOpts, writeTo: path.join(tmp, writeTo) } : rowOpts;
    const repo = path.join(tmp, 'code');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo-app' }));
    const stores: Record<Store, string | null> = {
      none: null,
      default: path.join(tmp, '.c4pm', 'projects'),
      explicit: path.join(tmp, 'elsewhere'),
      config: path.join(tmp, 'from-config'),
    };
    if (anchor) {
      fs.mkdirSync(path.join(tmp, '.git'));
      fs.mkdirSync(path.join(tmp, '.c4pm'));
      // viewOnCommit false shows the config came from the anchor's config.json
      const file = { viewOnCommit: false, ...(configStore ? { store: stores.config } : {}) };
      fs.writeFileSync(path.join(tmp, '.c4pm', 'config.json'), JSON.stringify(file));
    }
    const cli = { ...(explicit ? { store: stores.explicit as string } : {}), ...(badConfig ? { failOn: 'bogus' as FailOn } : {}) };

    if ('throws' in want) {
      expect(() => openProject(repo, cli, opts)).toThrow(want.throws);
      return;
    }
    const opened = openProject(repo, cli, opts);
    expect(opened.project?.anchor ?? null).toBe(anchor ? tmp : null);
    expect(opened.config.viewOnCommit).toBe(!anchor);
    expect(opened.store).toBe(stores[want.store]);
    expect(fs.existsSync(path.join(tmp, '.c4pm', '.gitignore'))).toBe(want.gitignore);
    expect(fs.existsSync(path.join(tmp, 'C4MP', '.gitignore')) && fs.existsSync(path.join(tmp, 'C4MP', 'demo-app'))).toBe(!!want.exported);
  });
});
