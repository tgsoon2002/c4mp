import * as fs from 'fs';
import * as path from 'path';
import { CMD_NAME, LEGACY_CMD_NAME } from './constants';

// P15-T8b: a thin agent file (Claude Code Skill `SKILL.md`, or an `AGENTS.md` snippet) made from the AI guide.
// ONE source of truth: Document/C4MP-AI-Guide.md (copy: guide/ai.md). Only the parts between the markers
//   <!-- skill:description --> ... <!-- /skill:description -->
//   <!-- skill:rules -->       ... <!-- /skill:rules -->
// are copied; the one fixed line is SKILL_POINTER.

export type SkillFormat = 'skill' | 'agents';

/** The only text of the generated file that is not taken from the guide (besides the file's own frame). */
export const SKILL_POINTER = `For everything else run \`${CMD_NAME} guide ai\`.`;

/** Text between `<!-- skill:NAME -->` and `<!-- /skill:NAME -->`, trimmed. Throws when the pair is missing or repeated. */
export function extractMarked(guide: string, name: string): string {
  const open = `<!-- skill:${name} -->`;
  const close = `<!-- /skill:${name} -->`;
  const from = guide.indexOf(open);
  if (from < 0 || guide.indexOf(open, from + open.length) >= 0) throw new Error(`the guide needs exactly one ${open} marker`);
  const to = guide.indexOf(close, from);
  if (to < 0) throw new Error(`the guide has ${open} without ${close}`);
  const text = guide.slice(from + open.length, to).trim();
  if (text === '') throw new Error(`the guide part ${open} is empty`);
  return text;
}

/** Generated file text for `format`, from the guide text. */
export function buildSkill(guide: string, format: SkillFormat = 'skill'): string {
  const description = extractMarked(guide, 'description').replace(/\s+/g, ' ');
  const rules = extractMarked(guide, 'rules');
  if (format === 'agents') {
    return `## ${CMD_NAME}\n\n${description}\n\n${rules}\n\n${SKILL_POINTER}\n`;
  }
  // JSON.stringify gives a double-quoted YAML scalar, so a colon or quote in the description cannot break the frontmatter
  return `---\nname: ${CMD_NAME}\ndescription: ${JSON.stringify(description)}\n---\n\n${rules}\n\n${SKILL_POINTER}\n`;
}

export interface WriteResult {
  path: string;
  status: 'written' | 'unchanged';
}

/**
 * Write `content` to `file` (made absolute; parent folders are created; the path may be outside the repo because the
 * user chose it). An existing file with different content is refused without `force`.
 */
export function writeSkillFile(file: string, content: string, force = false): WriteResult {
  const target = path.resolve(file);
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) throw new Error(`${target} is a folder; give a file path (for example ${path.join(target, 'SKILL.md')})`);
    if (fs.readFileSync(target, 'utf8') === content) return { path: target, status: 'unchanged' };
    if (!force) throw new Error(`${target} exists and differs; add --force to overwrite it`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { path: target, status: 'written' };
}
/**
 * Phase 35 B: after a skill file is written as `<skills>/c4mp/SKILL.md`, remove the old `<skills>/c4pm/` skill next to
 * it so only one is left. Only that one case: the file must be named SKILL.md in a folder named c4mp, and the old
 * folder's SKILL.md must be ours (frontmatter `name: c4pm`). Other files in the old folder are kept. Returns the
 * removed SKILL.md path, or null when nothing was removed.
 */
export function removeLegacySkill(outFile: string): string | null {
  const target = path.resolve(outFile);
  const dir = path.dirname(target);
  if (path.basename(target) !== 'SKILL.md' || path.basename(dir) !== CMD_NAME) return null;
  const oldDir = path.join(path.dirname(dir), LEGACY_CMD_NAME);
  const oldFile = path.join(oldDir, 'SKILL.md');
  if (!fs.existsSync(oldFile) || !new RegExp(`^---\\nname: ${LEGACY_CMD_NAME}\\n`).test(fs.readFileSync(oldFile, 'utf8'))) return null;
  fs.unlinkSync(oldFile);
  try {
    fs.rmdirSync(oldDir);   // only when empty
  } catch {
    // other files in the old folder stay
  }
  return oldFile;
}
