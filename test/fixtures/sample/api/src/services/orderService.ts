import { makeOrder, Order } from '../models/order';

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
}
