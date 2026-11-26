import type { ChangeType, FailOn, Severity, ViewName } from './types';
import pkg from '../package.json';

// Version lives ONLY in package.json "version" (plus package-lock.json); a bump is a one-line edit there.
// Phase 35: the product's names live here and nowhere else (scripts: scripts/names.sh).
export const PRODUCT_NAME = 'C4MP';
export const CMD_NAME = 'c4mp';
export const LEGACY_CMD_NAME = 'c4pm';
export const DATA_DIR = '.c4mp';
export const LEGACY_DATA_DIR = '.c4pm';
export const ENV_PREFIX = 'C4MP_';
export const LEGACY_ENV_PREFIX = 'C4PM_';

export const TOOL_VERSION = `${CMD_NAME}@${pkg.version}`;

/** Phase 35 A: true when `tool` is this version's tool string under the current or the legacy command name. */
export function isCurrentTool(tool: string): boolean {
  return tool === TOOL_VERSION || tool === `${LEGACY_CMD_NAME}@${pkg.version}`;
}
/**
 * Phase 35 B: the marked block (git hook or shell PATH block) in `text`, under the current markers or, when absent,
 * the legacy c4pm ones. `end` is just after the end marker. Null when there is no complete block.
 */
export function findMarkedBlock(text: string): { start: number; end: number; begin: string; endMark: string } | null {
  for (const [begin, endMark] of [[HOOK_BEGIN, HOOK_END], [LEGACY_HOOK_BEGIN, LEGACY_HOOK_END]]) {
    const start = text.indexOf(begin);
    if (start < 0) continue;
    const close = text.indexOf(endMark, start);
    if (close >= 0) return { start, end: close + endMark.length, begin, endMark };
  }
  return null;
}

// Per-language data (LANGUAGE_IDS, SOURCE_EXTENSIONS and the other extension lists, LANGUAGE_MANIFESTS,
// LANGUAGE_IGNORE_DIRS) lives in src/languages/registry.ts; ASSET_EXTENSIONS in src/languages/typescript/resolve.ts.
// This file is Foundation: it imports only Foundation files (types), never a language module or the importer.

// Directory names skipped everywhere. Dot-directories (.git, .github, ...) are also always skipped.
export const IGNORE_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', 'venv',
  '__pycache__', 'target', 'vendor'];

// Manifest file → tech label. Key order = priority when a dir has several.
export const MANIFESTS: Record<string, string> = {
  'package.json': 'Node.js',
  'requirements.txt': 'Python',
  'pyproject.toml': 'Python',
  'pom.xml': 'Java (Maven)',
  'build.gradle': 'Java (Gradle)',
  'build.gradle.kts': 'Kotlin/Java (Gradle)',
  'go.mod': 'Go',
  'Cargo.toml': 'Rust',
  'CMakeLists.txt': 'C/C++ (CMake)',
};

// Extra manifests, used ONLY when file-only listing (`files`) is on. Kept apart from MANIFESTS
// so default output does not change.
export const FILE_ONLY_MANIFESTS: Record<string, string> = {
  'composer.json': 'PHP (Composer)',
  'Gemfile': 'Ruby (Bundler)',
};

// Manifests matched by file-name suffix (same gate as FILE_ONLY_MANIFESTS).
export const MANIFEST_SUFFIXES: Record<string, string> = {
  '.csproj': 'C# (.NET)',
};

export const GROWTH_FACTOR = 2;         // grew:   after >= before * 2  AND after - before >= MIN_LINE_DELTA
export const SHRINK_FACTOR = 0.5;        // shrank: after <= before * 0.5 AND before - after >= MIN_LINE_DELTA
export const MIN_LINE_DELTA = 15;
export const RENAME_MIN_SIMILARITY = 0.7;
export const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info'];
/** b707: the values of a minimum severity (check / diff --min-severity, MCP check min_severity), lowest first. */
export const MIN_SEVERITIES: Severity[] = [...SEVERITY_ORDER].reverse();
/** b707: the values of failOn (config key, C4PM_FAIL_ON, --fail-on). */
export const FAIL_ON_LEVELS: FailOn[] = ['critical', 'warning', 'none'];
export const TYPE_ORDER: ChangeType[] = ['health', 'container', 'component', 'file', 'element', 'edge', 'cycle', 'external'];

export const PLAN_STATUSES = ['planned', 'in-progress', 'done', 'abandoned'];
export const PLAN_PRIORITIES = ['high', 'medium', 'low'];
/** C1 C2 (b834): the metadata key `shape` of a person (PLAN-STANDARD PS-4.3): the round head (default) or a robot's square head. */
export const PERSON_SHAPES = ['person', 'robot'];
/** b908: the metadata key `role` of a component (PLAN-STANDARD PS-4.3, since 1.12): `foundation` = nearly every other component uses it. */
export const COMPONENT_ROLES = ['foundation'];
export const FOUNDATION_ROLE = 'foundation';
export const BOARD_KINDS = ['task', 'feature', 'issue', 'bug', 'decision', 'question'];
export const BOARD_SIZES = ['S', 'M', 'L', 'XL'];
export const BOARD_DESCRIPTION_MAX = 8000;   // characters of item.description
export const BOARD_OUTCOME_MAX = 2000;       // characters of item.outcome
export const BOARD_STATUSES = PLAN_STATUSES;   // one source: board columns use the same words as the map pills
/** b273: the three view names, as the user types them (types.ts ViewName). Foundation so engines (src/sim) can use it; cli/common re-exports it. */
export const VIEW_NAMES: ViewName[] = ['arch', 'io', 'storage'];
export const C4_EXTENSION = '.c4';
export const GENERATED_HEADER = `// Generated by ${CMD_NAME} from a code snapshot. Edit freely: metadata you add is kept when you regenerate.`;

export const CONFIG_FILE = `.${CMD_NAME}rc.json`;
export const LEGACY_CONFIG_FILE = `.${LEGACY_CMD_NAME}rc.json`;
export const FILE_ONLY_ID = 'files';
// files of these extensions are listed without parsing; active only when languages contains 'files'.
// Overlap: .cs .php .rs .cpp .h .swift are also language extensions. A file goes to a selected language's
// handler first (handlerFor in src/pipeline.ts); it is only listed when no selected language owns it.
export const FILE_ONLY_EXTENSIONS = ['.java', '.kt', '.go', '.cs', '.rb', '.php', '.rs', '.c', '.cpp', '.h', '.swift', '.scala', '.sh', '.sql'];
export const HOOK_BEGIN = `# >>> ${CMD_NAME} >>>`;
export const HOOK_END = `# <<< ${CMD_NAME} <<<`;
/** Phase 35 B: the markers older versions wrote; blocks under them are still ours (findMarkedBlock). */
export const LEGACY_HOOK_BEGIN = `# >>> ${LEGACY_CMD_NAME} >>>`;
export const LEGACY_HOOK_END = `# <<< ${LEGACY_CMD_NAME} <<<`;

/** Pseudo caller of calls that sit in no named function or method (top level, class bodies, anonymous callbacks there).
 *  Foundation, so the language kit's calls collector, the language handlers and the call graph share it (b592). */
export const MODULE_CALLER = '<module>';
