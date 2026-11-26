// Orders component of the Shop API: POST /orders runs placeOrder. Payments has no code yet (planned), so
// placeOrder does not call charge: the s-1 step 8 (placeOrder -> charge) stays unverified.
import { getCart } from './cart';

export interface Order { id: string; cartId: string; status: 'cart' | 'paid'; total: number }

const ORDERS: Order[] = [];

export function placeOrder(cartId: string): Order {
  const cart = getCart(cartId);
  const total = cart.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const order: Order = { id: `o-${1001 + ORDERS.length}`, cartId, status: 'cart', total };
  ORDERS.push(order);
  return order;
}

export function listOrders(): Order[] {
  return ORDERS.slice();
}
