// Cart store of the Shop web app: takes the Add to cart click and sends POST /cart/items.

export interface CartState { count: number }

export function addToCartRequest(sku: string, qty: number): { method: string; url: string; body: string } {
  return { method: 'POST', url: '/cart/items', body: JSON.stringify({ sku, qty }) };
}

export function afterAdd(state: CartState, qty: number): CartState {
  return { count: state.count + qty };
}
