import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { PANEL_SCRIPTS } from '../../src/page/html';

// LAY-12c (b389): the panel vm tests load the side panel the way the page does: settings.js first (every panel part reads
// window.C4PM_SETTINGS), mode.js when asked, then PANEL_SCRIPTS in order (viewModel.js ... panel.js). One list, from html.ts.
// `sandbox` must already be a vm context (vm.createContext). TR-5 (b363, shared fake DOM) can grow this file later.
const viewerDir = path.join(__dirname, '../../viewer');

export function loadPanelScripts(sandbox: vm.Context, opts: { mode?: boolean } = {}): void {
  const files = ['settings.js', ...(opts.mode ? ['mode.js'] : []), ...PANEL_SCRIPTS];
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(viewerDir, f), 'utf8'), sandbox, { filename: f });
}
