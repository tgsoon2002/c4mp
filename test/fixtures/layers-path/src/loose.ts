import { openProject } from './readers/open';

export function loose(): string {
  return openProject();
}
