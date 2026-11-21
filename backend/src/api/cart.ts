import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isFlagEnabled } from '../config/env.ts';
import { AppError, getPool, withTransaction } from '../db/pool.ts';
import { releaseHold } from '../db/stockHelpers.ts';
import { requireAuth } from '../middleware/auth.ts';

const router = Router();

export async function releaseReservationInTxn(
  client: PoolClient,
  reservationId: string,
  userId: string
): Promise<{ reservation_id: string; status: string }> {
  const upd = await client.query<{
    offer_id: string;
    location_id: string;
    quantity: number;
  }>(
    `UPDATE reservations
        SET status = 'released'
      WHERE reservation_id = $1
        AND user_id = $2
        AND status = 'reserved'
      RETURNING offer_id, location_id, quantity`,
    [reservationId, userId]
  );

  if ((upd.rowCount ?? 0) === 1) {
    const row = upd.rows[0];
    await releaseHold(client, row.offer_id, row.location_id, row.quantity);
    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_key, payload)
       VALUES ('inventory-updated', $1, $2)`,
      [
        row.offer_id,
        JSON.stringify({
          offer_id: row.offer_id,
          location_id: row.location_id,
          reason: 'released',
        }),
      ]
    );
    return { reservation_id: reservationId, status: 'released' };
  }

  const check = await client.query<{ status: string }>(
    `SELECT status FROM reservations WHERE reservation_id = $1 AND user_id = $2`,
    [reservationId, userId]
  );

  if (check.rowCount !== 1) {
    throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found.');
  }

  const currentStatus = check.rows[0].status;
  if (currentStatus === 'released' || currentStatus === 'expired') {
    return { reservation_id: reservationId, status: currentStatus };
  }
  if (currentStatus === 'confirmed') {
    throw new AppError(
      409,
      'CANNOT_RELEASE_CONFIRMED',
      'Confirmed reservations cannot be released directly. Use order item cancellation instead.'
    );
  }

  return { reservation_id: reservationId, status: currentStatus };
}

// POST /api/cart/items { cart_item_id?, offer_id, quantity }
const AddCartItemSchema = z.object({
  cart_item_id: z.string().uuid().optional(),
  offer_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(20),
});

router.post('/items', requireAuth, async (req, res, next) => {
  try {
    const parsed = AddCartItemSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Valid offer_id and quantity (1-20) are required.');
    }
    const { cart_item_id, offer_id, quantity } = parsed.data;
    const userId = req.user!.user_id;

    const item = await withTransaction(async (client) => {
      const offerRes = await client.query<{ selling_price: number; status: string }>(
        `SELECT selling_price, status FROM dealer_offers WHERE offer_id = $1`,
        [offer_id]
      );
      if (offerRes.rowCount !== 1 || offerRes.rows[0].status !== 'active') {
        throw new AppError(404, 'OFFER_NOT_FOUND', 'Offer not found or inactive.');
      }
      const priceSnapshot = offerRes.rows[0].selling_price;

      const cartRes = await client.query<{ cart_id: string }>(
        `INSERT INTO carts (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING cart_id`,
        [userId]
      );
      const cartId = cartRes.rows[0].cart_id;

      if (cart_item_id) {
        const upd = await client.query(
          `UPDATE cart_items
              SET quantity = $2, price_snapshot = $3, saved_for_later = false
            WHERE cart_item_id = $1 AND cart_id = $4
            RETURNING *`,
          [cart_item_id, quantity, priceSnapshot, cartId]
        );
        if (upd.rowCount === 1) return upd.rows[0];
      }

      const existing = await client.query<{ cart_item_id: string; quantity: number }>(
        `SELECT cart_item_id, quantity
           FROM cart_items
          WHERE cart_id = $1 AND offer_id = $2 AND saved_for_later = false
          LIMIT 1`,
        [cartId, offer_id]
      );

      if (existing.rowCount === 1) {
        const upd = await client.query(
          `UPDATE cart_items
              SET quantity = $2, price_snapshot = $3
            WHERE cart_item_id = $1
            RETURNING *`,
          [existing.rows[0].cart_item_id, quantity, priceSnapshot]
        );
        return upd.rows[0];
      }

      const ins = await client.query(
        `INSERT INTO cart_items (cart_id, offer_id, quantity, price_snapshot, saved_for_later)
         VALUES ($1, $2, $3, $4, false)
         RETURNING *`,
        [cartId, offer_id, quantity, priceSnapshot]
      );
      return ins.rows[0];
    });

    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

// GET /api/cart (revalidates price + stock)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.user_id;
    const pool = getPool();

    const rowsRes = await pool.query(
      `SELECT ci.cart_item_id,
              ci.offer_id,
              ci.quantity,
              ci.price_snapshot,
              ci.reservation_id,
              ci.saved_for_later,
              o.selling_price AS current_price_paise,
              (o.selling_price <> ci.price_snapshot) AS price_changed,
              o.status AS offer_status,
              o.eligible_modes,
              o.bangalore_delivery_days,
              o.transfer_days_max,
              p.product_id,
              p.name AS product_name,
              p.brand,
              p.image_url,
              d.dealer_id,
              d.shop_name,
              d.city AS dealer_city,
              r.status AS reservation_status,
              r.expires_at AS reservation_expires_at,
              r.price_paise AS reservation_price_paise,
              r.location_id AS reservation_location_id,
              coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0)::int AS available_units,
              (
                SELECT i2.location_id
                  FROM inventory i2
                  JOIN stock_locations l2 ON l2.location_id = i2.location_id
                  LEFT JOIN fulfilment_hubs h2 ON h2.location_id = l2.location_id
                 WHERE i2.offer_id = o.offer_id
                   AND l2.is_sellable = true
                   AND (h2.hub_id IS NULL OR h2.active = true)
                   AND (i2.quantity - i2.reserved_quantity) > 0
                 ORDER BY (l2.location_type = 'hub') DESC, l2.is_home DESC, (i2.quantity - i2.reserved_quantity) DESC
                 LIMIT 1
              ) AS preferred_location_id
         FROM carts c
         JOIN cart_items ci ON ci.cart_id = c.cart_id
         JOIN dealer_offers o ON o.offer_id = ci.offer_id
         JOIN products p ON p.product_id = o.product_id
         JOIN dealers d ON d.dealer_id = o.dealer_id
         LEFT JOIN reservations r ON r.reservation_id = ci.reservation_id
         LEFT JOIN inventory i ON i.offer_id = o.offer_id
         LEFT JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
        WHERE c.user_id = $1
        GROUP BY ci.cart_item_id, o.offer_id, p.product_id, d.dealer_id,
                 r.status, r.expires_at, r.price_paise, r.location_id
        ORDER BY ci.cart_item_id ASC`,
      [userId]
    );

    const activeItems = rowsRes.rows.filter((r) => !r.saved_for_later);
    const savedItems = rowsRes.rows.filter((r) => r.saved_for_later);
    const subtotalPaise = activeItems.reduce(
      (sum, item) => sum + Number(item.current_price_paise) * Number(item.quantity),
      0
    );

    res.json({
      items: activeItems,
      saved_items: isFlagEnabled('FEATURE_SAVE_LATER') ? savedItems : [],
      subtotal_paise: subtotalPaise,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart/items/:cartItemId -> releases any attached hold in same txn
router.delete('/items/:cartItemId', requireAuth, async (req, res, next) => {
  try {
    const cartItemId = req.params.cartItemId;
    const userId = req.user!.user_id;

    const result = await withTransaction(async (client) => {
      const del = await client.query<{ reservation_id: string | null }>(
        `DELETE FROM cart_items ci
          USING carts c
          WHERE ci.cart_item_id = $1
            AND ci.cart_id = c.cart_id
            AND c.user_id = $2
          RETURNING ci.reservation_id`,
        [cartItemId, userId]
      );

      if (del.rowCount !== 1) {
        throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found.');
      }

      const reservationId = del.rows[0].reservation_id;
      let releasedStatus: string | null = null;
      if (reservationId) {
        try {
          const rel = await releaseReservationInTxn(client, reservationId, userId);
          releasedStatus = rel.status;
        } catch (err) {
          if (err instanceof AppError && err.code === 'CANNOT_RELEASE_CONFIRMED') {
            releasedStatus = 'confirmed';
          } else {
            throw err;
          }
        }
      }

      return { deleted: true, reservation_id: reservationId, reservation_status: releasedStatus };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/items/:id/save-for-later [FEATURE_SAVE_LATER]
router.post('/items/:id/save-for-later', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_SAVE_LATER')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Save for later is disabled.');
    }
    const cartItemId = req.params.id;
    const userId = req.user!.user_id;

    const item = await withTransaction(async (client) => {
      const cur = await client.query<{ reservation_id: string | null }>(
        `SELECT ci.reservation_id
           FROM cart_items ci
           JOIN carts c ON c.cart_id = ci.cart_id
          WHERE ci.cart_item_id = $1 AND c.user_id = $2`,
        [cartItemId, userId]
      );
      if (cur.rowCount !== 1) {
        throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found.');
      }
      if (cur.rows[0].reservation_id) {
        await releaseReservationInTxn(client, cur.rows[0].reservation_id, userId);
      }
      const upd = await client.query(
        `UPDATE cart_items
            SET saved_for_later = true, reservation_id = null
          WHERE cart_item_id = $1
          RETURNING *`,
        [cartItemId]
      );
      return upd.rows[0];
    });

    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/items/:id/restore [FEATURE_SAVE_LATER]
router.post('/items/:id/restore', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_SAVE_LATER')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Save for later is disabled.');
    }
    const cartItemId = req.params.id;
    const userId = req.user!.user_id;

    const result = await withTransaction(async (client) => {
      const cur = await client.query<{
        cart_item_id: string;
        offer_id: string;
        quantity: number;
        price_snapshot: number;
        current_price: number;
        free_units: number;
      }>(
        `SELECT ci.cart_item_id, ci.offer_id, ci.quantity, ci.price_snapshot,
                o.selling_price AS current_price,
                coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                  then i.quantity - i.reserved_quantity else 0 end), 0)::int AS free_units
           FROM cart_items ci
           JOIN carts c ON c.cart_id = ci.cart_id
           JOIN dealer_offers o ON o.offer_id = ci.offer_id
           LEFT JOIN inventory i ON i.offer_id = o.offer_id
           LEFT JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE ci.cart_item_id = $1 AND c.user_id = $2
          GROUP BY ci.cart_item_id, ci.offer_id, ci.quantity, ci.price_snapshot, o.selling_price`,
        [cartItemId, userId]
      );
      if (cur.rowCount !== 1) {
        throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found.');
      }
      const row = cur.rows[0];
      const priceChanged = row.current_price !== row.price_snapshot;
      const inStock = row.free_units >= row.quantity;

      const upd = await client.query(
        `UPDATE cart_items
            SET saved_for_later = false,
                price_snapshot = $2
          WHERE cart_item_id = $1
          RETURNING *`,
        [cartItemId, row.current_price]
      );

      return {
        item: upd.rows[0],
        price_changed: priceChanged,
        old_price_paise: row.price_snapshot,
        new_price_paise: row.current_price,
        in_stock: inStock,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/reserve { cart_item_id?, offer_id, location_id?, quantity, request_key }
const ReserveSchema = z.object({
  cart_item_id: z.string().uuid().optional(),
  offer_id: z.string().uuid(),
  location_id: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(20),
  request_key: z.string().min(4).max(128),
});

router.post('/reserve', requireAuth, async (req, res, next) => {
  try {
    const parsed = ReserveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'offer_id, quantity, and request_key are required.');
    }
    const { cart_item_id, offer_id, location_id, quantity, request_key } = parsed.data;
    const userId = req.user!.user_id;
    const pool = getPool();

    let resolvedLocationId = location_id || null;

    if (resolvedLocationId) {
      // Bangalore-first fallback if requested location has no free units but is_home does
      const locCheck = await pool.query<{ free_units: number }>(
        `SELECT (i.quantity - i.reserved_quantity)::int AS free_units
           FROM inventory i
           JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE i.offer_id = $1 AND i.location_id = $2
            AND l.is_sellable = true AND (h.hub_id IS NULL OR h.active = true)`,
        [offer_id, resolvedLocationId]
      );
      const reqFree = locCheck.rows[0]?.free_units ?? 0;
      if (reqFree < quantity) {
        const homeFallback = await pool.query<{ location_id: string }>(
          `SELECT i.location_id
             FROM inventory i
             JOIN stock_locations l ON l.location_id = i.location_id
            WHERE i.offer_id = $1
              AND l.is_home = true
              AND l.is_sellable = true
              AND (i.quantity - i.reserved_quantity) >= $2
            LIMIT 1`,
          [offer_id, quantity]
        );
        if ((homeFallback.rowCount ?? 0) === 1) {
          resolvedLocationId = homeFallback.rows[0].location_id;
        }
      }
    } else {
      const autoLoc = await pool.query<{ location_id: string }>(
        `SELECT i.location_id
           FROM inventory i
           JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE i.offer_id = $1
            AND l.is_sellable = true
            AND (h.hub_id IS NULL OR h.active = true)
            AND (i.quantity - i.reserved_quantity) >= $2
          ORDER BY (l.location_type = 'hub') DESC, l.is_home DESC, (i.quantity - i.reserved_quantity) DESC
          LIMIT 1`,
        [offer_id, quantity]
      );
      if (autoLoc.rowCount !== 1) {
        throw new AppError(409, 'OUT_OF_STOCK', 'No sellable inventory available for this offer.');
      }
      resolvedLocationId = autoLoc.rows[0].location_id;
    }

    const r = await pool.query<{
      reservation_id: string;
      expires_at: string;
      price_paise: number;
      location_id: string;
      status: string;
    }>(
      `SELECT reservation_id, expires_at, price_paise, location_id, status
         FROM reserve_offer($1, $2, $3, $4, $5, $6)`,
      [userId, offer_id, resolvedLocationId, quantity, request_key, cart_item_id || null]
    );

    const row = r.rows[0];
    res.status(201).json({
      reservation_id: row.reservation_id,
      expires_at: row.expires_at,
      price_paise: row.price_paise,
      location_id: row.location_id,
      status: row.status,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/release { reservation_id }
const ReleaseSchema = z.object({
  reservation_id: z.string().uuid(),
});

router.post('/release', requireAuth, async (req, res, next) => {
  try {
    const parsed = ReleaseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Valid reservation_id is required.');
    }
    const result = await withTransaction((client) =>
      releaseReservationInTxn(client, parsed.data.reservation_id, req.user!.user_id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
