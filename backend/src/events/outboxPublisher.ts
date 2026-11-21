import { isPgConfigured, withTransaction } from '../db/pool.ts';
import { isKafkaConfigured, publishKeyedEvent } from './kafka.ts';

let publisherTimer: NodeJS.Timeout | null = null;
let isPublishing = false;

export async function publishPendingOutboxBatch(limit = 25): Promise<number> {
  if (!isPgConfigured() || !isKafkaConfigured()) return 0;
  if (isPublishing) return 0;
  isPublishing = true;

  try {
    let totalPublished = 0;
    await withTransaction(async (client) => {
      const res = await client.query<{
        event_id: string;
        event_type: string;
        aggregate_key: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT event_id, event_type, aggregate_key, payload
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit]
      );

      for (const row of res.rows) {
        await publishKeyedEvent({
          eventId: row.event_id,
          eventType: row.event_type,
          aggregateKey: row.aggregate_key,
          payload: row.payload,
        });
        await client.query(
          `UPDATE outbox_events SET published_at = now() WHERE event_id = $1`,
          [row.event_id]
        );
        totalPublished += 1;
      }
    });
    return totalPublished;
  } finally {
    isPublishing = false;
  }
}

export function startOutboxPublisher(intervalMs = 1000): void {
  if (publisherTimer) return;
  publisherTimer = setInterval(() => {
    publishPendingOutboxBatch().catch((err) => {
      console.error('Outbox publisher error:', err?.message || err);
    });
  }, intervalMs);
}

export function stopOutboxPublisher(): void {
  if (publisherTimer) {
    clearInterval(publisherTimer);
    publisherTimer = null;
  }
}
