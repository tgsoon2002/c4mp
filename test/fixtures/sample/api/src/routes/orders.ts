import { OrderService } from '../services/orderService';
import log from '@lib/log';

export const orderRoutes = (app: any) => {
  const service = new OrderService();
  app.post('/orders', (req: any, res: any) => {
    log('create order');
    res.json(service.create(req.body));
  });
};
