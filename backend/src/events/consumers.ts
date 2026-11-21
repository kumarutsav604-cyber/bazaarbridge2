import type { Consumer, EachMessagePayload } from 'kafkajs';
import { isFlagEnabled } from '../config/env.ts';
import { getPool, withDeadlockRetry, withTransaction } from '../db/pool.ts';
import { deductUnits, restockUnits } from '../db/stockHelpers.ts';
import type { DeliveryMode } from '../domain/fees.ts';
import {
  getNextGroupStatusForFulfilmentEvent,
  type FulfilmentEventType,
} from '../domain/stateMachines.ts';
import { isOpenSearchConfigured, upsertOffer } from '../search/index.ts';
import {
  getKafkaClient,
  isKafkaConfigured,
  TOPIC_CORE_EVENTS,
  TOPIC_FULFILMENT_EVENTS,
} from './kafka.ts';
import { verifyOtpProof } from './otpService.ts';

export interface OutboxEnvelope {
  event_id: string;
  event_type: string;
  aggregate_key: string;
  payload: Record<string, unknown>;
}

const pausedConsumers = new Set<string>();

export function pauseConsumer(name: string): void {
  pausedConsumers.add(name);
}

export function resumeConsumer(name: string): void {
  pausedConsumers.delete(name);
}

export function isConsumerPaused(name: string): boolean {
  return pausedConsumers.has(name);
}

/**
 * Consumer: inventory-finalizer (Pattern A, listens to order-placed)
 */
