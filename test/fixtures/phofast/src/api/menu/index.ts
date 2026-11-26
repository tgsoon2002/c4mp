import { Router } from 'express';
import { menu } from '../db';

export const menuRoutes = Router();

menuRoutes.get('/menu', async (_req, res) => {
  res.json(await menu.listAvailable());
});
