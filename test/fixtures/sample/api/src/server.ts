import express from 'express';
import { orderRoutes } from './routes/orders';
export { default as log } from './lib/log';

export function start(port: number) {
  const app = express();
  orderRoutes(app);
  app.listen(port);
}
