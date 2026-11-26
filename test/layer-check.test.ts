import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePlanTexts } from '../src/plan/parser';
import { checkLayerDirection } from '../src/c4/layerCheck';
import { runCheck } from '../src/query/check';
import type { ComponentEdge, Plan, Snapshot } from '../src/types';

// b466: rules layer-upward (warning) and layer-skip (warning, opt-in config layers.skip), from the plan's subregion order.
const PLAN = [
  "model {",
  "  shop = system 'Shop' {",
  "    api = container 'Api' {",
  "      entry = subregion 'Entry' {",
  "        cli = component 'Cli'",
  "        mcp = component 'Mcp'",
  "      }",
  "      services = subregion 'Services' {",
  "        query = component 'Query'",
  "      }",
  "      engines = subregion 'Engines' {",
  "        scan = component 'Scan'",
  "      }",
  "      readers = subregion 'Readers' {",
  "        ws = component 'Workspace'",
  "      }",
  "      foundation = subregion 'Foundation' {",
  "        metadata {",
  "          shared 'true'",
  "        }",
  "        types = component 'Types'",
  "      }",
  "      loose = component 'Loose'",
  "    }",
  "    web = container 'Web' {",
  "      tier = subregion 'Tier' {",
  "        page = component 'Page'",
  "      }",
  "    }",
  "  }",
  "}",
].join('\n');

const plan: Plan = parsePlanTexts('/repo', new Map([['a.c4', PLAN]]));
const A = (id: string): string => `shop.api.${id}`;
const E = (from: string, to: string, weight = 1): ComponentEdge => ({ from: A(from), to: A(to), weight });
const snap = (edges: ComponentEdge[]): Snapshot => ({ componentEdges: edges } as unknown as Snapshot);
const run = (edges: ComponentEdge[], skip = false) => checkLayerDirection(plan, snap(edges), { skip });

describe('checkLayerDirection: layer-upward', () => {
  it('a downward arrow and an arrow inside one subregion: no finding', () => {
    expect(run([E('entry.cli', 'services.query'), E('entry.cli', 'entry.mcp')], true)).toEqual([]);
  });

  it('an upward arrow: one warning, id "from -> to", message with short ids, titles and the import count', () => {
    expect(run([E('readers.ws', 'services.query', 3)])).toEqual([{
      severity: 'warning', rule: 'layer-upward', id: `${A('readers.ws')} -> ${A('services.query')}`,
      message: 'readers.ws (Readers) calls services.query in Services, a layer above it (3 imports); call down, or move what both need into a lower or shared layer',
    }]);
    expect(run([E('readers.ws', 'services.query')])[0].message).toContain('(1 import)');
  });

  it('a shared subregion as target is never a finding; as source it is checked by its declared position (K 2026-11-12)', () => {
    expect(run([E('entry.cli', 'foundation.types'), E('readers.ws', 'foundation.types')], true)).toEqual([]);
    expect(run([E('foundation.types', 'engines.scan')]).map((f) => [f.rule, f.id])).toEqual([['layer-upward', `${A('foundation.types')} -> ${A('engines.scan')}`]]);
  });

  it('an arrow between two containers, from or to a loose component, or with an unknown end: no finding', () => {
    const edges = [
      { from: 'shop.web.tier.page', to: A('entry.cli'), weight: 1 }, { from: A('readers.ws'), to: 'shop.web.tier.page', weight: 1 },
      E('loose', 'entry.cli'), E('readers.ws', 'loose'), { from: 'gone', to: A('entry.cli'), weight: 1 },
    ];
    expect(run(edges, true)).toEqual([]);
  });

  it('a folder-mode snapshot (ids are container/folder, no plan fqn): no finding', () => {
    expect(checkLayerDirection(plan, snap([{ from: 'api/src', to: 'api/lib', weight: 2 }]), { skip: true })).toEqual([]);
  });

  it('a plan without subregions: no finding', () => {
    const flat = parsePlanTexts('/repo', new Map([['a.c4', "model {\n  s = system 'S' {\n    c = container 'C' {\n      x = component 'X'\n      y = component 'Y'\n    }\n  }\n}"]]));
    expect(checkLayerDirection(flat, snap([{ from: 's.c.y', to: 's.c.x', weight: 1 }]), { skip: true })).toEqual([]);
  });
});

