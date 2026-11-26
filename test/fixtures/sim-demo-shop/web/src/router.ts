// Router of the Shop web app: maps a page path to its screen and sends Place order to the API.

export function route(path: string): string {
  if (path.startsWith('/products/')) return 'product';
  if (path === '/cart') return 'cart';
  if (path === '/checkout') return 'checkout';
  return 'home';
}

export function placeOrderRequest(cartId: string): { method: string; url: string; body: string } {
  return { method: 'POST', url: '/orders', body: JSON.stringify({ cartId }) };
}
