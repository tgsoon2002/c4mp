/**
 * P18-PB5: `c4mp board add --from-file items.json`: break a feature down in one step. The JSON is read (the file may
 * be anywhere, it is only read), checked by `expandBulk` (ops.ts: kinds, statuses, dates, groups, refs, cycles) and by
 * the plan (every link uid must be a plan element, as `board add --link` requires), then written in ONE guarded
 * write (Board editing addItemsFromFile, b473; printed by common.ts runGuardedWrite). Without --yes it prints every item it would create with its minted id.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Opts } from './common';
import { addItemsFromFile } from '../services/boardEdit';
import { emitFailure, runGuardedWrite } from './common';
import { optionFlag } from '../util/text';

/** Options of the single-item `board add` that mean nothing together with --from-file. */
const SINGLE_ITEM_OPTIONS = ['title', 'kind', 'owner', 'parent', 'depends', 'tags', 'tag', 'link', 'start', 'due', 'group', 'description', 'descriptionFile', 'doc', 'outcome', 'size', 'sprint', 'priority'];

/** Returns the exit code. */
export function runBulkAdd(opts: Opts): number {
  const command = 'board add';
  const clash = SINGLE_ITEM_OPTIONS.filter((k) => opts[k] !== undefined);
  if (clash.length > 0) return emitFailure(opts, command, `--from-file describes the items itself; do not combine it with ${clash.map(optionFlag).join(', ')}`);

  const file = path.resolve(String(opts.fromFile));
  if (!fs.existsSync(file)) return emitFailure(opts, command, `no such file: ${file}`);
  let spec: unknown;
  try {
    spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return emitFailure(opts, command, `${file} is not valid JSON (${(err as Error).message})`);
  }

  return runGuardedWrite(opts, command, (repo, yes) => addItemsFromFile(repo, spec, typeof opts.board === 'string' ? opts.board : undefined, yes, typeof opts.boardName === 'string' ? opts.boardName : undefined));
}
