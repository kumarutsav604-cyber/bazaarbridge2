import cron, { ScheduledTask } from 'node-cron';
import { isPgConfigured, withDeadlockRetry, withTransaction } from '../db/pool.ts';

let expiryTask: ScheduledTask | null = null;
let stubWorkerTimer: NodeJS.Timeout | null = null;

/**
 * Expiry cleanup: node-cron every 60s.
 * ONE statement with FOR UPDATE SKIP LOCKED marking status='reserved' AND expires_at < now()
 * as 'expired' and restoring reserved_quantity ordered by offer_id, location_id.
 */
export async function runExpiryCleanup(): Promise<number> {
  if (!isPgConfigured()) return 0;

  return withDeadlockRetry(async () => {
    return withTransaction(async (client) => {
      const res = await client.query<{ offer_id: string }>(
        `WITH expired_rows AS (
           SELECT reservation_id, offer_id, location_id, quantity
             FROM reservations
            WHERE status = 'reserved'
              AND expires_at < now()
            ORDER BY offer_id ASC, location_id ASC
            FOR UPDATE SKIP LOCKED
         ),
         marked AS (
           UPDATE reservations r
              SET status = 'expired'
             FROM expired_rows e
            WHERE r.reservation_id = e.reservation_id
            RETURNING e.offer_id, e.location_id, e.quantity
         ),
         grouped_restore AS (
           SELECT offer_id, location_id, sum(quantity)::int AS total_qty
             FROM marked
            GROUP BY offer_id, location_id
            ORDER BY offer_id ASC, location_id ASC
         )
         UPDATE inventory i
            SET reserved_quantity = i.reserved_quantity - g.total_qty
           FROM grouped_restore g
          WHERE i.offer_id = g.offer_id
            AND i.location_id = g.location_id
            AND i.reserved_quantity >= g.total_qty
         RETURNING i.offer_id`
      );

      const uniqueOffers = new Set(res.rows.map((r) => r.offer_id));
      for (const offerId of uniqueOffers) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('inventory-updated', $1, $2)`,
          [offerId, JSON.stringify({ offer_id: offerId, reason: 'reservation_expired' })]
        );
      }
      return res.rowCount ?? 0;
    });
  });
}

/**
 * SIMULATED refund gateway worker: transitions 'requested' refunds older than 4s
 * to 'initiated' and enqueues 'refund-credit-requested'.
 */
export async function runRefundStubTick(): Promise<number> {
  if (!isPgConfigured()) return 0;

  return withTransaction(async (client) => {
    const res = await client.query<{ refund_id: string; order_item_id: string }>(
      `UPDATE refunds
          SET status = 'initiated',
              initiated_at = now()
        WHERE refund_id IN (
          SELECT refund_id FROM refunds WHERE status = 'requested' LIMIT 10 FOR UPDATE SKIP LOCKED
        )
        RETURNING refund_id, order_item_id`
    );

    for (const row of res.rows) {
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_key, payload)
         VALUES ('refund-credit-requested', $1, $2)`,
        [
          row.order_item_id,
          JSON.stringify({
            refund_id: row.refund_id,
            order_item_id: row.order_item_id,
            gateway_ref: `SIM-GW-${row.refund_id.slice(0, 8)}`,
            simulated: true,
          }),
        ]
      );
    }
    return res.rowCount ?? 0;
  });
}

export function startBackgroundWorkers(): void {
  if (!expiryTask) {
    expiryTask = cron.schedule('* * * * *', () => {
      runExpiryCleanup().catch((err) => console.error('Expiry cleanup error:', err?.message || err));
    });
  }
  if (!stubWorkerTimer) {
    stubWorkerTimer = setInterval(() => {
      runRefundStubTick().catch((err) => console.error('Refund stub worker error:', err?.message || err));
    }, 5000);
  }
}

export function stopBackgroundWorkers(): void {
  if (expiryTask) {
    expiryTask.stop();
    expiryTask = null;
  }
  if (stubWorkerTimer) {
    clearInterval(stubWorkerTimer);
    stubWorkerTimer = null;
  }
}
