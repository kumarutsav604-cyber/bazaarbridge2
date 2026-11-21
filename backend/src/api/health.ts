import { Router } from 'express';
import { env, getServiceReadiness } from '../config/env.ts';
import { getPool, isPgConfigured } from '../db/pool.ts';
import { getOpenSearchClient, isOpenSearchConfigured } from '../search/index.ts';
import { isKafkaConfigured } from '../events/kafka.ts';

const router = Router();

router.get('/', async (_req, res) => {
  const readiness = getServiceReadiness();
  let postgresStatus: 'connected' | 'not_configured' | 'error' = readiness.postgresConfigured
    ? 'error'
    : 'not_configured';
  let opensearchStatus: 'connected' | 'not_configured' | 'error' = readiness.opensearchConfigured
    ? 'error'
    : 'not_configured';
  const kafkaStatus: 'configured' | 'not_configured' = isKafkaConfigured()
    ? 'configured'
    : 'not_configured';

  let pgError: string | undefined;
  if (isPgConfigured()) {
    try {
      await getPool().query('SELECT 1');
      postgresStatus = 'connected';
    } catch (err: unknown) {
      postgresStatus = 'error';
      pgError = err instanceof Error ? err.message : 'Connection failed';
    }
  }

  let osError: string | undefined;
  if (isOpenSearchConfigured()) {
    try {
      await getOpenSearchClient().ping();
      opensearchStatus = 'connected';
    } catch (err: unknown) {
      opensearchStatus = 'error';
      osError = err instanceof Error ? err.message : 'Connection failed';
    }
  }

  res.json({
    ok: postgresStatus === 'connected',
    readiness,
    services: {
      postgres: { status: postgresStatus, error: pgError },
      kafka: { status: kafkaStatus },
      opensearch: { status: opensearchStatus, error: osError },
    },
    featureFlags: env.featureFlags,
  });
});

export default router;
