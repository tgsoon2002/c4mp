import { KIND_TABLE, kindsOfView } from '../plan/kinds';
import type { KindWord, KindWords, ViewName } from '../types';

/**
 * b142: the ONE table of kind words for the viewer, per view. KIND_TABLE says which kinds exist and which view they
 * belong to; this file only adds the words. buildKindWords() is injected into the page as C4PM_DATA.kindWords (html.ts)
 * and read in the browser through C4PM_MODE (viewer/mode.js): tree, panel, region header, HUD, legend and node colour.
 * The types KindWord and KindWords are Foundation's (src/types.ts), so types.ts imports nothing from src/view.
 */

/** Words of every element kind of KIND_TABLE (the arch words; the io view overrides two below). */
const ELEMENT_WORDS: Record<string, KindWord> = {
  system: { tag: 'C1', region: 'C1 SYSTEM', hud: 'C1 · System', legend: 'System', color: 'c1' },
  container: { tag: 'C2', region: 'C2 CONTAINER', hud: 'C2 · Containers', legend: 'Container', color: 'c2' },
  subregion: { tag: 'subregion', region: 'SUBREGION', hud: 'Subregion', legend: 'Subregion', color: 'subregion' },   // b456: was layer
  component: { tag: 'C3', region: 'C3 COMPONENT', hud: 'C3 · Components', legend: 'Component', color: 'c3' },
  person: { tag: 'person', region: 'PERSON', hud: 'C1 · System', legend: 'Person', color: 'person' },
  external: { tag: 'ext', region: 'EXTERNAL', hud: 'C1 · System', legend: 'External', color: 'external' },
  screen: { tag: 'screen', region: 'SCREEN', hud: 'Screen', legend: 'Screen', color: 'screen' },
  region: { tag: 'region', region: 'REGION', hud: 'Region', color: 'screen' },
  control: { tag: 'control', region: 'CONTROL', hud: 'Control', color: 'screen' },
  state: { tag: 'state', region: 'STATE', hud: 'State', color: 'screen' },
  flow: { tag: 'flow', region: 'FLOW', hud: 'Flow', color: 'screen' },
  journey: { tag: 'journey', region: 'JOURNEY', hud: 'Journey', color: 'screen' },
  // b266: CLI / API / MCP kinds. 'param' reads Param; under a body it reads Field (plan/ioWords.ts PART_WORD_BY_PARENT).
  command: { tag: 'cmd', region: 'COMMAND', hud: 'Command', legend: 'Command', color: 'screen' },
  options: { tag: 'opts', region: 'OPTION GROUP', hud: 'Option group', color: 'screen' },
  flag: { tag: 'flag', region: 'FLAG', hud: 'Flag', color: 'screen' },
  arg: { tag: 'arg', region: 'ARG', hud: 'Argument', color: 'screen' },
  route: { tag: 'route', region: 'ROUTE', hud: 'Route', legend: 'Route', color: 'screen' },
  body: { tag: 'body', region: 'BODY', hud: 'Body', color: 'screen' },
  param: { tag: 'param', region: 'PARAM', hud: 'Param', color: 'screen' },
  tool: { tag: 'tool', region: 'TOOL', hud: 'Tool', legend: 'Tool', color: 'screen' },
  // Storage view words. The display word by technology (database/table/column...) comes later from storage/storageWords.ts storageWord().
  store: { tag: 'STORE', region: 'STORE', hud: 'Store', legend: 'Store', color: 'c2' },
  record: { tag: 'record', region: 'RECORD', hud: 'Record', legend: 'Record', color: 'c3' },
  field: { tag: 'field', region: 'FIELD', hud: 'Field', legend: 'Field', color: 'file' },
};

/**
 * Map node kinds that are not plan elements (so not in KIND_TABLE): the code, and C1-CTX's 'context' root (our system
 * with its persons and externals beside it). C1 A1 (b828): the context is a holder (`holder: true`): never drawn, no
 * region header, no legend row, no tree row; only its HUD word shows (nothing open at C1). Arch view only, after the elements.
 */
const CODE_WORDS: Record<string, KindWord> = {
  context: { tag: 'C1', hud: 'C1 · System context', color: 'c1', holder: true },
  shared: { tag: 'C3', hud: 'Code', color: 'c3' },   // auto-shared reads as a component
  unassigned: { tag: '!', hud: 'Code', color: 'unassigned' },
  slice: { tag: 'file', hud: 'Code', color: 'file' },
  file: { tag: 'file', hud: 'Files', legend: 'File', color: 'file' },
  function: { tag: 'fn', hud: 'Code', legend: 'Function', color: 'fn' },
  method: { tag: 'fn', hud: 'Code', color: 'fn' },
  class: { tag: 'class', hud: 'Code', legend: 'Class', color: 'cls' },
  type: { tag: 'type', hud: 'Code', color: 'drift-renamed' },   // the only palette hue not used by fn/cls/component
};

/** The io view has no C1/C2/C3: its system and container words replace the element rows. */
const IO_OVERRIDES: Record<string, KindWord> = {
  system: { tag: 'all', region: 'ALL APPS', hud: 'All apps', color: 'c1' },
  container: { tag: 'app', region: 'APP', hud: 'App', color: 'c2' },
};

/**
 * Rows of the kinds of KIND_TABLE that belong to a view; a kind with no words throws (a new kind must get its words here).
 * C1 A2 (b829): an arch row also carries its kind's KIND_TABLE `needsCode` (false: subregion, person, external), which the
 * viewer reads through C4PM_MODE.needsCode: "planned (no code yet)" shows only on a plan-only node of a kind that needs code.
 * The io and storage rows carry none (the viewer's default, true): a storage node is plan-only when the storage readers found
 * no code for it (STOR-5w, b611), not by the missing-code rule that needsCode stands for, so the storage tree keeps its flag.
 */
function rowsOf(view: ViewName): Record<string, KindWord> {
  const out: Record<string, KindWord> = {};
  for (const k of kindsOfView(view)) {
    if (!ELEMENT_WORDS[k]) throw new Error(`kindWords: kind "${k}" of KIND_TABLE has no words`);
    out[k] = { ...ELEMENT_WORDS[k], ...(view === 'arch' ? { needsCode: KIND_TABLE[k].needsCode } : {}) };
  }
  return out;
}

export function buildKindWords(): KindWords {
  const code: Record<string, KindWord> = {};
  for (const [k, w] of Object.entries(CODE_WORDS)) code[k] = { ...w };
  return {
    arch: { ...rowsOf('arch'), ...code },
    io: { ...rowsOf('io'), ...IO_OVERRIDES },
    storage: rowsOf('storage'),
  };
}
