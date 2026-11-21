import { GoogleGenAI, Type } from '@google/genai';
import { Router } from 'express';
import { z } from 'zod';
import { env, isFlagEnabled } from '../config/env.ts';
import { AppError, getPool } from '../db/pool.ts';
import {
  AssistantFiltersSchema,
  extractRuleBasedFilters,
  type AssistantFilters,
} from '../domain/assistantFilterSchema.ts';
import { requireAuth } from '../middleware/auth.ts';
import { isOpenSearchConfigured, searchOffers } from '../search/index.ts';

const router = Router();

// GET /api/notifications?unread=true
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const pool = getPool();
    const resRows = await pool.query(
      `SELECT notification_id, user_id, message, event_ref, created_at, read_at
         FROM notifications
        WHERE user_id = $1
          ${unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.user!.user_id]
    );
    res.json({ notifications: resRows.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE notifications SET read_at = now()
        WHERE notification_id = $1 AND user_id = $2`,
      [req.params.id, req.user!.user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/wishlist/toggle & GET /api/wishlist [FEATURE_WISHLIST]
router.post('/wishlist/toggle', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_WISHLIST')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Wishlist feature is disabled.');
    }
    const productId = typeof req.body?.product_id === 'string' ? req.body.product_id : '';
    if (!productId) {
      throw new AppError(400, 'INVALID_INPUT', 'product_id is required.');
    }
    const pool = getPool();
    const existing = await pool.query(
      `DELETE FROM user_wishlist WHERE user_id = $1 AND product_id = $2 RETURNING wishlist_id`,
      [req.user!.user_id, productId]
    );
    if ((existing.rowCount ?? 0) > 0) {
      res.json({ wishlisted: false, product_id: productId });
      return;
    }
    await pool.query(
      `INSERT INTO user_wishlist (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user!.user_id, productId]
    );
    res.json({ wishlisted: true, product_id: productId });
  } catch (err) {
    next(err);
  }
});

router.get('/wishlist', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_WISHLIST')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Wishlist feature is disabled.');
    }
    const pool = getPool();
    const rowsRes = await pool.query(
      `SELECT w.wishlist_id, w.added_at, p.product_id, p.name, p.brand, p.image_url,
              c.category_name,
              min(o.selling_price) FILTER (WHERE o.status = 'active') AS min_price_paise,
              coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0)::int AS free_units
         FROM user_wishlist w
         JOIN products p ON p.product_id = w.product_id
         JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN dealer_offers o ON o.product_id = p.product_id AND o.status = 'active'
         LEFT JOIN inventory i ON i.offer_id = o.offer_id
         LEFT JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
        WHERE w.user_id = $1
        GROUP BY w.wishlist_id, p.product_id, c.category_name
        ORDER BY w.added_at DESC`,
      [req.user!.user_id]
    );
    res.json({ items: rowsRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/recently-viewed (cap 8)
router.get('/recently-viewed', requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const rowsRes = await pool.query(
      `SELECT rv.viewed_at, p.product_id, p.name, p.brand, p.image_url, c.category_name,
              min(o.selling_price) FILTER (WHERE o.status = 'active') AS min_price_paise
         FROM recently_viewed rv
         JOIN products p ON p.product_id = rv.product_id
         JOIN categories c ON c.category_id = p.category_id
         LEFT JOIN dealer_offers o ON o.product_id = p.product_id AND o.status = 'active'
        WHERE rv.user_id = $1
        GROUP BY rv.viewed_at, p.product_id, c.category_name
        ORDER BY rv.viewed_at DESC
        LIMIT 8`,
      [req.user!.user_id]
    );
    res.json({ items: rowsRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET/POST/DELETE /api/addresses [FEATURE_ADDRESSES]
const AddressSchema = z.object({
  label: z.string().min(1).max(40).default('Home'),
  recipient_name: z.string().min(1).max(120),
  phone: z.string().min(7).max(20),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  landmark: z.string().max(120).optional(),
  city: z.string().min(1).max(80),
  state: z.string().min(1).max(80),
  pin_code: z.string().regex(/^\d{6}$/),
  instructions: z.string().max(300).optional(),
  is_default: z.boolean().optional(),
});

router.get('/addresses', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_ADDRESSES')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Saved addresses feature is disabled.');
    }
    const pool = getPool();
    const rowsRes = await pool.query(
      `SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [req.user!.user_id]
    );
    res.json({ addresses: rowsRes.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/addresses', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_ADDRESSES')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Saved addresses feature is disabled.');
    }
    const parsed = AddressSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Valid address details and 6-digit PIN code are required.');
    }
    const d = parsed.data;
    const pool = getPool();
    if (d.is_default) {
      await pool.query(`UPDATE customer_addresses SET is_default = false WHERE user_id = $1`, [
        req.user!.user_id,
      ]);
    }
    const ins = await pool.query(
      `INSERT INTO customer_addresses (
         user_id, label, recipient_name, phone, line1, line2, landmark, city, state, pin_code, instructions, is_default
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.user!.user_id,
        d.label,
        d.recipient_name,
        d.phone,
        d.line1,
        d.line2 || null,
        d.landmark || null,
        d.city,
        d.state,
        d.pin_code,
        d.instructions || null,
        Boolean(d.is_default),
      ]
    );
    res.status(201).json({ address: ins.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/addresses/:id', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_ADDRESSES')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Saved addresses feature is disabled.');
    }
    const pool = getPool();
    await pool.query(
      `DELETE FROM customer_addresses WHERE address_id = $1 AND user_id = $2`,
      [req.params.id, req.user!.user_id]
    );
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/coupons/validate { code, basket_total_paise } [FEATURE_COUPONS]
router.post('/coupons/validate', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_COUPONS')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Coupons feature is disabled.');
    }
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const basketTotal = Number(req.body?.basket_total_paise || 0);
    if (!code || !Number.isFinite(basketTotal) || basketTotal <= 0) {
      throw new AppError(400, 'INVALID_INPUT', 'Coupon code and basket_total_paise are required.');
    }

    const pool = getPool();
    const cRes = await pool.query(
      `SELECT * FROM coupons WHERE upper(code) = upper($1)`,
      [code]
    );
    if (cRes.rowCount !== 1 || !cRes.rows[0].active) {
      throw new AppError(404, 'INVALID_COUPON', 'Coupon code not found or inactive.');
    }
    const coupon = cRes.rows[0];
    const now = Date.now();
    if (now < new Date(coupon.valid_from).getTime() || now > new Date(coupon.valid_to).getTime()) {
      throw new AppError(409, 'COUPON_EXPIRED', 'Coupon has expired.');
    }
    if (coupon.max_redemptions !== null && coupon.redeemed_count >= coupon.max_redemptions) {
      throw new AppError(409, 'COUPON_LIMIT_REACHED', 'Coupon global redemption limit reached.');
    }

    const usageRes = await pool.query<{ used_count: number }>(
      `SELECT used_count FROM coupon_customer_usage WHERE coupon_id = $1 AND user_id = $2`,
      [coupon.coupon_id, req.user!.user_id]
    );
    const used = usageRes.rows[0]?.used_count ?? 0;
    if (used >= coupon.per_customer_limit) {
      throw new AppError(409, 'PER_CUSTOMER_LIMIT_REACHED', 'You have already used this coupon up to its limit.');
    }
    if (basketTotal < Number(coupon.min_basket_paise)) {
      throw new AppError(
        409,
        'MIN_BASKET_NOT_MET',
        `Minimum basket total of ${coupon.min_basket_paise} paise required.`
      );
    }

    const discountPaise =
      coupon.kind === 'fixed_paise'
        ? Math.min(basketTotal, Number(coupon.value))
        : Math.min(basketTotal, Math.floor((basketTotal * Number(coupon.value)) / 100));

    res.json({
      valid: true,
      code: coupon.code,
      kind: coupon.kind,
      value: coupon.value,
      discount_paise: discountPaise,
      min_basket_paise: coupon.min_basket_paise,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/alerts/subscribe [FEATURE_ALERTS]
const AlertSchema = z.object({
  offer_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  type: z.enum(['back_in_stock', 'price_drop']),
  price_threshold_paise: z.number().int().positive().optional(),
});

router.post('/alerts/subscribe', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_ALERTS')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Alerts feature is disabled.');
    }
    const parsed = AlertSchema.safeParse(req.body);
    if (!parsed.success || (!parsed.data.offer_id && !parsed.data.product_id)) {
      throw new AppError(400, 'INVALID_INPUT', 'offer_id or product_id and alert type are required.');
    }
    const d = parsed.data;
    const pool = getPool();
    const ins = await pool.query(
      `INSERT INTO alert_subscriptions (user_id, offer_id, product_id, type, price_threshold_paise)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user!.user_id, d.offer_id || null, d.product_id || null, d.type, d.price_threshold_paise || null]
    );
    res.status(201).json({ subscription: ins.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/shopping-assistant { message } [FEATURE_ASSISTANT]
const assistantRateMap = new Map<string, { count: number; resetAt: number }>();

router.post('/shopping-assistant', requireAuth, async (req, res, next) => {
  try {
    if (!isFlagEnabled('FEATURE_ASSISTANT')) {
      throw new AppError(404, 'FEATURE_DISABLED', 'Shopping assistant feature is disabled.');
    }

    const userId = req.user!.user_id;
    const now = Date.now();
    const rate = assistantRateMap.get(userId);
    if (!rate || now > rate.resetAt) {
      assistantRateMap.set(userId, { count: 1, resetAt: now + 60_000 });
    } else if (rate.count >= 15) {
      throw new AppError(429, 'RATE_LIMITED', 'Assistant rate limit reached. Please try again shortly.');
    } else {
      rate.count += 1;
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 500) {
      throw new AppError(400, 'INVALID_INPUT', 'Message must be 1 to 500 characters.');
    }

    let filters: AssistantFilters = {};
    let fallback = false;
    let assistantMessage = 'Showing matching offers verified against live PostgreSQL inventory.';

    const canCallGemini = Boolean(env.geminiApiKey && env.geminiApiKey !== 'MY_GEMINI_API_KEY');
    if (canCallGemini) {
      const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
      let attempts = 0;
      let parsedFromGemini: AssistantFilters | null = null;

      while (attempts < 2 && !parsedFromGemini) {
        attempts += 1;
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Extract structured shopping search filters from this customer request. Only use fields you are confident about. Never invent budgets when vague. Customer request: "${message}"`,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING },
                  product_type: { type: Type.STRING },
                  connectivity: { type: Type.STRING },
                  features: { type: Type.ARRAY, items: { type: Type.STRING } },
                  max_price: { type: Type.INTEGER },
                  max_delivery_days: { type: Type.INTEGER },
                  city: { type: Type.STRING },
                  delivery_mode: { type: Type.STRING },
                  sort_preference: { type: Type.STRING },
                },
              },
            },
          });

          const rawText = response.text || '';
          const jsonObj = JSON.parse(rawText);
          const validated = AssistantFiltersSchema.safeParse(jsonObj);
          if (validated.success) {
            parsedFromGemini = validated.data;
          }
        } catch {
          // retry once, then fall back
        }
      }

      if (parsedFromGemini) {
        filters = parsedFromGemini;
      } else {
        fallback = true;
        filters = extractRuleBasedFilters(message);
        assistantMessage = 'Assistant timed out or returned invalid filters. Showing rule-based normal search results.';
      }
    } else {
      fallback = true;
      filters = extractRuleBasedFilters(message);
      assistantMessage = 'Showing rule-based normal search results (GEMINI_API_KEY not configured).';
    }

    // Drive search using OpenSearch candidates (if configured) + PostgreSQL truth
    const qTerms = [filters.product_type, filters.connectivity, ...(filters.features || [])]
      .filter(Boolean)
      .join(' ')
      .trim();

    let candidateOfferIds: string[] | null = null;
    if (isOpenSearchConfigured()) {
      try {
        const osRes = await searchOffers({
          q: qTerms || message,
          category: filters.category,
          maxPricePaise: filters.max_price,
          city: filters.city,
          limit: 30,
        });
        candidateOfferIds = osRes.hits.map((h) => h.offer_id);
      } catch {
        candidateOfferIds = null;
      }
    }

    const pool = getPool();
    const pgRes = await pool.query(
      `SELECT o.offer_id, o.product_id, p.name AS product_name, p.brand, p.image_url,
              c.category_name, d.shop_name, d.city AS dealer_city,
              d.dealer_rating::float AS dealer_rating, d.total_reviews,
              o.selling_price, o.bangalore_delivery_days, o.transfer_days_max, o.eligible_modes,
              coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0)::int AS available_units,
              bool_or(l.location_type = 'hub' AND h.active = true AND 'quick' = ANY(o.eligible_modes) AND (i.quantity - i.reserved_quantity) > 0) AS quick_available
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         JOIN categories c ON c.category_id = p.category_id
         JOIN dealers d ON d.dealer_id = o.dealer_id
         LEFT JOIN inventory i ON i.offer_id = o.offer_id
         LEFT JOIN stock_locations l ON l.location_id = i.location_id
         LEFT JOIN fulfilment_hubs h ON h.location_id = l.location_id
        WHERE o.status = 'active'
          ${candidateOfferIds && candidateOfferIds.length > 0 ? 'AND o.offer_id = ANY($1::uuid[])' : ''}
        GROUP BY o.offer_id, p.product_id, c.category_name, d.dealer_id
       HAVING coalesce(sum(case when l.is_sellable and (h.hub_id is null or h.active)
                then i.quantity - i.reserved_quantity else 0 end), 0) > 0
        ORDER BY o.selling_price ASC
        LIMIT 24`,
      candidateOfferIds && candidateOfferIds.length > 0 ? [candidateOfferIds] : []
    );

    const results = pgRes.rows.filter((row) => {
      if (filters.category && row.category_name.toLowerCase() !== filters.category.toLowerCase()) {
        return false;
      }
      if (filters.city && row.dealer_city.toLowerCase() !== filters.city.toLowerCase()) {
        return false;
      }
      if (filters.max_price && Number(row.selling_price) > filters.max_price) {
        return false;
      }
      if (filters.delivery_mode === 'quick' && !row.quick_available) {
        return false;
      }
      return true;
    });

    if (results.length === 0) {
      assistantMessage =
        'No live in-stock offers matched every constraint. Try relaxing one filter such as max price or city.';
    }

    res.json({
      filters,
      results,
      message: assistantMessage,
      fallback,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
