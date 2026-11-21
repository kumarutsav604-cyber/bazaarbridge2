import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { createApp } from './backend/src/app.ts';
import { env, getServiceReadiness } from './backend/src/config/env.ts';
import { startConsumers, stopConsumers } from './backend/src/events/consumers.ts';
import { startBackgroundWorkers, stopBackgroundWorkers } from './backend/src/events/expiryAndStubWorkers.ts';
import { ensureTopics, isKafkaConfigured, disconnectKafka } from './backend/src/events/kafka.ts';
import { startOutboxPublisher, stopOutboxPublisher } from './backend/src/events/outboxPublisher.ts';
import { ensureIndex, isOpenSearchConfigured } from './backend/src/search/index.ts';
import { closePool, isPgConfigured } from './backend/src/db/pool.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const app = createApp();
  const isProd = env.nodeEnv === 'production' && fs.existsSync(path.resolve(__dirname, 'dist'));

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(env.port, '0.0.0.0', () => {
    console.log(`BazaarBridge server listening on http://0.0.0.0:${env.port}`);
  });

  const readiness = getServiceReadiness();
  try {
    if (isKafkaConfigured()) {
      await ensureTopics();
      startOutboxPublisher(1000);
      await startConsumers();
    }
    if (isOpenSearchConfigured()) {
      await ensureIndex();
    }
    if (isPgConfigured()) {
      startBackgroundWorkers();
    }
    if (readiness.allCoreConfigured) {
      console.log('BazaarBridge Aiven workers & consumers started.');
    } else {
      console.log(
        `BazaarBridge partial Aiven readiness (missing: ${readiness.missingCore.join(', ')}). Configured services active.`
      );
    }
  } catch (err) {
    console.error('Warning: Failed to start some Aiven background workers:', err);
  }

  const shutdown = async () => {
    stopOutboxPublisher();
    stopBackgroundWorkers();
    await stopConsumers();
    await disconnectKafka();
    await closePool();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
