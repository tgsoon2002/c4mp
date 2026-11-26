import { openProject } from '../readers/open';
import { runQuery } from '../services/query';

export function main(): string {
  return openProject() + runQuery();
}
