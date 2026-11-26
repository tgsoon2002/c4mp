import { placeOrder } from '../../api/src/orders';

export function renderPage(): string {
  return placeOrder('1');
}
