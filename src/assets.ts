import * as fs from 'fs';
import * as path from 'path';

// Shared by viewerDir() and guideDir(): the folders of shipped assets (`viewer/`, `guide/`) are looked
// up from several places depending on how c4pm runs (ts-node, compiled dist, portable bundle, single
// executable).

/**
 * Folder next to the entry script. In a Bun single executable `process.argv[1]` is `/$bunfs/root/<name>`
 * and the assets embedded with `--asset <name>` live beside it. Null when there is no entry script.
 */
export function embeddedAssetDir(name: string, entryScript: string | undefined = process.argv[1]): string | null {
  return entryScript ? path.join(path.dirname(entryScript), name) : null;
}

/** First candidate folder that holds `marker`, or null. Null candidates are skipped. */
export function findAssetDir(candidates: (string | null)[], marker: string): string | null {
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, marker))) return dir;
  }
  return null;
}
