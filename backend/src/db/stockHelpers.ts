import { PoolClient } from 'pg';
import { AppError } from './pool.ts';

/**
 * Shared stock movement helpers per BazaarBridge v7.2 agent-rules.md.
 * Every stock movement is ONE conditional statement whose rowCount is checked.
 */

export async function holdUnits(
  client: PoolClient,
  offerId: string,
  locationId: string,
  qty: number
): Promise<void> {
  const res = await client.query(
    `UPDATE inventory i
       SET reserved_quantity = i.reserved_quantity + $3
      FROM stock_locations l
     WHERE i.offer_id = $1
       AND i.location_id = $2
       AND l.location_id = i.location_id
       AND l.is_sellable = true
       AND i.quantity - i.reserved_quantity >= $3`,
    [offerId, locationId, qty]
  );
  if (res.rowCount !== 1) {
    throw new AppError(409, 'OUT_OF_STOCK', 'Insufficient sellable stock available at location.');
  }
}

export async function releaseHold(
  client: PoolClient,
  offerId: string,
  locationId: string,
  qty: number
): Promise<void> {
  const res = await client.query(
    `UPDATE inventory
        SET reserved_quantity = reserved_quantity - $3
      WHERE offer_id = $1
        AND location_id = $2
        AND reserved_quantity >= $3`,
    [offerId, locationId, qty]
  );
  if (res.rowCount !== 1) {
    throw new AppError(409, 'STOCK_RELEASE_FAILED', 'Failed to release reserved stock hold.');
  }
}

export async function deductUnits(
  client: PoolClient,
  offerId: string,
  locationId: string,
  qty: number
): Promise<void> {
  const res = await client.query(
    `UPDATE inventory
        SET quantity = quantity - $3,
            reserved_quantity = reserved_quantity - $3
      WHERE offer_id = $1
        AND location_id = $2
        AND quantity >= $3
        AND reserved_quantity >= $3`,
    [offerId, locationId, qty]
  );
  if (res.rowCount !== 1) {
    throw new Error('INVENTORY_DEDUCTION_FAILED');
  }
}

/**
 * ONE UPSERT per agent-rules.md — creates the destination row if absent
 * (e.g., a Section B transfer offer never previously stocked in Bangalore).
 * MUST be called ONLY after a conditional state transition matched 1 row.
 */
export async function restockUnits(
  client: PoolClient,
  offerId: string,
  locationId: string,
  qty: number
): Promise<number> {
  const res = await client.query<{ quantity: number }>(
    `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (offer_id, location_id)
     DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity
     RETURNING quantity`,
    [offerId, locationId, qty]
  );
  if (res.rowCount !== 1) {
    throw new Error('RESTOCK_UPSERT_FAILED');
  }
  return res.rows[0].quantity;
}

/**
 * Exact TRUTH STATEMENT from agent-rules.md (paused-hub units are NOT available).
 */
export const TRUTH_STATEMENT_SQL = `
  SELECT o.offer_id, o.product_id, o.dealer_id, o.selling_price, o.status,
         o.eligible_modes, o.bangalore_delivery_days, o.transfer_days_min,
         o.transfer_days_max, o.warranty_months,
         p.name AS product_name, p.brand, p.specs,
         c.category_name,
         d.shop_name, d.city AS dealer_city, d.state AS dealer_state,
         d.dealer_rating, d.total_reviews, d.verified,
         v.revision,
         coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
           then i.quantity - i.reserved_quantity else 0 end), 0)::int as available_units,
         coalesce(sum(case when l.is_sellable and l.is_home
           then i.quantity - i.reserved_quantity else 0 end), 0)::int as home_units,
         min(case when l.location_type = 'holding' and l.is_sellable and (i.quantity - i.reserved_quantity) > 0
           then l.city end) as origin_city,
         min(case when l.location_type = 'holding' and l.is_sellable and (i.quantity - i.reserved_quantity) > 0
           then l.state end) as origin_state
  FROM dealer_offers o
  JOIN products p ON p.product_id = o.product_id
  JOIN categories c ON c.category_id = p.category_id
  JOIN dealers d ON d.dealer_id = o.dealer_id
  JOIN offer_state_versions v ON v.offer_id = o.offer_id
  LEFT JOIN inventory i ON i.offer_id = o.offer_id
  LEFT JOIN stock_locations l ON l.location_id = i.location_id
  LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
  WHERE o.offer_id = $1
  GROUP BY o.offer_id, o.product_id, o.dealer_id, o.selling_price, o.status,
           o.eligible_modes, o.bangalore_delivery_days, o.transfer_days_min,
           o.transfer_days_max, o.warranty_months,
           p.name, p.brand, p.specs, c.category_name,
           d.shop_name, d.city, d.state, d.dealer_rating, d.total_reviews, d.verified,
           v.revision
`;
