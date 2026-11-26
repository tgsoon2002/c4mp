import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mapNodeToElement } from '../src/c4/applyLayout';
import { SYSTEM_ID_QUALIFIER } from '../src/names';
import { listC4Files } from '../src/plan/files';
import { parsePlan } from '../src/plan/parser';

const ARCH = `specification {
  element system
  element container
}

model {
  x = system 'X' {
    x = container 'X' { technology 'Node' }
    web = container 'Web' { technology 'React' }
  }
}
`;

function makePlan() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4pm-sysid-'));
  fs.mkdirSync(path.join(dir, 'c4'));
  fs.writeFileSync(path.join(dir, 'c4', 'architecture.c4'), ARCH);
  return parsePlan(dir, listC4Files(dir));
}

describe('mapNodeToElement with qualified system id', () => {
  const plan = makePlan();
  const idOf = (id: string) => {
    const m = mapNodeToElement(plan, id);
    return 'element' in m ? m.element.id : `reason:${m.reason}`;
  };

  test('x::system maps to the system element', () => {
    expect(SYSTEM_ID_QUALIFIER).toBe('::system');
    expect(idOf('x::system')).toBe('x');
  });

  test('unqualified ids behave as before', () => {
    expect(idOf('x')).toBe('x');
    expect(idOf('x.x')).toBe('x.x');
    expect(idOf('web')).toBe('x.web');
    expect(idOf('nope')).toMatch(/^reason:no plan element/);
  });
});
