import { runQuery } from '../services/query';

export function tool(): string {
  return runQuery();
}
