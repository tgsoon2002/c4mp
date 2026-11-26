// Catalog component of the Shop API: product prices and search.

const PRICES: Record<string, number> = { 'p-42': 12.0, 'p-43': 9.5 };
const NAMES: Record<string, string> = { 'p-42': 'Blue mug', 'p-43': 'Red mug' };

export function getPrice(productId: string): number {
  return PRICES[productId] ?? 0;
}

export function search(text: string): string[] {
  const t = text.toLowerCase();
  return Object.keys(NAMES).filter((id) => NAMES[id].toLowerCase().includes(t));
}
