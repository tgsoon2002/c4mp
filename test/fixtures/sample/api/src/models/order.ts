export interface Order {
  id: string;
}

export function makeOrder(input: Partial<Order>): Order {
  const helper = () => 'x';
  return { id: input.id ?? helper() };
}