describe('checkLayerDirection: layer-skip (opt-in) = an entry point that skips the services (K 2026-11-12)', () => {
  it('off by default; on: the top layer jumping over the second layer is one warning', () => {
    expect(run([E('entry.cli', 'readers.ws')])).toEqual([]);
    expect(run([E('entry.cli', 'readers.ws')], true).map((f) => [f.severity, f.rule, f.id])).toEqual([['warning', 'layer-skip', `${A('entry.cli')} -> ${A('readers.ws')}`]]);
  });

  it('names the component in between that already calls the target; else points at plan path', () => {
    const withRoute = run([E('entry.cli', 'readers.ws'), E('services.query', 'readers.ws')], true);
    expect(withRoute.find((f) => f.id.startsWith(A('entry.cli')))!.message).toBe(
      'entry.cli (Entry) calls readers.ws in Readers, skipping Services; go through services.query, which already uses readers.ws');
    expect(run([E('entry.cli', 'readers.ws')], true)[0].message).toContain('; plan a function in the layer between (c4mp plan path shows where)');
  });

  it('the top layer to the second layer, and arrows into the shared layer: no finding', () => {
    expect(run([E('entry.cli', 'services.query'), E('entry.cli', 'foundation.types')], true)).toEqual([]);
  });

  it('a lower layer jumping over a layer is no finding (Services -> Readers past Engines)', () => {
    expect(run([E('services.query', 'readers.ws')], true)).toEqual([]);
  });

  it('the top layer is the first NON-shared subregion: a shared subregion declared first never counts', () => {
    const text = [
      "model {", "  s = system 'S' {", "    c = container 'C' {",
      "      util = subregion 'Util' {", "        metadata {", "          shared 'true'", "        }", "        u = component 'U'", "      }",
      "      entry = subregion 'Entry' {", "        cli = component 'Cli'", "      }",
      "      services = subregion 'Services' {", "        q = component 'Q'", "      }",
      "      readers = subregion 'Readers' {", "        r = component 'R'", "      }",
      "    }", "  }", "}",
    ].join('\n');
    const p = parsePlanTexts('/repo', new Map([['a.c4', text]]));
    const edges = [{ from: 's.c.entry.cli', to: 's.c.readers.r', weight: 1 }, { from: 's.c.util.u', to: 's.c.readers.r', weight: 1 }];
    expect(checkLayerDirection(p, snap(edges), { skip: true }).map((f) => f.id)).toEqual(['s.c.entry.cli -> s.c.readers.r']);
  });
});

describe('check end to end (fixture layers-path)', () => {
  const FIX = path.join(__dirname, 'fixtures', 'layers-path');
  const copy = (): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-layercheck-')));
    fs.cpSync(FIX, dir, { recursive: true });
    return dir;
  };
  const layerFindings = (repo: string, cli = {}) =>
    runCheck(repo, cli, {})!.findings.filter((f) => f.rule.startsWith('layer-')).map((f) => [f.rule, f.id]);

  it('skip off by default; config layers.skip (cli or .c4pmrc.json) turns it on', () => {
    const repo = copy();
    expect(layerFindings(repo)).toEqual([]);
    // services.query -> readers.workspace also jumps over Engines, but only the entry layer is checked
    const skips = [['layer-skip', 'app.core.entry.cli -> app.core.readers.workspace']];
    expect(layerFindings(repo, { layers: { skip: true } })).toEqual(skips);
    fs.writeFileSync(path.join(repo, '.c4pmrc.json'), JSON.stringify({ layers: { skip: true } }));
    expect(layerFindings(repo)).toEqual(skips);
  });

  it('an import from a lower layer to a higher one is layer-upward', () => {
    const repo = copy();
    fs.writeFileSync(path.join(repo, 'src/readers/files.ts'),
      "import { runQuery } from '../services/query';\n\nexport function readFiles(): string[] {\n  return [runQuery()];\n}\n");
    expect(layerFindings(repo)).toEqual([['layer-upward', 'app.core.readers.files -> app.core.services.query']]);
  });
});
