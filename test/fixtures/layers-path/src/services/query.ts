import { openProject } from '../readers/open';
import { checkAll } from '../engines/checks';

export function runQuery(): string {
  return openProject() + checkAll();
}
