import { readFiles } from '../readers/files';
import { label } from '../foundation/types';

export function checkAll(): string {
  return readFiles().join(',') + label();
}
