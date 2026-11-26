// Cart component of the Shop API: POST /cart/items lands in addItem; addItem asks Catalog for the price.
import { getPrice } from './catalog';

export interface CartLine { productId: string; qty: number; price: number }
export interface Cart { id: string; lines: CartLine[] }

const CARTS = new Map<string, Cart>();

export function addItem(cartId: string, productId: string, qty: number): Cart {
  const cart = getCart(cartId);
  cart.lines.push({ productId, qty, price: getPrice(productId) });
  return cart;
}

export function getCart(cartId: string): Cart {
  let cart = CARTS.get(cartId);
  if (!cart) {
    cart = { id: cartId, lines: [] };
    CARTS.set(cartId, cart);
  }
  return cart;
}
