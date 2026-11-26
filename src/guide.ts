import * as fs from 'fs';
import * as path from 'path';
import { embeddedAssetDir, findAssetDir } from './assets';

// P14-T42a: reads the guide Markdown files shipped in the `guide/` folder.
// `guide/` is shipped as a folder (like `viewer/`), not copied into dist.

const GUIDE_FILE = 'c4.md';

/** Topic name -> one-line summary. Insertion order is the listing order. */
const TOPICS: Record<string, string> = {
  c4: 'The .c4 plan format, claims, ownership, greenfield plans',
  ai: 'How an AI agent uses c4pm: commands, MCP tools, JSON shapes, rules',
  board: 'Boards: tasks, features, issues, bugs; the board commands and what makes a change refuse',
};

/**
 * Finds the `guide/` folder: from `src/` (ts-node) it is `../guide`,
 * from `dist/src/` (compiled and portable bundle) it is `../../guide`, in a single executable it is
 * `guide/` beside the entry script. Returns the first candidate that holds c4.md.
 */
export function guideDir(): string {
  const dir = findAssetDir([
    path.resolve(__dirname, '../guide'),
    path.resolve(__dirname, '../../guide'),
    embeddedAssetDir('guide'),
  ], GUIDE_FILE);
  if (!dir) throw new Error('guide folder not found');
  return dir;
}

/** Topics the guide module knows, in insertion order. */
export function listTopics(): { topic: string; summary: string }[] {
  return Object.keys(TOPICS).map((topic) => ({ topic, summary: TOPICS[topic] }));
}

/** Returns the Markdown text of a topic, or null for an unknown topic. */
export function readGuide(topic: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(TOPICS, topic)) {
    return null;
  }
  return fs.readFileSync(path.join(guideDir(), `${topic}.md`), 'utf8');
}
