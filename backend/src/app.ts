import cors from 'cors';
import express from 'express';
import { env } from './config/env.ts';
import authRouter from './api/auth.ts';
import cartRouter from './api/cart.ts';
import healthRouter from './api/health.ts';
import notificationsAndOptionalsRouter from './api/notificationsAndOptionals.ts';
import ordersRouter from './api/orders.ts';
import productsRouter from './api/products.ts';
import searchRouter from './api/search.ts';
import simulatorAndAdminRouter from './api/simulatorAndAdmin.ts';
import { errorHandler } from './middleware/errorHandler.ts';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);

  const allowedOrigins = env.frontendUrl ? [env.frontendUrl, 'http://localhost:3000'] : ['http://localhost:3000'];
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.run.app')) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/search', searchRouter);
  app.use('/api', productsRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api', ordersRouter);
  app.use('/api', simulatorAndAdminRouter);
  app.use('/api', notificationsAndOptionalsRouter);

  // Explicit 404 for unknown API paths
  app.use('/api/*', (_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Requested API endpoint does not exist.',
    });
  });

  app.use(errorHandler);
  return app;
}
