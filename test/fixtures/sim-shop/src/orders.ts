import { authorise } from './payments';

export function createOrder(total: number): string {
  return authorise(total) ? 'paid' : 'refused';
}