export async function handleOrderPlaced(envelope: OutboxEnvelope): Promise<void> {
  if (isConsumerPaused('inventory-finalizer')) {
    throw new Error('CONSUMER_PAUSED:inventory-finalizer');
  }

  const orderId = String(envelope.payload.order_id || envelope.aggregate_key);

  await withDeadlockRetry(async () => {
    await withTransaction(async (client) => {
      const marker = await client.query(
        `INSERT INTO processed_events (event_id, consumer_name)
         VALUES ($1, 'inventory-finalizer')
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [envelope.event_id]
      );
      if (marker.rowCount === 0) {
        return; // already processed
      }

      const orderRes = await client.query<{ user_id: string }>(
        `SELECT user_id FROM orders WHERE order_id = $1`,
        [orderId]
      );
      if (orderRes.rowCount === 0) {
        return;
      }
      const userId = orderRes.rows[0].user_id;

      // v7.2 lock order: process lines ordered by offer_id, stock_location_id
      const linesRes = await client.query<{ order_item_id: string }>(
        `SELECT order_item_id
           FROM order_items
          WHERE order_id = $1
          ORDER BY offer_id ASC, stock_location_id ASC`,
        [orderId]
      );

      const blrWarehouseRes = await client.query<{ location_id: string }>(
        `SELECT location_id FROM stock_locations WHERE is_home = true LIMIT 1`
      );
      const blrWarehouseId = blrWarehouseRes.rows[0]?.location_id || null;

      const touchedOffers = new Set<string>();

      for (const line of linesRes.rows) {
        const lockRes = await client.query<{
          offer_id: string;
          stock_location_id: string;
          quantity: number;
          fulfilment_route: string | null;
          group_id: string | null;
        }>(
          `UPDATE order_items
              SET stock_finalised = true,
                  item_status = 'confirmed'
            WHERE order_item_id = $1
              AND item_status <> 'cancelled'
              AND stock_finalised = false
          RETURNING offer_id, stock_location_id, quantity, fulfilment_route, group_id`,
          [line.order_item_id]
        );

        if (lockRes.rowCount === 0) {
          // Already cancelled or already finalised -> SKIP completely
          continue;
        }

        const item = lockRes.rows[0];
        // Throws INVENTORY_DEDUCTION_FAILED if rowCount !== 1, rolling back marker + txn
        await deductUnits(client, item.offer_id, item.stock_location_id, item.quantity);
        touchedOffers.add(item.offer_id);

        if (item.fulfilment_route === 'transfer' && blrWarehouseId) {
          await client.query(
            `INSERT INTO stock_transfers (
               order_item_id, group_id, offer_id, from_location_id, to_location_id, quantity, status
             ) VALUES ($1, $2, $3, $4, $5, $6, 'requested')
             ON CONFLICT (order_item_id) DO NOTHING`,
            [
              line.order_item_id,
              item.group_id,
              item.offer_id,
              item.stock_location_id,
              blrWarehouseId,
              item.quantity,
            ]
          );

          if (item.group_id) {
            await client.query(
              `INSERT INTO outbox_events (event_type, aggregate_key, payload)
               VALUES ('stock-transfer-status-updated', $1, $2)`,
              [
                item.group_id,
                JSON.stringify({
                  event_type: 'transfer_requested',
                  group_id: item.group_id,
                  order_item_id: line.order_item_id,
                }),
              ]
            );
          }
        }
      }

      await client.query(`UPDATE orders SET status = 'confirmed' WHERE order_id = $1`, [orderId]);

      for (const offerId of touchedOffers) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('inventory-updated', $1, $2)`,
          [offerId, JSON.stringify({ offer_id: offerId, reason: 'finalised', order_id: orderId })]
        );
      }

      // Sole notification producer for order confirmation (notifier consumer inserts row)
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_key, payload)
         VALUES ('notification-created', $1, $2)`,
        [
          userId,
          JSON.stringify({
            user_id: userId,
            message: 'Order confirmed',
            event_ref: `order:${orderId}`,
          }),
        ]
      );
    });
  });
}

/**
 * Consumer: search-sync (Pattern B, listens to inventory-updated & offer-price-updated)
 * NEVER puts OpenSearch inside a PostgreSQL transaction.
 */
export async function handleSearchSync(envelope: OutboxEnvelope): Promise<void> {
  if (isConsumerPaused('search-sync')) {
    throw new Error('CONSUMER_PAUSED:search-sync');
  }

  const pool = getPool();
  const already = await pool.query(
    `SELECT 1 FROM processed_events WHERE event_id = $1 AND consumer_name = 'search-sync'`,
    [envelope.event_id]
  );
  if ((already.rowCount ?? 0) > 0) return;

  const offerId = String(envelope.payload.offer_id || envelope.aggregate_key);
  if (isOpenSearchConfigured()) {
    // 409 version_conflict -> outcome 'stale' (success)
    await upsertOffer(offerId);
  }

  await pool.query(
    `INSERT INTO processed_events (event_id, consumer_name)
     VALUES ($1, 'search-sync')
     ON CONFLICT DO NOTHING`,
    [envelope.event_id]
  );
}

/**
 * Consumer: fulfilment-pipeline (Pattern A, listens to bazaar.fulfilment.events)
 */
export async function handleFulfilmentEvent(envelope: OutboxEnvelope): Promise<void> {
  if (isConsumerPaused('fulfilment-pipeline')) {
    throw new Error('CONSUMER_PAUSED:fulfilment-pipeline');
  }

  const payload = envelope.payload || {};
  const groupId = String(payload.group_id || envelope.aggregate_key);

  await withTransaction(async (client) => {
    const marker = await client.query(
      `INSERT INTO processed_events (event_id, consumer_name)
       VALUES ($1, 'fulfilment-pipeline')
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [envelope.event_id]
    );
    if (marker.rowCount === 0) return;

    const groupRes = await client.query<{
      group_id: string;
      order_id: string;
      mode: DeliveryMode;
      status: string;
      user_id: string;
    }>(
      `SELECT g.group_id, g.order_id, g.mode, g.status, o.user_id
         FROM fulfilment_groups g
         JOIN orders o ON o.order_id = g.order_id
        WHERE g.group_id = $1`,
      [groupId]
    );
    if (groupRes.rowCount !== 1) return;
    const group = groupRes.rows[0];

    if (envelope.event_type === 'fulfilment-status-updated') {
      const eventType = String(payload.event_type || '') as FulfilmentEventType;

      if (eventType === 'otp_verified') {
        const otpProof = String(payload.otp_proof || '');
        const valid = await verifyOtpProof(groupId, otpProof);
        if (!valid) {
          await client.query(
            `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
             VALUES ($1, $2, 'otp_failed', 'delivery_rider', 'OTP proof verification failed; delivery blocked')`,
            [groupId, group.status]
          );
          await client.query(
            `INSERT INTO outbox_events (event_type, aggregate_key, payload)
             VALUES ('notification-created', $1, $2)`,
            [
              group.user_id,
              JSON.stringify({
                user_id: group.user_id,
                message: 'Delivery OTP verification failed. Order remains undelivered.',
                event_ref: `group:${groupId}:otp_failed:${envelope.event_id}`,
              }),
            ]
          );
          return;
        }

        const adv = await client.query(
          `UPDATE fulfilment_groups
              SET status = 'delivered'
            WHERE group_id = $1
              AND status NOT IN ('cancelled', 'delivered')
            RETURNING 1`,
          [groupId]
        );
        if ((adv.rowCount ?? 0) === 0) return;

        await client.query(
          `UPDATE order_items
              SET item_status = 'delivered',
                  delivered_at = now()
            WHERE group_id = $1
              AND item_status <> 'cancelled'`,
          [groupId]
        );
        await client.query(
          `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
           VALUES ($1, 'delivered', 'otp_verified', 'delivery_rider', 'Delivery verified via OTP proof')`,
          [groupId]
        );
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            group.user_id,
            JSON.stringify({
              user_id: group.user_id,
              message: `Order group delivered (${group.mode} mode)`,
              event_ref: `group:${groupId}:delivered`,
            }),
          ]
        );
        return;
      }

      if (eventType === 'otp_failed' || eventType === 'exception') {
        await client.query(
          `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
           VALUES ($1, $2, $3, 'delivery_rider', $4)`,
          [
            groupId,
            group.status,
            eventType,
            eventType === 'otp_failed'
              ? 'OTP proof mismatch recorded'
              : String(payload.note || 'Delivery exception reported'),
          ]
        );
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            group.user_id,
            JSON.stringify({
              user_id: group.user_id,
              message:
                eventType === 'otp_failed'
                  ? 'Delivery OTP attempt failed'
                  : 'Delivery exception reported on shipment',
              event_ref: `group:${groupId}:${eventType}:${envelope.event_id}`,
            }),
          ]
        );
        return;
      }

      const transition = getNextGroupStatusForFulfilmentEvent(group.mode, group.status, eventType);
      if (!transition.nextStatus || !transition.expectedCurrent.includes(group.status)) {
        return;
      }

      const adv = await client.query(
        `UPDATE fulfilment_groups
            SET status = $2
          WHERE group_id = $1
            AND status = $3
            AND status NOT IN ('cancelled', 'delivered')
          RETURNING 1`,
        [groupId, transition.nextStatus, group.status]
      );
      if (adv.rowCount === 0) return;

      await client.query(
        `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
         VALUES ($1, $2, $3, 'simulator', $4)`,
        [groupId, transition.nextStatus, eventType, `Status advanced to ${transition.nextStatus}`]
      );
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_key, payload)
         VALUES ('notification-created', $1, $2)`,
        [
          group.user_id,
          JSON.stringify({
            user_id: group.user_id,
            message: `Shipment update: ${transition.nextStatus.replace(/_/g, ' ')}`,
            event_ref: `group:${groupId}:${transition.nextStatus}`,
          }),
        ]
      );
      return;
    }

    if (envelope.event_type === 'stock-transfer-status-updated') {
      const eventType = String(payload.event_type || '');
      let orderItemId = payload.order_item_id ? String(payload.order_item_id) : null;
      if (!orderItemId) {
        const trLookup = await client.query<{ order_item_id: string }>(
          `SELECT order_item_id FROM stock_transfers WHERE group_id = $1 LIMIT 1`,
          [groupId]
        );
        orderItemId = trLookup.rows[0]?.order_item_id || null;
      }

      if (eventType === 'transfer_requested') {
        const adv = await client.query(
          `UPDATE fulfilment_groups
              SET status = 'transfer_requested'
            WHERE group_id = $1
              AND status = 'reserved_at_origin'
              AND status NOT IN ('cancelled', 'delivered')
            RETURNING 1`,
          [groupId]
        );
        if (adv.rowCount === 0) return;

        await client.query(
          `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
           VALUES ($1, 'transfer_requested', 'transfer_requested', 'inventory-finalizer', 'Inter-city stock transfer requested')`,
          [groupId]
        );
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            group.user_id,
            JSON.stringify({
              user_id: group.user_id,
              message: 'Transfer requested from holding city',
              event_ref: `group:${groupId}:transfer_requested`,
            }),
          ]
        );
        return;
      }

      if (!orderItemId) return;

      if (eventType === 'in_transit') {
        const trRes = await client.query(
          `UPDATE stock_transfers
              SET status = 'in_transit',
                  in_transit_at = now()
            WHERE order_item_id = $1
              AND status = 'requested'
            RETURNING 1`,
          [orderItemId]
        );
        if (trRes.rowCount === 0) return;

        await client.query(
          `UPDATE fulfilment_groups
              SET status = 'in_transit_to_bangalore'
            WHERE group_id = $1
              AND status = 'transfer_requested'
              AND status NOT IN ('cancelled', 'delivered')`,
          [groupId]
        );
        await client.query(
          `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
           VALUES ($1, 'in_transit_to_bangalore', 'in_transit', 'transfer_carrier', 'Stock in transit to Bangalore warehouse')`,
          [groupId]
        );
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            group.user_id,
            JSON.stringify({
              user_id: group.user_id,
              message: 'Stock transfer is in transit to Bangalore',
              event_ref: `group:${groupId}:in_transit`,
            }),
          ]
        );
        return;
      }

      if (eventType === 'received_checked') {
        const trRes = await client.query<{
          cancel_on_receipt: boolean;
          to_location_id: string;
          quantity: number;
          offer_id: string;
        }>(
          `UPDATE stock_transfers
              SET status = 'received_checked',
                  received_at = now()
            WHERE order_item_id = $1
              AND status = 'in_transit'
            RETURNING cancel_on_receipt, to_location_id, quantity, offer_id`,
          [orderItemId]
        );
        if (trRes.rowCount === 0) return;
        const tr = trRes.rows[0];

        if (tr.cancel_on_receipt) {
          const settled = await client.query(
            `UPDATE stock_transfers
                SET status = 'restocked_bangalore',
                    settled_at = now()
              WHERE order_item_id = $1
                AND status = 'received_checked'
                AND cancel_on_receipt = true
              RETURNING 1`,
            [orderItemId]
          );
          if (settled.rowCount === 0) return;

          await restockUnits(client, tr.offer_id, tr.to_location_id, tr.quantity);
          await client.query(
            `INSERT INTO outbox_events (event_type, aggregate_key, payload)
             VALUES ('inventory-updated', $1, $2)`,
            [
              tr.offer_id,
              JSON.stringify({
                offer_id: tr.offer_id,
                location_id: tr.to_location_id,
                reason: 'cancel_on_receipt_restock',
              }),
            ]
          );
          await client.query(
            `UPDATE fulfilment_groups SET status = 'cancelled' WHERE group_id = $1`,
            [groupId]
          );
          await client.query(
            `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
             VALUES ($1, 'cancelled', 'restocked_bangalore', 'warehouse_qc', 'Cancelled order item received and restocked into Bangalore warehouse')`,
            [groupId]
          );
          await client.query(
            `INSERT INTO outbox_events (event_type, aggregate_key, payload)
             VALUES ('notification-created', $1, $2)`,
            [
              group.user_id,
              JSON.stringify({
                user_id: group.user_id,
                message: 'Cancelled transfer unit received and restocked',
                event_ref: `group:${groupId}:restocked_bangalore`,
              }),
            ]
          );
        } else {
          await client.query(
            `UPDATE fulfilment_groups
                SET status = 'received_checked'
              WHERE group_id = $1
                AND status = 'in_transit_to_bangalore'
                AND status NOT IN ('cancelled', 'delivered')`,
            [groupId]
          );
          await client.query(
            `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
             VALUES ($1, 'received_checked', 'received_checked', 'warehouse_qc', 'Stock received and QC checked at Bangalore hub (awaiting allocation)')`,
            [groupId]
          );
          await client.query(
            `INSERT INTO outbox_events (event_type, aggregate_key, payload)
             VALUES ('notification-created', $1, $2)`,
            [
              group.user_id,
              JSON.stringify({
                user_id: group.user_id,
                message: 'Transfer stock received & QC checked in Bangalore',
                event_ref: `group:${groupId}:received_checked`,
              }),
            ]
          );
        }
        return;
      }

      if (eventType === 'allocated') {
        const trRes = await client.query<{ to_location_id: string }>(
          `UPDATE stock_transfers
              SET status = 'allocated',
                  allocated_at = now()
            WHERE order_item_id = $1
              AND status = 'received_checked'
              AND cancel_on_receipt = false
            RETURNING to_location_id`,
          [orderItemId]
        );
        if (trRes.rowCount === 0) return;

        // Units belong to this order; NEVER add to free Bangalore inventory
        await client.query(
          `UPDATE order_items SET stock_location_id = $2 WHERE order_item_id = $1`,
          [orderItemId, trRes.rows[0].to_location_id]
        );
        await client.query(
          `UPDATE fulfilment_groups
              SET status = 'allocated'
            WHERE group_id = $1
              AND status = 'received_checked'
              AND status NOT IN ('cancelled', 'delivered')`,
          [groupId]
        );
        await client.query(
          `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
           VALUES ($1, 'allocated', 'allocated', 'warehouse_allocator', 'Stock allocated to customer order in Bangalore')`,
          [groupId]
        );
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            group.user_id,
            JSON.stringify({
              user_id: group.user_id,
              message: 'Transferred stock allocated to your order for local dispatch',
              event_ref: `group:${groupId}:allocated`,
            }),
          ]
        );
        return;
      }

      return;
    }

    if (envelope.event_type === 'eta-updated') {
      const etaStart = payload.eta_window_start ? new Date(String(payload.eta_window_start)) : null;
      const etaEnd = payload.eta_window_end ? new Date(String(payload.eta_window_end)) : null;
      if (etaStart && etaEnd) {
        await client.query(
          `UPDATE fulfilment_groups
              SET eta_window_start = $2,
                  eta_window_end = $3,
                  eta_basis = COALESCE($4::jsonb, eta_basis)
            WHERE group_id = $1`,
          [groupId, etaStart.toISOString(), etaEnd.toISOString(), payload.eta_basis ? JSON.stringify(payload.eta_basis) : null]
        );
        await client.query(
          `UPDATE order_items
              SET promised_delivery_start = $2,
                  promised_delivery_end = $3
            WHERE group_id = $1 AND item_status <> 'cancelled'`,
          [groupId, etaStart.toISOString(), etaEnd.toISOString()]
        );
      }

      await client.query(
        `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
         VALUES ($1, $2, 'eta_updated', 'system', $3)`,
        [groupId, group.status, String(payload.note || 'Estimated delivery window revised due to hub availability')]
      );
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_key, payload)
         VALUES ('notification-created', $1, $2)`,
        [
          group.user_id,
          JSON.stringify({
            user_id: group.user_id,
            message: String(payload.note || 'Delivery ETA updated for your shipment'),
            event_ref: `group:${groupId}:eta:${envelope.event_id}`,
          }),
        ]
      );
    }
  });
}

