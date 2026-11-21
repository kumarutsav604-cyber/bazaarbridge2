import { Router } from 'express';
import { getPool } from '../db/pool.ts';
import { optionalAuth } from '../middleware/auth.ts';
import { searchOffers } from '../search/index.ts';

const router = Router();

/**
 * GET /api/search?q=&category=&max_price=&city=&quick=
 * 1. OpenSearch supplies candidate offer_ids (typo-tolerant + category/maxPrice/city filters)
 * 2. PostgreSQL rechecks authoritative price, availability, and Quick eligibility
 * 3. Re-applies category, max_price, city, and quick filters AFTER PG recheck
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
    const maxPriceRaw =
      typeof req.query.max_price === 'string' && req.query.max_price.trim() !== ''
        ? parseInt(req.query.max_price, 10)
        : undefined;
    const maxPricePaise =
      maxPriceRaw !== undefined && Number.isFinite(maxPriceRaw) && maxPriceRaw > 0
        ? maxPriceRaw
        : undefined;
    const quickOnly =
      req.query.quick === 'true' || req.query.quick === '1';

    const { hits } = await searchOffers({
      q,
      category: category || undefined,
      maxPricePaise,
      city: city || undefined,
      limit: 60,
    });

    if (hits.length === 0) {
      res.json({ results: [], source: 'opensearch+postgres' });
      return;
    }

    const offerIds = hits.map((h) => h.offer_id);
    const pool = getPool();

    const pgRes = await pool.query<{
      offer_id: string;
      product_id: string;
      product_name: string;
      brand: string;
      image_url: string | null;
      category_name: string;
      dealer_id: string;
      shop_name: string;
      dealer_city: string;
      dealer_state: string;
      dealer_rating: number;
      total_reviews: number;
      selling_price: number;
      bangalore_delivery_days: number | null;
      transfer_days_max: number | null;
      eligible_modes: string[];
      available_units: number;
      home_units: number;
      quick_available: boolean;
      preferred_location_id: string | null;
    }>(
      `SELECT o.offer_id,
              o.product_id,
              p.name AS product_name,
              p.brand,
              p.image_url,
              c.category_name,
              d.dealer_id,
              d.shop_name,
              d.city AS dealer_city,
              d.state AS dealer_state,
              d.dealer_rating::float AS dealer_rating,
              d.total_reviews,
              o.selling_price,
              o.bangalore_delivery_days,
              o.transfer_days_max,
              o.eligible_modes,
              coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0)::int AS available_units,
              coalesce(sum(case when l.is_sellable and l.is_home
                then i.quantity - i.reserved_quantity else 0 end), 0)::int AS home_units,
              bool_or(
                l.location_type = 'hub'
                AND l.is_sellable = true
                AND h.active = true
                AND 'quick' = ANY(o.eligible_modes)
                AND (i.quantity - i.reserved_quantity) > 0
              ) AS quick_available,
              (
                SELECT i2.location_id
                  FROM inventory i2
                  JOIN stock_locations l2 ON l2.location_id = i2.location_id
                  LEFT JOIN fulfilment_hubs h2 ON h2.location_id = l2.location_id
                 WHERE i2.offer_id = o.offer_id
                   AND l2.is_sellable = true
                   AND (h2.hub_id IS NULL OR h2.active = true)
                   AND (i2.quantity - i2.reserved_quantity) > 0
                 ORDER BY l2.is_home DESC, (l2.location_type = 'hub') DESC, (i2.quantity - i2.reserved_quantity) DESC
                 LIMIT 1
              ) AS preferred_location_id
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         JOIN categories c ON c.category_id = p.category_id
         JOIN dealers d ON d.dealer_id = o.dealer_id
         LEFT JOIN inventory i ON i.offer_id = o.offer_id
         LEFT JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
        WHERE o.offer_id = ANY($1::uuid[])
          AND o.status = 'active'
        GROUP BY o.offer_id, p.product_id, c.category_name, d.dealer_id`,
      [offerIds]
    );

    const byOfferId = new Map(pgRes.rows.map((r) => [r.offer_id, r]));

    // Preserve OpenSearch relevance order AND re-apply filters against live PostgreSQL truth
    const filtered = offerIds
      .map((id) => byOfferId.get(id))
      .filter((row): row is NonNullable<typeof row> => {
        if (!row) return false;
        if (row.available_units <= 0) return false;
        if (category && row.category_name.toLowerCase() !== category.toLowerCase()) return false;
        if (city && row.dealer_city.toLowerCase() !== city.toLowerCase()) return false;
        if (maxPricePaise !== undefined && row.selling_price > maxPricePaise) return false;
        if (quickOnly && !row.quick_available) return false;
        return true;
      });

    res.json({
      results: filtered,
      source: 'opensearch+postgres',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/search/filters -> PG-only active categories and dealer cities
router.get('/filters', optionalAuth, async (_req, res, next) => {
  try {
    const pool = getPool();
    const catRes = await pool.query(
      `SELECT DISTINCT c.category_id, c.category_name
         FROM categories c
         JOIN products p ON p.category_id = c.category_id
         JOIN dealer_offers o ON o.product_id = p.product_id
        WHERE o.status = 'active'
        ORDER BY c.category_name ASC`
    );

    const cityRes = await pool.query<{ city: string }>(
      `SELECT DISTINCT d.city
         FROM dealers d
         JOIN dealer_offers o ON o.dealer_id = d.dealer_id
        WHERE o.status = 'active'
        ORDER BY d.city ASC`
    );

    res.json({
      categories: catRes.rows,
      cities: cityRes.rows.map((r) => r.city),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
