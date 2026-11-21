import { Router } from 'express';
import { isFlagEnabled } from '../config/env.ts';
import { AppError, getPool } from '../db/pool.ts';
import {
  rankOffersByCategory,
  type ComparisonCategory,
  type EligibleOfferRow,
} from '../domain/comparison.ts';
import { optionalAuth } from '../middleware/auth.ts';

const router = Router();

const VALID_CATEGORIES = new Set<ComparisonCategory>([
  'budget',
  'fastest',
  'rated',
  'value',
  'available',
]);

async function fetchEligibleOffersForProduct(productId: string): Promise<EligibleOfferRow[]> {
  const pool = getPool();
  const res = await pool.query<EligibleOfferRow>(
    `SELECT o.offer_id,
            o.product_id,
            p.name AS product_name,
            d.dealer_id,
            d.shop_name,
            d.city AS dealer_city,
            d.dealer_rating::float AS dealer_rating,
            d.total_reviews,
            d.verified,
            o.selling_price,
            o.status,
            o.bangalore_delivery_days,
            o.transfer_days_min,
            o.transfer_days_max,
            o.warranty_months,
            o.warranty_note,
            o.eligible_modes,
            coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
              then i.quantity - i.reserved_quantity else 0 end), 0)::int AS sellable_free_units,
            coalesce(sum(case when l.is_sellable and l.is_home
              then i.quantity - i.reserved_quantity else 0 end), 0)::int AS home_units,
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
            ) AS preferred_location_id,
            (
              SELECT l2.name
                FROM inventory i2
                JOIN stock_locations l2 ON l2.location_id = i2.location_id
                LEFT JOIN fulfilment_hubs h2 ON h2.location_id = l2.location_id
               WHERE i2.offer_id = o.offer_id
                 AND l2.is_sellable = true
                 AND (h2.hub_id IS NULL OR h2.active = true)
                 AND (i2.quantity - i2.reserved_quantity) > 0
               ORDER BY l2.is_home DESC, (l2.location_type = 'hub') DESC, (i2.quantity - i2.reserved_quantity) DESC
               LIMIT 1
            ) AS preferred_location_name
       FROM dealer_offers o
       JOIN products p ON p.product_id = o.product_id
       JOIN dealers d ON d.dealer_id = o.dealer_id
       LEFT JOIN inventory i ON i.offer_id = o.offer_id
       LEFT JOIN stock_locations l ON l.location_id = i.location_id
       LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
      WHERE o.product_id = $1
        AND o.status = 'active'
      GROUP BY o.offer_id, o.product_id, p.name, d.dealer_id, d.shop_name, d.city,
               d.dealer_rating, d.total_reviews, d.verified, o.selling_price, o.status,
               o.bangalore_delivery_days, o.transfer_days_min, o.transfer_days_max,
               o.warranty_months, o.warranty_note, o.eligible_modes
     HAVING coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
              then i.quantity - i.reserved_quantity else 0 end), 0) > 0`,
    [productId]
  );
  return res.rows;
}