/**
 * Consumer: notifier (Pattern A, SOLE writer to notifications table)
 */
export async function handleNotifier(envelope: OutboxEnvelope): Promise<void> {
  if (isConsumerPaused('notifier')) {
    throw new Error('CONSUMER_PAUSED:notifier');
  }

  await withTransaction(async (client) => {
    const marker = await client.query(
      `INSERT INTO processed_events (event_id, consumer_name)
       VALUES ($1, 'notifier')
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [envelope.event_id]
    );
    if (marker.rowCount === 0) return;

    const userId = String(envelope.payload.user_id || envelope.aggregate_key);
    const message = String(envelope.payload.message || 'Order update');
    const eventRef = envelope.payload.event_ref ? String(envelope.payload.event_ref) : envelope.event_id;

    await client.query(
      `INSERT INTO notifications (user_id, message, event_ref)
       VALUES ($1, $2, $3)`,
      [userId, message, eventRef]
    );
  });
}

/**
 * Consumer: cancellation-handler (Pattern B, listens to order-item-cancelled)
 * Upserts OpenSearch OUTSIDE PG txn, then commits marker + timeline + notification.
 */
export async function handleCancellationHandler(envelope: OutboxEnvelope): Promise<void> {
  if (isConsumerPaused('cancellation-handler')) {
    throw new Error('CONSUMER_PAUSED:cancellation-handler');
  }

  const pool = getPool();
  const already = await pool.query(
    `SELECT 1 FROM processed_events WHERE event_id = $1 AND consumer_name = 'cancellation-handler'`,
    [envelope.event_id]
  );
  if ((already.rowCount ?? 0) > 0) return;

  const offerId = String(envelope.payload.offer_id || envelope.aggregate_key);
  if (isOpenSearchConfigured()) {
    await upsertOffer(offerId);
  }

  await withTransaction(async (client) => {
    const marker = await client.query(
      `INSERT INTO processed_events (event_id, consumer_name)
       VALUES ($1, 'cancellation-handler')
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [envelope.event_id]
    );
    if (marker.rowCount === 0) return;

    const groupId = envelope.payload.group_id ? String(envelope.payload.group_id) : null;
    const userId = String(envelope.payload.user_id || '');
    const orderItemId = String(envelope.payload.order_item_id || '');

    if (groupId) {
      await client.query(
        `INSERT INTO shipment_timeline (group_id, status, event_type, actor, note)
         VALUES ($1, 'cancelled', 'order_item_cancelled', 'customer', $2)`,
        [groupId, `Item ${orderItemId} cancelled and stock restored`]
      );
    }

    if (userId) {
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_key, payload)
         VALUES ('notification-created', $1, $2)`,
        [
          userId,
          JSON.stringify({
            user_id: userId,
            message: 'Cancellation confirmed, refund initiated',
            event_ref: `cancel:${orderItemId}`,
          }),
        ]
      );
    }
  });
}

/**
 * Consumer: refund-credit (Pattern A, listens to refund-credit-requested)
 * Exact LOCKED credit transaction from agent-rules.md.
 */
export async function handleRefundCredit(envelope: OutboxEnvelope): Promise<void> {
  if (isConsumerPaused('refund-credit')) {
    throw new Error('CONSUMER_PAUSED:refund-credit');
  }

  const refundId = String(envelope.payload.refund_id || '');
  const gatewayRef = String(envelope.payload.gateway_ref || `SIM-REF-${refundId.slice(0, 8)}`);

  try {
    await withTransaction(async (client) => {
      const marker = await client.query(
        `INSERT INTO processed_events (event_id, consumer_name)
         VALUES ($1, 'refund-credit')
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [envelope.event_id]
      );
      if (marker.rowCount === 0) return;

      const gate = await client.query<{
        order_item_id: string;
        item_amount: number;
        fee_amount: number;
      }>(
        `UPDATE refunds
            SET status = 'credited',
                credited_at = now(),
                gateway_ref = $2
          WHERE refund_id = $1
            AND status IN ('requested', 'initiated')
          RETURNING order_item_id, item_amount, fee_amount`,
        [refundId, gatewayRef]
      );

      if (gate.rowCount === 0) {
        const cur = await client.query<{ status: string }>(
          `SELECT status FROM refunds WHERE refund_id = $1`,
          [refundId]
        );
        const curStatus = cur.rows[0]?.status;
        if (curStatus === 'credited' || curStatus === 'failed') {
          // Already settled; marker commits, NO money movement
          return;
        }
        return;
      }

      const { order_item_id, item_amount, fee_amount } = gate.rows[0];

      const capRes = await client.query(
        `UPDATE order_items
            SET item_refunded_amount = item_refunded_amount + $2,
                fee_refunded_amount = fee_refunded_amount + $3
          WHERE order_item_id = $1
            AND $2 >= 0 AND $3 >= 0
            AND item_refunded_amount + $2 <= line_price - discount_share
            AND fee_refunded_amount + $3 <= delivery_fee_share
          RETURNING 1`,
        [order_item_id, item_amount, fee_amount]
      );

      if (capRes.rowCount === 0) {
        throw new Error('REFUND_CAP_EXCEEDED');
      }

      const userLookup = await client.query<{ user_id: string }>(
        `SELECT o.user_id
           FROM order_items oi
           JOIN orders o ON o.order_id = oi.order_id
          WHERE oi.order_item_id = $1`,
        [order_item_id]
      );

      if (userLookup.rowCount === 1) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            userLookup.rows[0].user_id,
            JSON.stringify({
              user_id: userLookup.rows[0].user_id,
              message: 'Refund credited (SIMULATED gateway)',
              event_ref: `refund:${refundId}`,
            }),
          ]
        );
      }
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'REFUND_CAP_EXCEEDED') {
      // Separate transaction stops retry loop
      await getPool().query(
        `UPDATE refunds SET status = 'failed' WHERE refund_id = $1 AND status IN ('requested', 'initiated')`,
        [refundId]
      );
      return;
    }
    throw err;
  }
}

