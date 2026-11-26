import { OrderService } from '../services/orderService';
import log from '@lib/log';
import { charge } from '../payments/stripe';

export const orderRoutes = (app: any) => {
  const service = new OrderService();
  app.post('/orders', (req: any, res: any) => {
    log('create order');
    charge(req.body.total);
    res.json(service.create(req.body));
  });
};
