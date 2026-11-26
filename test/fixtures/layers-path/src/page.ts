import { openProject } from './readers/open';

export function page(): string {
  return openProject();
}
