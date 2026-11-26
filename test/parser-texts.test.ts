import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePlan, parsePlanTexts } from '../src/plan/parser';

// P18-T0: parsePlanTexts must equal parsePlan on the same content.
const FIXTURES: Record<string, Record<string, string>> = {
  valid: {
    'plan/a.c4': "model {\n  app = system 'App' {\n    api = container 'Api' {\n      link ../src/api/\n    }\n  }\n}\n",
    'plan/b.c4': "model {\n  extend app.api {\n    auth = component 'Auth'\n  }\n  app.api.auth -> app.api\n}\n",
  },
  'parse error': {
    'plan/a.c4': "model {\n  app = system 'unterminated {\n}\n",
    'plan/b.c4': "model {\n  ok = system 'Ok'\n}\n",
  },
  'dotdot link': {
    'plan/a.c4': "model {\n  app = system 'App' {\n    api = container 'Api' {\n      link ../../src/api/\n      link ../../../outside/x.ts\n    }\n  }\n}\n",
  },
};

describe('parsePlanTexts', () => {
  for (const [name, files] of Object.entries(FIXTURES)) {
    it(`equals parsePlan: ${name}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-ptexts-'));
      try {
        const texts = new Map<string, string>();
        for (const [f, t] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
          fs.writeFileSync(path.join(root, f), t);
          texts.set(f, t);
        }
        expect(parsePlanTexts(root, texts)).toEqual(parsePlan(root, Object.keys(files)));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('parsePlan keeps a read failure at line 0 and lists every given file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-ptexts-'));
    try {
      fs.writeFileSync(path.join(root, 'b.c4'), "model {\n  ok = system 'Ok'\n}\n");
      const plan = parsePlan(root, ['b.c4', 'a.c4']);
      expect(plan.files).toEqual(['a.c4', 'b.c4']);
      expect(plan.issues).toHaveLength(1);
      expect(plan.issues[0]).toMatchObject({ file: 'a.c4', line: 0 });
      expect(plan.elements.map(e => e.id)).toEqual(['ok']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