/**
 * Consumer: alert-watcher (Pattern A, optional FEATURE_ALERTS)
 */
export async function handleAlertWatcher(envelope: OutboxEnvelope): Promise<void> {
  if (!isFlagEnabled('FEATURE_ALERTS')) return;
  if (isConsumerPaused('alert-watcher')) {
    throw new Error('CONSUMER_PAUSED:alert-watcher');
  }

  const offerId = String(envelope.payload.offer_id || envelope.aggregate_key);

  await withTransaction(async (client) => {
    const marker = await client.query(
      `INSERT INTO processed_events (event_id, consumer_name)
       VALUES ($1, 'alert-watcher')
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [envelope.event_id]
    );
    if (marker.rowCount === 0) return;

    const offerRes = await client.query<{
      offer_id: string;
      product_id: string;
      product_name: string;
      selling_price: number;
      free_units: number;
    }>(
      `SELECT o.offer_id, o.product_id, p.name AS product_name, o.selling_price,
              coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0)::int as free_units
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         LEFT JOIN inventory i ON i.offer_id = o.offer_id
         LEFT JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
        WHERE o.offer_id = $1
        GROUP BY o.offer_id, o.product_id, p.name, o.selling_price`,
      [offerId]
    );

    if (offerRes.rowCount !== 1) return;
    const offer = offerRes.rows[0];
    if (offer.free_units <= 0) return;

    const subs = await client.query<{
      subscription_id: string;
      user_id: string;
      type: string;
      price_threshold_paise: number | null;
    }>(
      `SELECT subscription_id, user_id, type, price_threshold_paise
         FROM alert_subscriptions
        WHERE active = true
          AND (offer_id = $1 OR product_id = $2)`,
      [offer.offer_id, offer.product_id]
    );

    for (const sub of subs.rows) {
      const triggered =
        sub.type === 'back_in_stock' ||
        (sub.type === 'price_drop' &&
          sub.price_threshold_paise !== null &&
          offer.selling_price <= sub.price_threshold_paise);

      if (triggered) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('notification-created', $1, $2)`,
          [
            sub.user_id,
            JSON.stringify({
              user_id: sub.user_id,
              message:
                sub.type === 'back_in_stock'
                  ? `Back in stock: ${offer.product_name}`
                  : `Price alert triggered for ${offer.product_name}`,
              event_ref: `alert:${sub.subscription_id}:${envelope.event_id}`,
            }),
          ]
        );
        await client.query(
          `UPDATE alert_subscriptions SET active = false WHERE subscription_id = $1`,
          [sub.subscription_id]
        );
      }
    }
  });
}

