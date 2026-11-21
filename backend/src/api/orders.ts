import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { isFlagEnabled } from '../config/env.ts';
import { AppError, getPool, withDeadlockRetry, withTransaction } from '../db/pool.ts';
import { restockUnits } from '../db/stockHelpers.ts';
import { calculateEtaWindow } from '../domain/eta.ts';
import {
  allocatePaise,
  computeGroupFeePaise,
  isWithinHubHours,
  resolveReservationMode,
  type DeliveryMode,
  type HubContext,
  type StockLocationType,
} from '../domain/fees.ts';
import { isGroupCancellable } from '../domain/stateMachines.ts';
import { deriveOtp, deriveOtpHash } from '../events/otpService.ts';
import { requireAuth } from '../middleware/auth.ts';
import { releaseReservationInTxn } from './cart.ts';

const router = Router();

// POST /api/check-pin { pin_code }
router.post('/check-pin', requireAuth, async (req, res, next) => {
  try {
    const pinCode = typeof req.body?.pin_code === 'string' ? req.body.pin_code.trim() : '';
    if (!/^\d{6}$/.test(pinCode)) {
      throw new AppError(400, 'INVALID_PIN', 'Please enter a valid 6-digit PIN code.');
    }

    const pool = getPool();
    const hubRes = await pool.query<{
      hub_id: string;
      location_id: string;
      location_name: string;
      active: boolean;
      hours: HubContext['hours'];
      order_capacity: number;
      groups_accepted_today: number;
    }>(
      `SELECT h.hub_id,
              h.location_id,
              l.name AS location_name,
              h.active,
              h.hours,
              h.order_capacity,
              (
                SELECT count(*)::int
                  FROM fulfilment_groups fg
                 WHERE fg.location_id = h.location_id
                   AND fg.mode = 'quick'
                   AND fg.created_at::date = now()::date
                   AND fg.status <> 'cancelled'
              ) AS groups_accepted_today
         FROM hub_service_areas a
         JOIN fulfilment_hubs h USING (hub_id)
         JOIN stock_locations l ON l.location_id = h.location_id
        WHERE a.pin_code = $1`,
      [pinCode]
    );

    if (hubRes.rowCount !== 1) {
      res.json({
        pin_code: pinCode,
        quick_available: false,
        standard_available: true,
        hub_id: null,
        hub_location_id: null,
        reason: 'No active local Quick hub serves this PIN code. Standard and Transfer delivery are available.',
      });
      return;
    }

    const hub = hubRes.rows[0];
    const withinHours = isWithinHubHours(hub.hours);
    const hasCapacity = hub.groups_accepted_today < hub.order_capacity;
    const quickAvailable = hub.active && withinHours && hasCapacity;

    let reason = `Quick hub (${hub.location_name}) is active for PIN ${pinCode}.`;
    if (!hub.active) reason = 'Local Quick hub is currently paused; Standard delivery remains available.';
    else if (!withinHours) reason = 'Local Quick hub is outside operating hours.';
    else if (!hasCapacity) reason = 'Local Quick hub has reached daily order capacity.';

    res.json({
      pin_code: pinCode,
      quick_available: quickAvailable,
      standard_available: true,
      hub_id: quickAvailable ? hub.hub_id : null,
      hub_location_id: quickAvailable ? hub.location_id : null,
      hub_name: hub.location_name,
      reason,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders
const CreateOrderSchema = z.object({
  reservation_ids: z.array(z.string().uuid()).min(1),
  address: z.object({
    pin_code: z.string().regex(/^\d{6}$/, '6-digit PIN code required'),
  }),
  mode_preferences: z.record(z.string(), z.enum(['quick', 'standard'])).optional(),
  coupon_code: z.string().trim().min(1).max(64).optional(),
});

router.post('/orders', requireAuth, async (req, res, next) => {
  try {
    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'reservation_ids and valid 6-digit address.pin_code are required.');
    }

    const { reservation_ids, address, mode_preferences, coupon_code } = parsed.data;
    const uniqueReservationIds = Array.from(new Set(reservation_ids));
    const userId = req.user!.user_id;

    const orderResult = await withDeadlockRetry(async () => {
      return withTransaction(async (client) => {
        // a. Confirm reservations atomically
        const confRes = await client.query<{
          reservation_id: string;
          offer_id: string;
          location_id: string;
          quantity: number;
          price_paise: number;
        }>(
          `UPDATE reservations
              SET status = 'confirmed'
            WHERE reservation_id = ANY($1::uuid[])
              AND user_id = $2
              AND status = 'reserved'
              AND expires_at > now()
            RETURNING reservation_id, offer_id, location_id, quantity, price_paise`,
          [uniqueReservationIds, userId]
        );

        if (confRes.rowCount !== uniqueReservationIds.length) {
          throw new AppError(
            409,
            'RESERVATION_EXPIRED',
            'One or more reservations expired or are no longer active. Please re-reserve.'
          );
        }

        // b. PRICE CHECK against reservations.price_paise (never cart_items.price_snapshot)
        const offerIds = confRes.rows.map((r) => r.offer_id);
        const locationIds = confRes.rows.map((r) => r.location_id);

        const offersRes = await client.query<{
          offer_id: string;
          dealer_id: string;
          selling_price: number;
          status: string;
          eligible_modes: string[];
          transfer_days_max: number | null;
        }>(
          `SELECT offer_id, dealer_id, selling_price, status, eligible_modes, transfer_days_max
             FROM dealer_offers
            WHERE offer_id = ANY($1::uuid[])`,
          [offerIds]
        );
        const offerMap = new Map(offersRes.rows.map((o) => [o.offer_id, o]));

        const changedReservations: Array<{
          reservation_id: string;
          offer_id: string;
          current_price_paise: number;
        }> = [];

        for (const r of confRes.rows) {
          const offer = offerMap.get(r.offer_id);
          if (!offer || offer.status !== 'active') {
            throw new AppError(409, 'OFFER_UNAVAILABLE', 'An offer in your order is no longer active.');
          }
          if (Number(offer.selling_price) !== Number(r.price_paise)) {
            changedReservations.push({
              reservation_id: r.reservation_id,
              offer_id: r.offer_id,
              current_price_paise: Number(offer.selling_price),
            });
          }
        }

        if (changedReservations.length > 0) {
          throw new AppError(
            409,
            'PRICE_CHANGED',
            'Offer price changed since reservation. Release and re-reserve at the updated price.',
            { reservations: changedReservations }
          );
        }

        // Resolve locations & hub for PIN
        const locRes = await client.query<{
          location_id: string;
          location_type: StockLocationType;
          is_home: boolean;
        }>(
          `SELECT location_id, location_type, is_home
             FROM stock_locations
            WHERE location_id = ANY($1::uuid[])`,
          [locationIds]
        );
        const locMap = new Map(locRes.rows.map((l) => [l.location_id, l]));

        const hubRes = await client.query<HubContext>(
          `SELECT h.hub_id,
                  h.location_id,
                  h.active,
                  h.hours,
                  h.order_capacity,
                  (
                    SELECT count(*)::int
                      FROM fulfilment_groups fg
                     WHERE fg.location_id = h.location_id
                       AND fg.mode = 'quick'
                       AND fg.created_at::date = now()::date
                       AND fg.status <> 'cancelled'
                  ) AS groups_accepted_today
             FROM hub_service_areas a
             JOIN fulfilment_hubs h USING (hub_id)
            WHERE a.pin_code = $1
              AND h.active = true`,
          [address.pin_code]
        );
        const hubContext: HubContext | null = hubRes.rows[0] ?? null;

        // Classify each reservation & prepare pre-assigned order_item_ids
        const preparedItems = confRes.rows
          .map((r) => {
            const offer = offerMap.get(r.offer_id)!;
            const loc = locMap.get(r.location_id);
            if (!loc) {
              throw new AppError(409, 'LOCATION_NOT_SELLABLE', 'Stock location is unavailable.');
            }
            const pref = mode_preferences?.[r.reservation_id];
            const mode = resolveReservationMode(
              {
                reservation_id: r.reservation_id,
                location_id: r.location_id,
                location_type: loc.location_type,
                is_home: loc.is_home,
                eligible_modes: offer.eligible_modes || ['standard'],
                mode_preference: pref,
              },
              hubContext
            );

            return {
              order_item_id: crypto.randomUUID(),
              reservation_id: r.reservation_id,
              offer_id: r.offer_id,
              dealer_id: offer.dealer_id,
              location_id: r.location_id,
              quantity: r.quantity,
              line_price: Number(r.price_paise) * Number(r.quantity),
              mode,
              transfer_days_max: offer.transfer_days_max,
            };
          })
          .sort((a, b) => a.order_item_id.localeCompare(b.order_item_id));

        const itemsTotal = preparedItems.reduce((sum, i) => sum + i.line_price, 0);

        // Optional coupon redemption inside order transaction
        let discountTotal = 0;
        let appliedCouponId: string | null = null;
        let appliedCouponCode: string | null = null;

        if (coupon_code && isFlagEnabled('FEATURE_COUPONS')) {
          const cRes = await client.query<{
            coupon_id: string;
            code: string;
            kind: 'fixed_paise' | 'percent';
            value: number;
            min_basket_paise: number;
            max_redemptions: number | null;
            per_customer_limit: number;
            active: boolean;
            valid_from: string;
            valid_to: string;
          }>(
            `SELECT * FROM coupons WHERE upper(code) = upper($1)`,
            [coupon_code]
          );

          if (cRes.rowCount !== 1 || !cRes.rows[0].active) {
            throw new AppError(409, 'INVALID_COUPON', 'Coupon code is invalid or inactive.');
          }
          const coupon = cRes.rows[0];
          const now = Date.now();
          if (
            now < new Date(coupon.valid_from).getTime() ||
            now > new Date(coupon.valid_to).getTime()
          ) {
            throw new AppError(409, 'COUPON_EXPIRED', 'Coupon has expired.');
          }
          if (itemsTotal < Number(coupon.min_basket_paise)) {
            throw new AppError(
              409,
              'MIN_BASKET_NOT_MET',
              `Minimum basket of ${coupon.min_basket_paise} paise required for this coupon.`
            );
          }

          // Per-customer conditional UPSERT
          const custUsage = await client.query(
            `INSERT INTO coupon_customer_usage (coupon_id, user_id, used_count)
             VALUES ($1, $2, 1)
             ON CONFLICT (coupon_id, user_id)
             DO UPDATE SET used_count = coupon_customer_usage.used_count + 1
             WHERE coupon_customer_usage.used_count < $3
             RETURNING used_count`,
            [coupon.coupon_id, userId, coupon.per_customer_limit]
          );
          if (custUsage.rowCount === 0) {
            throw new AppError(
              409,
              'PER_CUSTOMER_LIMIT_REACHED',
              'You have reached the usage limit for this coupon.'
            );
          }

          // Global conditional UPDATE
          const globalUpd = await client.query(
            `UPDATE coupons
                SET redeemed_count = redeemed_count + 1
              WHERE coupon_id = $1
                AND active = true
                AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
              RETURNING 1`,
            [coupon.coupon_id]
          );
          if (globalUpd.rowCount === 0) {
            throw new AppError(
              409,
              'COUPON_LIMIT_REACHED',
              'This coupon has reached its maximum global redemptions.'
            );
          }

          discountTotal =
            coupon.kind === 'fixed_paise'
              ? Math.min(itemsTotal, Number(coupon.value))
              : Math.min(itemsTotal, Math.floor((itemsTotal * Number(coupon.value)) / 100));
          appliedCouponId = coupon.coupon_id;
          appliedCouponCode = coupon.code;
        }

        // Global discount allocation in order_item_id order
        const discountShares = allocatePaise(
          discountTotal,
          preparedItems.map((i) => i.line_price)
        );
        const itemDiscountMap = new Map<string, number>();
        preparedItems.forEach((item, idx) => {
          itemDiscountMap.set(item.order_item_id, discountShares[idx]);
        });

        // Group items by (location_id, mode)
        const groupMap = new Map<
          string,
          {
            group_id: string;
            location_id: string;
            mode: DeliveryMode;
            items: typeof preparedItems;
          }
        >();

        for (const item of preparedItems) {
          const key = `${item.location_id}::${item.mode}`;
          let grp = groupMap.get(key);
          if (!grp) {
            grp = {
              group_id: crypto.randomUUID(),
              location_id: item.location_id,
              mode: item.mode,
              items: [],
            };
            groupMap.set(key, grp);
          }
          grp.items.push(item);
        }

        const orderId = crypto.randomUUID();
        let deliveryFeeTotal = 0;
        const createdGroups: Array<{
          group_id: string;
          mode: DeliveryMode;
          location_id: string;
          fee_total: number;
          eta_window_start: string;
          eta_window_end: string;
          eta_basis: Record<string, unknown>;
          initial_status: string;
          otp_hash: string;
        }> = [];
        const itemFeeMap = new Map<string, number>();
        const itemGroupMap = new Map<
          string,
          { group_id: string; mode: DeliveryMode; etaStart: Date; etaEnd: Date }
        >();

        for (const grp of groupMap.values()) {
          // Ensure group items are in order_item_id ASC order
          grp.items.sort((a, b) => a.order_item_id.localeCompare(b.order_item_id));
          const grpItemsTotal = grp.items.reduce((s, i) => s + i.line_price, 0);
          const feeTotal = computeGroupFeePaise(grp.mode, grpItemsTotal);
          deliveryFeeTotal += feeTotal;

          const feeShares = allocatePaise(
            feeTotal,
            grp.items.map((i) => i.line_price)
          );
          grp.items.forEach((item, idx) => {
            itemFeeMap.set(item.order_item_id, feeShares[idx]);
          });

          let pickingQueueCount = 0;
          if (grp.mode === 'quick') {
            const qRes = await client.query<{ cnt: number }>(
              `SELECT count(*)::int AS cnt
                 FROM fulfilment_groups
                WHERE location_id = $1
                  AND status IN ('order_accepted', 'picked', 'packed')
                  AND created_at::date = now()::date`,
              [grp.location_id]
            );
            pickingQueueCount = qRes.rows[0]?.cnt ?? 0;
          }

          const maxTransferDays = Math.max(
            2,
            ...grp.items.map((i) => i.transfer_days_max ?? 2)
          );
          const eta = calculateEtaWindow(grp.mode, {
            pickingQueueCount,
            transferDaysMax: maxTransferDays,
          });

          const initialStatus =
            grp.mode === 'transfer' ? 'reserved_at_origin' : 'order_accepted';
          const otpHash = deriveOtpHash(grp.group_id);

          createdGroups.push({
            group_id: grp.group_id,
            mode: grp.mode,
            location_id: grp.location_id,
            fee_total: feeTotal,
            eta_window_start: eta.windowStart.toISOString(),
            eta_window_end: eta.windowEnd.toISOString(),
            eta_basis: eta.basis,
            initial_status: initialStatus,
            otp_hash: otpHash,
          });

          for (const item of grp.items) {
            itemGroupMap.set(item.order_item_id, {
              group_id: grp.group_id,
              mode: grp.mode,
              etaStart: eta.windowStart,
              etaEnd: eta.windowEnd,
            });
          }
        }

        const totalAmount = itemsTotal - discountTotal + deliveryFeeTotal;

        // c. Insert orders row
        await client.query(
          `INSERT INTO orders (
             order_id, user_id, items_total, discount_total, delivery_fee_total,
             total_amount, coupon_code, delivery_pin_code, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'placed')`,
          [
            orderId,
            userId,
            itemsTotal,
            discountTotal,
            deliveryFeeTotal,
            totalAmount,
            appliedCouponCode,
            address.pin_code,
          ]
        );

        // Insert fulfilment_groups
        for (const g of createdGroups) {
          await client.query(
            `INSERT INTO fulfilment_groups (
               group_id, order_id, location_id, mode, status, fee_total,
               eta_window_start, eta_window_end, eta_basis, otp_hash
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              g.group_id,
              orderId,
              g.location_id,
              g.mode,
              g.initial_status,
              g.fee_total,
              g.eta_window_start,
              g.eta_window_end,
              JSON.stringify(g.eta_basis),
              g.otp_hash,
            ]
          );
        }

        // Insert order_items
        for (const item of preparedItems) {
          const gInfo = itemGroupMap.get(item.order_item_id)!;
          const discountShare = itemDiscountMap.get(item.order_item_id) ?? 0;
          const feeShare = itemFeeMap.get(item.order_item_id) ?? 0;
          const route = gInfo.mode === 'transfer' ? 'transfer' : 'bangalore';

          await client.query(
            `INSERT INTO order_items (
               order_item_id, order_id, group_id, reservation_id, offer_id, dealer_id,
               quantity, line_price, discount_share, delivery_fee_share,
               stock_location_id, fulfilment_route, stock_finalised,
               promised_delivery_start, promised_delivery_end, item_status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, $14, 'placed')`,
            [
              item.order_item_id,
              orderId,
              gInfo.group_id,
              item.reservation_id,
              item.offer_id,
              item.dealer_id,
              item.quantity,
              item.line_price,
              discountShare,
              feeShare,
              item.location_id,
              route,
              gInfo.etaStart.toISOString(),
              gInfo.etaEnd.toISOString(),
            ]
          );
        }

        if (appliedCouponId) {
          await client.query(
            `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id)
             VALUES ($1, $2, $3)`,
            [appliedCouponId, userId, orderId]
          );
        }

        // SIMULATED sandbox payment record
        await client.query(
          `INSERT INTO payments (order_id, amount, method, status, gateway_ref, idempotency_key)
           VALUES ($1, $2, 'sandbox_upi', 'successful', $3, $4)`,
          [orderId, totalAmount, `SIM-PAY-${orderId.slice(0, 8)}`, `order:${orderId}`]
        );

        // Remove checked-out cart items for this user
        await client.query(
          `DELETE FROM cart_items ci
            USING carts c
            WHERE ci.cart_id = c.cart_id
              AND c.user_id = $1
              AND ci.reservation_id = ANY($2::uuid[])`,
          [userId, uniqueReservationIds]
        );

        // e. Outbox 'order-placed' (key order_id)
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('order-placed', $1, $2)`,
          [orderId, JSON.stringify({ order_id: orderId, user_id: userId })]
        );

        return {
          order_id: orderId,
          items_total: itemsTotal,
          discount_total: discountTotal,
          delivery_fee_total: deliveryFeeTotal,
          total_amount: totalAmount,
          payment_status: 'successful_simulated',
          groups: createdGroups.map((g) => ({
            group_id: g.group_id,
            mode: g.mode,
            location_id: g.location_id,
            fee_total: g.fee_total,
            eta_window_start: g.eta_window_start,
            eta_window_end: g.eta_window_end,
            status: g.initial_status,
          })),
        };
      });
    });

    res.status(201).json(orderResult);
  } catch (err) {
    next(err);
  }
});

// GET /api/orders (list current user's orders)
router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const resRows = await pool.query(
      `SELECT o.*,
              p.status AS payment_status,
              p.method AS payment_method,
              count(oi.order_item_id)::int AS item_count
         FROM orders o
         LEFT JOIN payments p ON p.order_id = o.order_id
         LEFT JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.user_id = $1
        GROUP BY o.order_id, p.status, p.method
        ORDER BY o.placed_at DESC`,
      [req.user!.user_id]
    );
    res.json({ orders: resRows.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:id
router.get('/orders/:id', requireAuth, async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const pool = getPool();

    const orderRes = await pool.query(
      `SELECT o.*, p.status AS payment_status, p.method AS payment_method, p.gateway_ref AS payment_gateway_ref
         FROM orders o
         LEFT JOIN payments p ON p.order_id = o.order_id
        WHERE o.order_id = $1`,
      [orderId]
    );
    if (orderRes.rowCount !== 1) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }
    const order = orderRes.rows[0];
    if (order.user_id !== req.user!.user_id && req.user!.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Access denied to this order.');
    }

    const itemsRes = await pool.query(
      `SELECT oi.*,
              p.name AS product_name,
              p.brand,
              p.image_url,
              d.shop_name,
              d.city AS dealer_city,
              l.name AS stock_location_name,
              l.city AS stock_location_city,
              st.transfer_id,
              st.status AS transfer_status,
              st.cancel_on_receipt,
              st.requested_at AS transfer_requested_at,
              st.in_transit_at AS transfer_in_transit_at,
              st.received_at AS transfer_received_at,
              st.allocated_at AS transfer_allocated_at,
              st.settled_at AS transfer_settled_at,
              rf.refund_id,
              rf.status AS refund_status,
              rf.item_amount AS refund_item_amount,
              rf.fee_amount AS refund_fee_amount,
              rf.credited_at AS refund_credited_at
         FROM order_items oi
         JOIN dealer_offers o ON o.offer_id = oi.offer_id
         JOIN products p ON p.product_id = o.product_id
         JOIN dealers d ON d.dealer_id = oi.dealer_id
         JOIN stock_locations l ON l.location_id = oi.stock_location_id
         LEFT JOIN stock_transfers st ON st.order_item_id = oi.order_item_id
         LEFT JOIN refunds rf ON rf.order_item_id = oi.order_item_id AND rf.kind = 'path_a'
        WHERE oi.order_id = $1
        ORDER BY oi.order_item_id ASC`,
      [orderId]
    );

    const groupsRes = await pool.query(
      `SELECT fg.*, l.name AS location_name, l.city AS location_city
         FROM fulfilment_groups fg
         LEFT JOIN stock_locations l ON l.location_id = fg.location_id
        WHERE fg.order_id = $1
        ORDER BY fg.created_at ASC`,
      [orderId]
    );

    const timelineRes = await pool.query(
      `SELECT t.*
         FROM shipment_timeline t
         JOIN fulfilment_groups fg ON fg.group_id = t.group_id
        WHERE fg.order_id = $1
        ORDER BY t.created_at ASC`,
      [orderId]
    );

    const isOwner = order.user_id === req.user!.user_id;
    const groupsWithOtp = groupsRes.rows.map((g) => {
      const undelivered = g.status !== 'delivered' && g.status !== 'cancelled';
      const { otp_hash: _omitHash, ...safeGroup } = g;
      return {
        ...safeGroup,
        cancellable: isGroupCancellable(g.status),
        // Raw demo OTP ONLY for owning customer while group is undelivered
        ...(isOwner && undelivered
          ? {
              delivery_otp: deriveOtp(g.group_id),
              delivery_otp_label: 'SAMPLE DEMO OTP',
            }
          : {}),
        timeline: timelineRes.rows.filter((t) => t.group_id === g.group_id),
      };
    });

    res.json({
      order: {
        ...order,
        payment_label: 'SIMULATED SANDBOX GATEWAY',
      },
      items: itemsRes.rows,
      groups: groupsWithOtp,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders/:id/items/:orderItemId/cancel { request_key }
const CancelSchema = z.object({
  request_key: z.string().min(4).max(128),
  reason_code: z.string().max(64).optional(),
});

router.post('/orders/:id/items/:orderItemId/cancel', requireAuth, async (req, res, next) => {
  try {
    const parsed = CancelSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'request_key is required for cancellation.');
    }

    const orderId = req.params.id;
    const orderItemId = req.params.orderItemId;
    const { request_key, reason_code } = parsed.data;
    const userId = req.user!.user_id;

    const result = await withDeadlockRetry(async () => {
      return withTransaction(async (client) => {
        // Verify order ownership
        const orderOwn = await client.query<{ user_id: string }>(
          `SELECT user_id FROM orders WHERE order_id = $1`,
          [orderId]
        );
        if (orderOwn.rowCount !== 1) {
          throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
        }
        if (orderOwn.rows[0].user_id !== userId && req.user!.role !== 'admin') {
          throw new AppError(403, 'FORBIDDEN', 'You cannot cancel items in another customer order.');
        }

        // a. Replay check: existing after_sales_cases row for (order_item_id, request_key)
        const replay = await client.query(
          `SELECT c.case_id, c.order_item_id, c.status, c.request_key,
                  r.refund_id, r.item_amount, r.fee_amount, r.status AS refund_status, r.kind
             FROM after_sales_cases c
             LEFT JOIN refunds r ON r.case_id = c.case_id
            WHERE c.order_item_id = $1 AND c.request_key = $2`,
          [orderItemId, request_key]
        );
        if ((replay.rowCount ?? 0) === 1) {
          const row = replay.rows[0];
          return {
            case_id: row.case_id,
            refund: {
              refund_id: row.refund_id,
              item_amount: row.item_amount,
              fee_amount: row.fee_amount,
              status: row.refund_status,
              kind: row.kind,
              label: 'SIMULATED GATEWAY',
            },
            replayed: true,
          };
        }

        // b. GATE: atomic conditional transition on order_items
        const gate = await client.query<{
          stock_finalised: boolean;
          reservation_id: string;
          offer_id: string;
          stock_location_id: string;
          quantity: number;
          item_paid_amount: number;
          delivery_fee_share: number;
          group_id: string | null;
        }>(
          `UPDATE order_items
              SET item_status = 'cancelled',
                  cancelled_at = now()
            WHERE order_item_id = $1
              AND order_id = $2
              AND item_status IN ('placed', 'confirmed')
              AND (
                group_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM fulfilment_groups g
                   WHERE g.group_id = order_items.group_id
                     AND g.status IN ('picked_up', 'out_for_delivery', 'delivered', 'cancelled')
                )
              )
          RETURNING stock_finalised, reservation_id, offer_id, stock_location_id,
                    quantity, item_paid_amount, delivery_fee_share, group_id`,
          [orderItemId, orderId]
        );

        if (gate.rowCount === 0) {
          throw new AppError(
            409,
            'ALREADY_CANCELLED_OR_TOO_LATE',
            'This item has already been cancelled or dispatched for delivery.'
          );
        }

        const item = gate.rows[0];

        if (!item.stock_finalised) {
          // c. Pre-finalisation: release CONFIRMED reservation hold (quantity unchanged)
          const relRes = await client.query(
            `UPDATE reservations
                SET status = 'released'
              WHERE reservation_id = $1
                AND status = 'confirmed'
              RETURNING 1`,
            [item.reservation_id]
          );
          if (relRes.rowCount === 0) {
            throw new AppError(
              409,
              'RESERVATION_STATE_CONFLICT',
              'Reservation state conflict while cancelling.'
            );
          }

          const holdUpd = await client.query(
            `UPDATE inventory
                SET reserved_quantity = reserved_quantity - $3
              WHERE offer_id = $1
                AND location_id = $2
                AND reserved_quantity >= $3`,
            [item.offer_id, item.stock_location_id, item.quantity]
          );
          if (holdUpd.rowCount !== 1) {
            throw new AppError(
              409,
              'STOCK_RELEASE_FAILED',
              'Failed to restore reserved quantity on cancellation.'
            );
          }
        } else {
          // d. Post-finalisation: ORDERED FALL-THROUGH T1 -> T2 -> T3 -> T4 -> plain/settled
          let settled = false;

          // T1: requested -> cancelled_at_origin
          const t1 = await client.query<{ from_location_id: string; quantity: number }>(
            `UPDATE stock_transfers
                SET status = 'cancelled_at_origin',
                    settled_at = now()
              WHERE order_item_id = $1 AND status = 'requested'
              RETURNING from_location_id, quantity`,
            [orderItemId]
          );
          if ((t1.rowCount ?? 0) === 1) {
            await restockUnits(client, item.offer_id, t1.rows[0].from_location_id, t1.rows[0].quantity);
            settled = true;
          }

          // T2: in_transit -> cancel_on_receipt = true (NO stock movement now)
          if (!settled) {
            const t2 = await client.query(
              `UPDATE stock_transfers
                  SET cancel_on_receipt = true
                WHERE order_item_id = $1 AND status = 'in_transit'
                RETURNING 1`,
              [orderItemId]
            );
            if ((t2.rowCount ?? 0) === 1) {
              settled = true;
            }
          }

          // T3: received_checked -> restocked_bangalore
          if (!settled) {
            const t3 = await client.query<{ to_location_id: string; quantity: number }>(
              `UPDATE stock_transfers
                  SET status = 'restocked_bangalore',
                      cancel_on_receipt = true,
                      settled_at = now()
                WHERE order_item_id = $1 AND status = 'received_checked'
                RETURNING to_location_id, quantity`,
              [orderItemId]
            );
            if ((t3.rowCount ?? 0) === 1) {
              await restockUnits(client, item.offer_id, t3.rows[0].to_location_id, t3.rows[0].quantity);
              settled = true;
            }
          }

          // T4: allocated -> restocked_bangalore
          if (!settled) {
            const t4 = await client.query<{ to_location_id: string; quantity: number }>(
              `UPDATE stock_transfers
                  SET status = 'restocked_bangalore',
                      settled_at = now()
                WHERE order_item_id = $1 AND status = 'allocated'
                RETURNING to_location_id, quantity`,
              [orderItemId]
            );
            if ((t4.rowCount ?? 0) === 1) {
              await restockUnits(client, item.offer_id, t4.rows[0].to_location_id, t4.rows[0].quantity);
              settled = true;
            }
          }

          // FALL-THROUGH
          if (!settled) {
            const trCheck = await client.query<{ status: string }>(
              `SELECT status FROM stock_transfers WHERE order_item_id = $1`,
              [orderItemId]
            );
            if (trCheck.rowCount === 0) {
              // Plain non-transfer restock
              await restockUnits(client, item.offer_id, item.stock_location_id, item.quantity);
            } else {
              const st = trCheck.rows[0].status;
              if (st !== 'cancelled_at_origin' && st !== 'restocked_bangalore') {
                throw new AppError(409, 'TRANSFER_STATE_CONFLICT', 'Unexpected transfer state.');
              }
              // Already settled by the other path -> NO movement
            }
          }
        }

        // e. Insert after_sales_cases & refunds ('requested'), emit ONE 'order-item-cancelled'
        const caseRes = await client.query<{ case_id: string }>(
          `INSERT INTO after_sales_cases (order_item_id, user_id, type, reason_code, status, request_key)
           VALUES ($1, $2, 'cancellation', $3, 'requested', $4)
           RETURNING case_id`,
          [orderItemId, userId, reason_code || 'customer_requested', request_key]
        );
        const caseId = caseRes.rows[0].case_id;

        const refundRes = await client.query(
          `INSERT INTO refunds (order_item_id, case_id, item_amount, fee_amount, kind, status)
           VALUES ($1, $2, $3, $4, 'path_a', 'requested')
           RETURNING refund_id, item_amount, fee_amount, status, kind`,
          [orderItemId, caseId, item.item_paid_amount, item.delivery_fee_share]
        );

        // If every item in the group is now cancelled, mark the group cancelled
        // (except when waiting on cancel_on_receipt so pipeline can still receive and restock)
        if (item.group_id) {
          const remainingActive = await client.query(
            `SELECT 1 FROM order_items WHERE group_id = $1 AND item_status <> 'cancelled' LIMIT 1`,
            [item.group_id]
          );
          const inTransitCancel = await client.query(
            `SELECT 1 FROM stock_transfers WHERE order_item_id = $1 AND status = 'in_transit' AND cancel_on_receipt = true`,
            [orderItemId]
          );
          if (remainingActive.rowCount === 0 && inTransitCancel.rowCount === 0) {
            await client.query(
              `UPDATE fulfilment_groups SET status = 'cancelled' WHERE group_id = $1`,
              [item.group_id]
            );
          }
        }

        // DO NOT emit notification-created or inventory-updated here; cancellation-handler owns them
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_key, payload)
           VALUES ('order-item-cancelled', $1, $2)`,
          [
            item.offer_id,
            JSON.stringify({
              offer_id: item.offer_id,
              order_id: orderId,
              order_item_id: orderItemId,
              group_id: item.group_id,
              user_id: orderOwn.rows[0].user_id,
              case_id: caseId,
            }),
          ]
        );

        return {
          case_id: caseId,
          refund: {
            ...refundRes.rows[0],
            label: 'SIMULATED GATEWAY',
          },
        };
      });
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Helper re-export in case needed
export { releaseReservationInTxn };
export default router;
