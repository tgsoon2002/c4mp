import { makeOrder, Order } from '../models/order';
import { orderRoutes } from '../routes/orders';

export class OrderService {
  constructor() {}

  create(input: Partial<Order>): Order {
    function validate() {
      return true;
    }
    validate();
    return makeOrder(input);
  }

  static find(id: string) {
    return id;
  }

  bulkCreate(inputs: Partial<Order>[]): Order[] {
    const results: Order[] = [];
    for (const input of inputs) {
      if (!input.id) {
        continue;
      }
      results.push(this.create(input));
    }
    if (results.length === 0) {
      throw new Error('no valid orders');
    }
    return results;
  }

  register(app: any) {
    orderRoutes(app);
  }
}