const activeKafkaConsumers: Consumer[] = [];

async function runSingleConsumer(
  groupId: string,
  topic: string,
  handler: (envelope: OutboxEnvelope) => Promise<void>
): Promise<void> {
  const consumer = getKafkaClient().consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      if (!message.value) return;
      const envelope = JSON.parse(message.value.toString('utf8')) as OutboxEnvelope;
      await handler(envelope);
    },
  });
  activeKafkaConsumers.push(consumer);
}

export async function startConsumers(): Promise<void> {
  if (!isKafkaConfigured()) return;

  await runSingleConsumer('bazaar-core-router', TOPIC_CORE_EVENTS, async (env) => {
    switch (env.event_type) {
      case 'order-placed':
        await handleOrderPlaced(env);
        break;
      case 'inventory-updated':
      case 'offer-price-updated':
        await handleSearchSync(env);
        await handleAlertWatcher(env);
        break;
      case 'order-item-cancelled':
        await handleCancellationHandler(env);
        await handleAlertWatcher(env);
        break;
      case 'refund-credit-requested':
        await handleRefundCredit(env);
        break;
      case 'notification-created':
        await handleNotifier(env);
        break;
      default:
        break;
    }
  });

  await runSingleConsumer('bazaar-fulfilment-router', TOPIC_FULFILMENT_EVENTS, async (env) => {
    await handleFulfilmentEvent(env);
  });
}

export async function stopConsumers(): Promise<void> {
  while (activeKafkaConsumers.length > 0) {
    const c = activeKafkaConsumers.pop();
    if (c) {
      await c.disconnect();
    }
  }
}
