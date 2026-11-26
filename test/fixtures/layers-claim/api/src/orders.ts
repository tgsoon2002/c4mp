import { savePrice } from './store';

export function placeOrder(id: string): string {
  return savePrice(id);
}