// GET /api/products?category=
router.get('/products', optionalAuth, async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const pool = getPool();

    const params: unknown[] = [];
    let categoryWhere = '';
    if (category) {
      params.push(category);
      categoryWhere = `AND lower(c.category_name) = lower($1)`;
    }

    const result = await pool.query(
      `SELECT p.product_id,
              p.name,
              p.description,
              p.brand,
              p.specs,
              p.image_url,
              c.category_id,
              c.category_name,
              count(DISTINCT o.offer_id) FILTER (WHERE o.status = 'active')::int AS dealer_count,
              min(o.selling_price) FILTER (WHERE o.status = 'active') AS min_price_paise,
              max(d.dealer_rating)::float AS top_dealer_rating,
              coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0)::int AS total_free_units,
              bool_or(l.location_type = 'hub' AND h.active = true AND 'quick' = ANY(o.eligible_modes) AND (i.quantity - i.reserved_quantity) > 0) AS quick_available
         FROM products p
         JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN dealer_offers o ON o.product_id = p.product_id AND o.status = 'active'
         LEFT JOIN dealers d ON d.dealer_id = o.dealer_id
         LEFT JOIN inventory i ON i.offer_id = o.offer_id
         LEFT JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
        WHERE 1=1 ${categoryWhere}
        GROUP BY p.product_id, c.category_id, c.category_name
        ORDER BY dealer_count DESC, p.name ASC`,
      params
    );

    const catRes = await pool.query(
      `SELECT category_id, category_name FROM categories ORDER BY category_name ASC`
    );

    res.json({
      products: result.rows,
      categories: catRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/compare?ids=a,b,c [FEATURE_COMPARE]
router.get('/products/compare', optionalAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_COMPARE')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Side-by-side comparison feature is disabled.');
    }
    const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = idsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);

    if (ids.length === 0) {
      res.json({ products: [] });
      return;
    }

    const pool = getPool();
    const resRows = await pool.query(
      `SELECT p.product_id, p.name, p.brand, p.description, p.specs, p.image_url,
              c.category_name,
              min(o.selling_price) FILTER (WHERE o.status = 'active') AS min_price_paise,
              count(DISTINCT o.offer_id) FILTER (WHERE o.status = 'active')::int AS dealer_count
         FROM products p
         JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN dealer_offers o ON o.product_id = p.product_id
        WHERE p.product_id = ANY($1::uuid[])
        GROUP BY p.product_id, c.category_name`,
      [ids]
    );

    res.json({ products: resRows.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id
router.get('/products/:id', optionalAuth, async (req, res, next) => {
  try {
    const productId = req.params.id;
    const pool = getPool();

    const prodRes = await pool.query(
      `SELECT p.product_id, p.name, p.description, p.brand, p.specs, p.image_url,
              c.category_id, c.category_name
         FROM products p
         JOIN categories c ON c.category_id = p.category_id
        WHERE p.product_id = $1`,
      [productId]
    );

    if (prodRes.rowCount !== 1) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    }

    if (req.user) {
      // Best-effort recently viewed tracking (cap 8)
      await pool.query(
        `INSERT INTO recently_viewed (user_id, product_id, viewed_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id, product_id) DO UPDATE SET viewed_at = now()`,
        [req.user.user_id, productId]
      );
    }

    const offers = await fetchEligibleOffersForProduct(productId);
    const locationsRes = await pool.query(
      `SELECT i.offer_id, i.location_id, l.name AS location_name, l.city, l.state,
              l.location_type, l.is_home, l.is_sellable,
              (i.quantity - i.reserved_quantity)::int AS free_units,
              coalesce(h.active, true) AS hub_active
         FROM inventory i
         JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
         JOIN dealer_offers o ON o.offer_id = i.offer_id
        WHERE o.product_id = $1
          AND l.is_sellable = true
          AND (h.hub_id IS NULL OR h.active = true)
          AND (i.quantity - i.reserved_quantity) > 0`,
      [productId]
    );

    res.json({
      product: prodRes.rows[0],
      offers,
      stock_locations: locationsRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id/offers?category=budget|fastest|rated|value|available
// Uses one dedicated SQL query per category per v7.2 comparison rules
router.get('/products/:id/offers', optionalAuth, async (req, res, next) => {
  try {
    const productId = req.params.id;
    const rawCat = typeof req.query.category === 'string' ? req.query.category.trim() : 'budget';
    const category: ComparisonCategory = VALID_CATEGORIES.has(rawCat as ComparisonCategory)
      ? (rawCat as ComparisonCategory)
      : 'budget';

    const pool = getPool();
    let sqlRankedRows: EligibleOfferRow[] = [];

    if (category === 'budget') {
      const r = await pool.query<EligibleOfferRow>(
        `SELECT o.offer_id, o.product_id, p.name AS product_name, d.dealer_id, d.shop_name,
                d.city AS dealer_city, d.dealer_rating::float AS dealer_rating, d.total_reviews, d.verified,
                o.selling_price, o.status, o.bangalore_delivery_days, o.transfer_days_min, o.transfer_days_max,
                o.warranty_months, o.warranty_note, o.eligible_modes,
                coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0)::int AS sellable_free_units,
                coalesce(sum(case when l.is_sellable and l.is_home then i.quantity - i.reserved_quantity else 0 end), 0)::int AS home_units
           FROM dealer_offers o
           JOIN products p ON p.product_id = o.product_id
           JOIN dealers d ON d.dealer_id = o.dealer_id
           LEFT JOIN inventory i ON i.offer_id = o.offer_id
           LEFT JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE o.product_id = $1 AND o.status = 'active'
          GROUP BY o.offer_id, p.name, d.dealer_id
         HAVING coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0) > 0
          ORDER BY o.selling_price ASC,
                   (case when coalesce(sum(case when l.is_sellable and l.is_home then i.quantity - i.reserved_quantity else 0 end), 0) > 0 then o.bangalore_delivery_days else coalesce(o.transfer_days_max, 3) end) ASC,
                   d.dealer_rating DESC`,
        [productId]
      );
      sqlRankedRows = r.rows;
    } else if (category === 'fastest') {
      const r = await pool.query<EligibleOfferRow>(
        `SELECT o.offer_id, o.product_id, p.name AS product_name, d.dealer_id, d.shop_name,
                d.city AS dealer_city, d.dealer_rating::float AS dealer_rating, d.total_reviews, d.verified,
                o.selling_price, o.status, o.bangalore_delivery_days, o.transfer_days_min, o.transfer_days_max,
                o.warranty_months, o.warranty_note, o.eligible_modes,
                coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0)::int AS sellable_free_units,
                coalesce(sum(case when l.is_sellable and l.is_home then i.quantity - i.reserved_quantity else 0 end), 0)::int AS home_units
           FROM dealer_offers o
           JOIN products p ON p.product_id = o.product_id
           JOIN dealers d ON d.dealer_id = o.dealer_id
           LEFT JOIN inventory i ON i.offer_id = o.offer_id
           LEFT JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE o.product_id = $1 AND o.status = 'active'
          GROUP BY o.offer_id, p.name, d.dealer_id
         HAVING coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0) > 0
          ORDER BY (case when coalesce(sum(case when l.is_sellable and l.is_home then i.quantity - i.reserved_quantity else 0 end), 0) > 0 then o.bangalore_delivery_days else coalesce(o.transfer_days_max, 3) end) ASC,
                   o.selling_price ASC`,
        [productId]
      );
      sqlRankedRows = r.rows;
    } else if (category === 'rated') {
      const r = await pool.query<EligibleOfferRow>(
        `SELECT o.offer_id, o.product_id, p.name AS product_name, d.dealer_id, d.shop_name,
                d.city AS dealer_city, d.dealer_rating::float AS dealer_rating, d.total_reviews, d.verified,
                o.selling_price, o.status, o.bangalore_delivery_days, o.transfer_days_min, o.transfer_days_max,
                o.warranty_months, o.warranty_note, o.eligible_modes,
                coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0)::int AS sellable_free_units,
                coalesce(sum(case when l.is_sellable and l.is_home then i.quantity - i.reserved_quantity else 0 end), 0)::int AS home_units
           FROM dealer_offers o
           JOIN products p ON p.product_id = o.product_id
           JOIN dealers d ON d.dealer_id = o.dealer_id
           LEFT JOIN inventory i ON i.offer_id = o.offer_id
           LEFT JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE o.product_id = $1 AND o.status = 'active'
          GROUP BY o.offer_id, p.name, d.dealer_id
         HAVING coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0) > 0
          ORDER BY d.dealer_rating DESC, d.total_reviews DESC, o.selling_price ASC`,
        [productId]
      );
      sqlRankedRows = r.rows;
    } else if (category === 'available') {
      const r = await pool.query<EligibleOfferRow>(
        `SELECT o.offer_id, o.product_id, p.name AS product_name, d.dealer_id, d.shop_name,
                d.city AS dealer_city, d.dealer_rating::float AS dealer_rating, d.total_reviews, d.verified,
                o.selling_price, o.status, o.bangalore_delivery_days, o.transfer_days_min, o.transfer_days_max,
                o.warranty_months, o.warranty_note, o.eligible_modes,
                coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0)::int AS sellable_free_units,
                coalesce(sum(case when l.is_sellable and l.is_home then i.quantity - i.reserved_quantity else 0 end), 0)::int AS home_units
           FROM dealer_offers o
           JOIN products p ON p.product_id = o.product_id
           JOIN dealers d ON d.dealer_id = o.dealer_id
           LEFT JOIN inventory i ON i.offer_id = o.offer_id
           LEFT JOIN stock_locations l ON l.location_id = i.location_id
           LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
          WHERE o.product_id = $1 AND o.status = 'active'
          GROUP BY o.offer_id, p.name, d.dealer_id
         HAVING coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active) then i.quantity - i.reserved_quantity else 0 end), 0) > 0
          ORDER BY sellable_free_units DESC, o.selling_price ASC`,
        [productId]
      );
      sqlRankedRows = r.rows;
    } else {
      // 'value': weighted score computed across eligible rows
      sqlRankedRows = await fetchEligibleOffersForProduct(productId);
    }

    // Enrich preferred_location_id for cart reservation
    const fullOffers = await fetchEligibleOffersForProduct(productId);
    const locByOffer = new Map(fullOffers.map((o) => [o.offer_id, o]));
    const merged = sqlRankedRows.map((row) => ({
      ...row,
      preferred_location_id: locByOffer.get(row.offer_id)?.preferred_location_id ?? null,
      preferred_location_name: locByOffer.get(row.offer_id)?.preferred_location_name ?? null,
    }));

    const result = rankOffersByCategory(merged, category);
    if (!result) {
      res.json({
        category,
        winner: null,
        offers: [],
        reason: 'No active in-stock offers available for this product.',
      });
      return;
    }

    res.json({
      category: result.category,
      winner: result.winner,
      offers: result.ranked,
      reason: result.winner.reason,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id/price-history (30-day reference price, PG only, SAMPLE)
router.get('/products/:id/price-history', optionalAuth, async (req, res, next) => {
  try {
    const productId = req.params.id;
    const pool = getPool();

    const historyRes = await pool.query(
      `SELECT h.history_id, h.offer_id, d.shop_name, h.selling_price, h.valid_from, h.valid_to
         FROM offer_price_history h
         JOIN dealer_offers o ON o.offer_id = h.offer_id
         JOIN dealers d ON d.dealer_id = o.dealer_id
        WHERE o.product_id = $1
          AND h.valid_from >= now() - interval '30 days'
        ORDER BY h.valid_from DESC`,
      [productId]
    );

    const refRes = await pool.query<{
      reference_price_paise: number | null;
      current_min_price_paise: number | null;
    }>(
      `SELECT min(h.selling_price) FILTER (WHERE h.valid_to IS NOT NULL AND h.valid_from >= now() - interval '30 days') AS reference_price_paise,
              min(o.selling_price) FILTER (WHERE o.status = 'active') AS current_min_price_paise
         FROM dealer_offers o
         LEFT JOIN offer_price_history h ON h.offer_id = o.offer_id
        WHERE o.product_id = $1`,
      [productId]
    );

    const ref = refRes.rows[0];
    const showWasPrice =
      ref?.reference_price_paise !== null &&
      ref?.current_min_price_paise !== null &&
      Number(ref.reference_price_paise) > Number(ref.current_min_price_paise);

    res.json({
      product_id: productId,
      reference_price_paise: showWasPrice ? ref.reference_price_paise : null,
      current_min_price_paise: ref?.current_min_price_paise ?? null,
      show_was_price: showWasPrice,
      history: historyRes.rows,
      data_label: 'SAMPLE',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id/related
router.get('/products/:id/related', optionalAuth, async (req, res, next) => {
  try {
    const productId = req.params.id;
    const pool = getPool();

    const resRows = await pool.query(
      `SELECT p2.product_id, p2.name, p2.brand, p2.image_url, c.category_name,
              min(o.selling_price) FILTER (WHERE o.status = 'active') AS min_price_paise
         FROM products p1
         JOIN products p2 ON p2.category_id = p1.category_id AND p2.product_id <> p1.product_id
         JOIN categories c ON c.category_id = p2.category_id
         LEFT JOIN dealer_offers o ON o.product_id = p2.product_id
        WHERE p1.product_id = $1
        GROUP BY p2.product_id, c.category_name
        ORDER BY p2.name ASC
        LIMIT 4`,
      [productId]
    );

    res.json({ related: resRows.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/outside-bangalore -> { section_a: [...], section_b: [...] }
router.get('/outside-bangalore', optionalAuth, async (_req, res, next) => {
  try {
    const pool = getPool();

    // Section A: Outside-Bangalore dealers with units stocked in Bangalore warehouse (faster)
    const sectionA = await pool.query(
      `SELECT o.offer_id, o.product_id, p.name AS product_name, p.brand, p.image_url,
              c.category_name, d.dealer_id, d.shop_name, d.city AS dealer_city,
              d.state AS dealer_state, d.dealer_rating::float AS dealer_rating,
              o.selling_price, o.bangalore_delivery_days,
              l.location_id, l.name AS location_name,
              (i.quantity - i.reserved_quantity)::int AS free_units
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         JOIN categories c ON c.category_id = p.category_id
         JOIN dealers d ON d.dealer_id = o.dealer_id
         JOIN inventory i ON i.offer_id = o.offer_id
         JOIN stock_locations l ON l.location_id = i.location_id
        WHERE o.status = 'active'
          AND lower(d.city) <> 'bangalore'
          AND l.is_home = true
          AND l.is_sellable = true
          AND (i.quantity - i.reserved_quantity) > 0
        ORDER BY o.selling_price ASC`
    );

    // Section B: Stocked at non-Bangalore holding location (moved from another stock location ~2-3 days)
    const sectionB = await pool.query(
      `SELECT o.offer_id, o.product_id, p.name AS product_name, p.brand, p.image_url,
              c.category_name, d.dealer_id, d.shop_name, d.city AS dealer_city,
              d.state AS dealer_state, d.dealer_rating::float AS dealer_rating,
              o.selling_price, o.transfer_days_min, o.transfer_days_max,
              l.location_id, l.name AS location_name, l.city AS holding_city, l.state AS holding_state,
              (i.quantity - i.reserved_quantity)::int AS free_units
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         JOIN categories c ON c.category_id = p.category_id
         JOIN dealers d ON d.dealer_id = o.dealer_id
         JOIN inventory i ON i.offer_id = o.offer_id
         JOIN stock_locations l ON l.location_id = i.location_id
        WHERE o.status = 'active'
          AND l.location_type = 'holding'
          AND l.is_sellable = true
          AND (i.quantity - i.reserved_quantity) > 0
        ORDER BY o.selling_price ASC`
    );

    res.json({
      section_a: sectionA.rows,
      section_b: sectionB.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
