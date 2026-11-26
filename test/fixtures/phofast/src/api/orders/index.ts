import { Router } from 'express';
import { requireAuth } from '../auth';
import { orders } from '../db';

export const orderRoutes = Router();

orderRoutes.post('/orders', requireAuth, async (req, res) => {
  const order = await orders.create({ userId: req.user.id, items: req.body.items });
  res.status(201).json(order);
});

orderRoutes.get('/orders/:id', requireAuth, async (req, res) => {
  res.json(await orders.findById(req.params.id));
});

// TODO: cancel order, push status to the kitchen screen
