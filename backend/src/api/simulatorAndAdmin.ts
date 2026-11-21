import { Router } from 'express';
import { z } from 'zod';
import { AppError, getPool, withTransaction } from '../db/pool.ts';
import { calculateEtaWindow } from '../domain/eta.ts';
import { isValidSimulatorEventType, TRANSFER_EVENT_TYPES } from '../domain/stateMachines.ts';
import { getLiveProofSnapshot } from '../events/liveProofService.ts';
import { deriveOtp, hashOtpSubmission } from '../events/otpService.ts';
import { requireAdmin } from '../middleware/auth.ts';

const router = Router();

// GET /api/admin/overview (admin only - real DB metrics)
router.get('/admin/overview', requireAdmin, async (_req, res, next) => {
  try {
    const pool = getPool();
    const statsRes = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM products) AS total_products,
        (SELECT count(*)::int FROM dealers) AS total_dealers,
        (SELECT count(*)::int FROM orders) AS total_orders,
        (SELECT count(*)::int FROM fulfilment_groups WHERE status NOT IN ('delivered', 'cancelled')) AS active_groups,
        (SELECT count(*)::int FROM stock_transfers WHERE status NOT IN ('allocated', 'cancelled_at_origin', 'restocked_bangalore')) AS pending_transfers,
        (SELECT count(*)::int FROM refunds) AS refund_cases,
        (SELECT coalesce(sum(quantity), 0)::int FROM inventory) AS total_units,
        (SELECT coalesce(sum(reserved_quantity), 0)::int FROM inventory) AS reserved_units`
    );
    res.json({ overview: statsRes.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/groups (admin only - list groups for simulator console)
router.get('/admin/groups', requireAdmin, async (_req, res, next) => {
  try {
    const pool = getPool();
    const groupsRes = await pool.query(
      `SELECT fg.group_id,
              fg.order_id,
              fg.mode,
              fg.status,
              fg.fee_total,
              fg.eta_window_start,
              fg.eta_window_end,
              fg.created_at,
              l.name AS location_name,
              l.city AS location_city,
              o.delivery_pin_code,
              u.email AS customer_email,
              st.transfer_id,
              st.status AS transfer_status,
              st.cancel_on_receipt,
              st.order_item_id AS transfer_order_item_id
         FROM fulfilment_groups fg
         JOIN orders o ON o.order_id = fg.order_id
         JOIN users u ON u.user_id = o.user_id
         LEFT JOIN stock_locations l ON l.location_id = fg.location_id
         LEFT JOIN stock_transfers st ON st.group_id = fg.group_id
        ORDER BY fg.created_at DESC
        LIMIT 30`
    );
    res.json({ groups: groupsRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/refunds (admin only)
router.get('/admin/refunds', requireAdmin, async (_req, res, next) => {
  try {
    const pool = getPool();
    const resRows = await pool.query(
      `SELECT r.*, oi.order_id, oi.item_paid_amount, oi.delivery_fee_share, p.name AS product_name
         FROM refunds r
         JOIN order_items oi ON oi.order_item_id = r.order_item_id
         JOIN dealer_offers dof ON dof.offer_id = oi.offer_id
         JOIN products p ON p.product_id = dof.product_id
        ORDER BY r.refund_id DESC
        LIMIT 30`
    );
    res.json({ refunds: resRows.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/hubs (admin only)
router.get('/admin/hubs', requireAdmin, async (_req, res, next) => {
  try {
    const pool = getPool();
    const hubsRes = await pool.query(
      `SELECT h.*, l.name AS location_name, l.city, l.state,
              array_agg(a.pin_code ORDER BY a.pin_code) AS pin_codes
         FROM fulfilment_hubs h
         JOIN stock_locations l ON l.location_id = h.location_id
         LEFT JOIN hub_service_areas a ON a.hub_id = h.hub_id
        GROUP BY h.hub_id, l.location_id`
    );
    res.json({ hubs: hubsRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/groups/:id/demo-otp (admin only)
router.get('/admin/groups/:id/demo-otp', requireAdmin, async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const pool = getPool();
    const check = await pool.query(`SELECT group_id FROM fulfilment_groups WHERE group_id = $1`, [groupId]);
    if (check.rowCount !== 1) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Fulfilment group not found.');
    }
    res.json({
      group_id: groupId,
      demo_otp: deriveOtp(groupId),
      label: 'SAMPLE DEMO OTP',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/simulator/fire-event { group_id, event_type, otp? } (admin only)
// NEVER logs request body, NEVER stores raw OTP anywhere — computes otp_proof = hashOtpSubmission(otp)
const FireEventSchema = z.object({
  group_id: z.string().uuid(),
  event_type: z.string().min(1).max(64),
  otp: z.string().optional(),
  note: z.string().max(200).optional(),
});

router.post('/simulator/fire-event', requireAdmin, async (req, res, next) => {
  try {
    const parsed = FireEventSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Valid group_id and event_type are required.');
    }
    const { group_id, event_type, otp, note } = parsed.data;

    if (!isValidSimulatorEventType(event_type)) {
      throw new AppError(400, 'INVALID_EVENT_TYPE', `Unsupported simulator event_type: ${event_type}`);
    }

    if (event_type === 'otp_verified' && (!otp || otp.trim() === '')) {
      throw new AppError(400, 'OTP_REQUIRED', 'OTP code is required when firing otp_verified.');
    }

    const isTransferEvent = (TRANSFER_EVENT_TYPES as readonly string[]).includes(event_type);
    const outboxEventType = isTransferEvent
      ? 'stock-transfer-status-updated'
      : 'fulfilment-status-updated';

    const payload: Record<string, unknown> = {
      group_id,
      event_type,
      ...(note ? { note } : {}),
    };

    if (event_type === 'otp_verified' && otp) {
      // Raw OTP converted to HMAC proof immediately; raw code NEVER enters outbox/Kafka/logs
      payload.otp_proof = hashOtpSubmission(otp.trim());
    }

    const pool = getPool();
    const ins = await pool.query<{ event_id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_key, payload)
       VALUES ($1, $2, $3)
       RETURNING event_id`,
      [outboxEventType, group_id, JSON.stringify(payload)]
    );

    res.status(202).json({ event_id: ins.rows[0].event_id });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/refunds/:id/credit { gateway_ref? } (admin only)
// Enqueues 'refund-credit-requested' (key order_item_id); NEVER moves money directly
router.post('/admin/refunds/:id/credit', requireAdmin, async (req, res, next) => {
  try {
    const refundId = req.params.id;
    const gatewayRef =
      typeof req.body?.gateway_ref === 'string' && req.body.gateway_ref.trim()
        ? req.body.gateway_ref.trim()
        : `SIM-ADMIN-${refundId.slice(0, 8)}`;

    const pool = getPool();
    const refRes = await pool.query<{ order_item_id: string }>(
      `SELECT order_item_id FROM refunds WHERE refund_id = $1`,
      [refundId]
    );
    if (refRes.rowCount !== 1) {
      throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund record not found.');
    }

    const orderItemId = refRes.rows[0].order_item_id;
    const ins = await pool.query<{ event_id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_key, payload)
       VALUES ('refund-credit-requested', $1, $2)
       RETURNING event_id`,
      [
        orderItemId,
        JSON.stringify({
          refund_id: refundId,
          order_item_id: orderItemId,
          gateway_ref: gatewayRef,
          simulated: true,
        }),
      ]
    );

    res.status(202).json({ event_id: ins.rows[0].event_id });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/hubs/:id/status { active: boolean } (admin only)
const HubStatusSchema = z.object({
  active: z.boolean(),
});

router.post('/admin/hubs/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const parsed = HubStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Boolean active flag is required.');
    }
    const hubId = req.params.id;
    const { active } = parsed.data;

    const result = await withTransaction(async (client) => {
      const upd = await client.query<{ hub_id: string; location_id: string; active: boolean }>(
        `UPDATE fulfilment_hubs
            SET active = $2
          WHERE hub_id = $1
          RETURNING hub_id, location_id, active`,
        [hubId, active]
      );
      if (upd.rowCount !== 1) {
        throw new AppError(404, 'HUB_NOT_FOUND', 'Fulfilment hub not found.');
      }

      const locationId = upd.rows[0].location_id;

      // Emit 'inventory-updated' for every offer stocked at this hub
      const offersRes = await client.query<{ offer_id: string }>(
        `SELECT offer_id FROM inventory WHERE location_id = $1 ORDER BY offer_id ASC`,
        [locationId]
      );
      for (const row of offersRes.rows) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('inventory-updated', $1, $2)`,
          [
            row.offer_id,
            JSON.stringify({
              offer_id: row.offer_id,
              location_id: locationId,
              hub_active: active,
              reason: 'hub_status_changed',
            }),
          ]
        );
      }

      // Emit 'eta-updated' for every affected active group at this hub
      const groupsRes = await client.query<{ group_id: string }>(
        `SELECT group_id
           FROM fulfilment_groups
          WHERE location_id = $1
            AND status NOT IN ('delivered', 'cancelled')`,
        [locationId]
      );
      const revisedEta = calculateEtaWindow(active ? 'quick' : 'standard', {
        pickingQueueCount: groupsRes.rowCount ?? 0,
      });

      for (const grp of groupsRes.rows) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('eta-updated', $1, $2)`,
          [
            grp.group_id,
            JSON.stringify({
              group_id: grp.group_id,
              eta_window_start: revisedEta.windowStart.toISOString(),
              eta_window_end: revisedEta.windowEnd.toISOString(),
              eta_basis: revisedEta.basis,
              note: active
                ? 'Fulfilment hub resumed; Quick delivery ETA restored.'
                : 'Fulfilment hub paused; delivery ETA revised to Standard.',
            }),
          ]
        );
      }

      return {
        hub: upd.rows[0],
        offers_notified: offersRes.rowCount ?? 0,
        groups_notified: groupsRes.rowCount ?? 0,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/live-proof (admin only)
router.get('/admin/live-proof', requireAdmin, async (req, res, next) => {
  try {
    const offerId = typeof req.query.offer_id === 'string' ? req.query.offer_id : undefined;
    const snapshot = await getLiveProofSnapshot(offerId);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

export default router;
