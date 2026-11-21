import { Kafka, logLevel, Producer, type SASLOptions } from 'kafkajs';
import { env, readOptionalCaCert, readOptionalCertFile } from '../config/env.ts';
import { AppError } from '../db/pool.ts';

export const TOPIC_CORE_EVENTS = 'bazaar.core.events';
export const TOPIC_FULFILMENT_EVENTS = 'bazaar.fulfilment.events';

const CORE_EVENT_TYPES = new Set([
  'order-placed',
  'inventory-updated',
  'order-item-cancelled',
  'offer-price-updated',
  'refund-credit-requested',
  'notification-created',
]);

const FULFILMENT_EVENT_TYPES = new Set([
  'fulfilment-status-updated',
  'stock-transfer-status-updated',
  'eta-updated',
]);

export function resolveTopicForEventType(eventType: string): string {
  if (CORE_EVENT_TYPES.has(eventType)) return TOPIC_CORE_EVENTS;
  if (FULFILMENT_EVENT_TYPES.has(eventType)) return TOPIC_FULFILMENT_EVENTS;
  return TOPIC_CORE_EVENTS;
}

export function isKafkaConfigured(): boolean {
  if (env.kafkaBrokers.length === 0) return false;
  if (env.kafkaSecurityProtocol.startsWith('SASL')) {
    return Boolean(env.kafkaSaslUsername && env.kafkaSaslPassword);
  }
  return true;
}

let kafkaInstance: Kafka | null = null;
let sharedProducer: Producer | null = null;

export function getKafkaClient(): Kafka {
  if (!isKafkaConfigured()) {
    throw new AppError(
      503,
      'SERVICE_NOT_CONFIGURED',
      'Aiven Kafka is not fully configured. Set KAFKA_BROKERS and KAFKA_SASL_PASSWORD in environment variables.',
      { missing: ['KAFKA_BROKERS', 'KAFKA_SASL_PASSWORD'] }
    );
  }
  if (!kafkaInstance) {
    const ca = readOptionalCaCert();
    const cert = readOptionalCertFile(env.kafkaServiceCertPath);
    const key = readOptionalCertFile(env.kafkaServiceKeyPath);

    const sslConfig =
      ca || (cert && key)
        ? {
            rejectUnauthorized: true,
            ...(ca ? { ca: [ca] } : {}),
            ...(cert && key ? { cert, key } : {}),
          }
        : env.kafkaSecurityProtocol.includes('SSL')
          ? { rejectUnauthorized: false }
          : undefined;

    let saslConfig: SASLOptions | undefined;
    if (
      env.kafkaSecurityProtocol.startsWith('SASL') &&
      env.kafkaSaslUsername &&
      env.kafkaSaslPassword
    ) {
      const mech = env.kafkaSaslMechanism.toLowerCase();
      if (mech === 'plain') {
        saslConfig = {
          mechanism: 'plain',
          username: env.kafkaSaslUsername,
          password: env.kafkaSaslPassword,
        };
      } else if (mech === 'scram-sha-512') {
        saslConfig = {
          mechanism: 'scram-sha-512',
          username: env.kafkaSaslUsername,
          password: env.kafkaSaslPassword,
        };
      } else {
        saslConfig = {
          mechanism: 'scram-sha-256',
          username: env.kafkaSaslUsername,
          password: env.kafkaSaslPassword,
        };
      }
    }

    kafkaInstance = new Kafka({
      clientId: 'bazaarbridge-service',
      brokers: env.kafkaBrokers,
      ssl: sslConfig,
      sasl: saslConfig,
      logLevel: logLevel.WARN,
    });
  }
  return kafkaInstance;
}

export async function getProducer(): Promise<Producer> {
  if (!sharedProducer) {
    sharedProducer = getKafkaClient().producer();
    await sharedProducer.connect();
  }
  return sharedProducer;
}

export async function ensureTopics(): Promise<void> {
  const admin = getKafkaClient().admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    const toCreate = [TOPIC_CORE_EVENTS, TOPIC_FULFILMENT_EVENTS]
      .filter((t) => !existing.includes(t))
      .map((topic) => ({
        topic,
        numPartitions: 2,
        replicationFactor: 1,
      }));
    if (toCreate.length > 0) {
      await admin.createTopics({ topics: toCreate, waitForLeaders: true });
    }
  } finally {
    await admin.disconnect();
  }
}

export async function publishKeyedEvent(params: {
  eventId: string;
  eventType: string;
  aggregateKey: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!params.aggregateKey) {
    throw new Error(`Refusing to publish event ${params.eventId} without aggregate_key.`);
  }
  const producer = await getProducer();
  const topic = resolveTopicForEventType(params.eventType);
  await producer.send({
    topic,
    messages: [
      {
        key: params.aggregateKey,
        value: JSON.stringify({
          event_id: params.eventId,
          event_type: params.eventType,
          aggregate_key: params.aggregateKey,
          payload: params.payload,
        }),
      },
    ],
  });
}

export async function disconnectKafka(): Promise<void> {
  if (sharedProducer) {
    await sharedProducer.disconnect();
    sharedProducer = null;
  }
}
