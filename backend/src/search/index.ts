import { Client } from '@opensearch-project/opensearch';
import { env, readOptionalCaCert } from '../config/env.ts';
import { AppError, getPool } from '../db/pool.ts';
import { TRUTH_STATEMENT_SQL } from '../db/stockHelpers.ts';

export const OFFERS_INDEX = 'offers';

let osClient: Client | null = null;

export function isOpenSearchConfigured(): boolean {
  return Boolean(env.opensearchUrl);
}

export function getOpenSearchClient(): Client {
  if (!env.opensearchUrl) {
    throw new AppError(
      503,
      'SERVICE_NOT_CONFIGURED',
      'Aiven OpenSearch is not configured. Set OPENSEARCH_URL in environment variables.',
      { missing: ['OPENSEARCH_URL'] }
    );
  }

  if (!osClient) {
    const ca = readOptionalCaCert();
    osClient = new Client({
      node: env.opensearchUrl,
      auth:
        env.opensearchUser && env.opensearchPassword
          ? { username: env.opensearchUser, password: env.opensearchPassword }
          : undefined,
      ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    });
  }
  return osClient;
}

export async function ensureIndex(): Promise<void> {
  const client = getOpenSearchClient();
  const existsRes = await client.indices.exists({ index: OFFERS_INDEX });
  const exists = typeof existsRes.body === 'boolean' ? existsRes.body : Boolean(existsRes);
  if (exists) return;

  await client.indices.create({
    index: OFFERS_INDEX,
    body: {
      settings: {
        analysis: {
          normalizer: {
            lowercase_normalizer: {
              type: 'custom',
              filter: ['lowercase', 'asciifolding'],
            },
          },
        },
      },
      mappings: {
        properties: {
          offer_id: { type: 'keyword' },
          product_id: { type: 'keyword' },
          product_name: { type: 'text' },
          brand: { type: 'text' },
          category_name: { type: 'keyword', normalizer: 'lowercase_normalizer' },
          dealer_id: { type: 'keyword' },
          shop_name: { type: 'text' },
          dealer_city: { type: 'keyword', normalizer: 'lowercase_normalizer' },
          dealer_state: { type: 'keyword', normalizer: 'lowercase_normalizer' },
          origin_city: { type: 'keyword', normalizer: 'lowercase_normalizer' },
          origin_state: { type: 'keyword', normalizer: 'lowercase_normalizer' },
          is_outside_bangalore: { type: 'boolean' },
          fulfilment_route: { type: 'keyword' },
          selling_price: { type: 'long' },
          available_units: { type: 'integer' },
          home_units: { type: 'integer' },
          eligible_modes: { type: 'keyword' },
          bangalore_delivery_days: { type: 'integer' },
          transfer_days_max: { type: 'integer' },
          effective_days: { type: 'integer' },
          dealer_rating: { type: 'float' },
          total_reviews: { type: 'integer' },
          verified: { type: 'boolean' },
          warranty_months: { type: 'integer' },
          status: { type: 'keyword' },
          revision: { type: 'long' },
        },
      },
    },
  });
}

export async function upsertOffer(
  offerId: string
): Promise<{ revision: number; outcome: 'written' | 'stale' }> {
  const truthRes = await getPool().query(TRUTH_STATEMENT_SQL, [offerId]);
  if (truthRes.rowCount !== 1) {
    throw new AppError(404, 'OFFER_NOT_FOUND', `Offer ${offerId} not found for indexing.`);
  }
  const row = truthRes.rows[0];
  const revision = Number(row.revision);
  const homeUnits = Number(row.home_units);
  const effectiveDays =
    homeUnits > 0 && row.bangalore_delivery_days !== null
      ? Number(row.bangalore_delivery_days)
      : Number(row.transfer_days_max ?? row.bangalore_delivery_days ?? 3);

  const isOutsideBangalore = row.dealer_city?.toLowerCase() !== 'bangalore';
  const fulfilmentRoute = homeUnits > 0 ? 'bangalore' : 'transfer';

  // Locked document fields ONLY — never quick_available, hub_units, reference price, or OTPs
  const doc = {
    offer_id: row.offer_id,
    product_id: row.product_id,
    product_name: row.product_name,
    brand: row.brand,
    category_name: row.category_name,
    specs: row.specs || {},
    dealer_id: row.dealer_id,
    shop_name: row.shop_name,
    dealer_city: row.dealer_city,
    dealer_state: row.dealer_state,
    origin_city: row.origin_city || row.dealer_city,
    origin_state: row.origin_state || row.dealer_state,
    is_outside_bangalore: isOutsideBangalore,
    fulfilment_route: fulfilmentRoute,
    selling_price: Number(row.selling_price),
    available_units: Number(row.available_units),
    home_units: homeUnits,
    eligible_modes: row.eligible_modes || ['standard'],
    bangalore_delivery_days: row.bangalore_delivery_days,
    transfer_days_max: row.transfer_days_max,
    effective_days: effectiveDays,
    dealer_rating: Number(row.dealer_rating),
    total_reviews: Number(row.total_reviews),
    verified: Boolean(row.verified),
    warranty_months: Number(row.warranty_months),
    status: row.status,
    revision,
  };

  const client = getOpenSearchClient();
  try {
    await client.index({
      index: OFFERS_INDEX,
      id: offerId,
      version: revision,
      version_type: 'external_gte',
      refresh: true,
      body: doc,
    });
    return { revision, outcome: 'written' };
  } catch (err: unknown) {
    const osErr = err as { statusCode?: number; meta?: { statusCode?: number } };
    const statusCode = osErr?.statusCode ?? osErr?.meta?.statusCode;
    if (statusCode === 409) {
      // 409 version_conflict = newer revision already indexed = SUCCESS
      return { revision, outcome: 'stale' };
    }
    throw err;
  }
}

export async function searchOffers(params: {
  q?: string;
  category?: string;
  maxPricePaise?: number;
  city?: string;
  limit?: number;
}): Promise<{ hits: Array<{ offer_id: string; product_id: string }> }> {
  const client = getOpenSearchClient();
  const must: Record<string, unknown>[] = [];
  const filter: Record<string, unknown>[] = [{ term: { status: 'active' } }];

  if (params.q && params.q.trim()) {
    must.push({
      multi_match: {
        query: params.q.trim(),
        fields: ['product_name^3', 'brand^2', 'category_name', 'shop_name'],
        fuzziness: 'AUTO',
        prefix_length: 1,
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  if (params.category && params.category.trim()) {
    filter.push({ term: { category_name: params.category.trim().toLowerCase() } });
  }
  if (params.city && params.city.trim()) {
    filter.push({ term: { dealer_city: params.city.trim().toLowerCase() } });
  }
  if (params.maxPricePaise && Number.isFinite(params.maxPricePaise) && params.maxPricePaise > 0) {
    filter.push({ range: { selling_price: { lte: params.maxPricePaise } } });
  }

  const res = await client.search({
    index: OFFERS_INDEX,
    size: params.limit ?? 60,
    body: {
      _source: ['offer_id', 'product_id'],
      query: {
        bool: {
          must,
          filter,
        },
      },
    },
  });

  const hitsArr = (res.body?.hits?.hits || []) as Array<{
    _source?: { offer_id: string; product_id: string };
  }>;

  return {
    hits: hitsArr
      .map((h) => h._source)
      .filter((s): s is { offer_id: string; product_id: string } => Boolean(s?.offer_id)),
  };
}

export async function getIndexedOfferDoc(offerId: string): Promise<Record<string, unknown> | null> {
  if (!isOpenSearchConfigured()) return null;
  const client = getOpenSearchClient();
  try {
    const res = await client.get({ index: OFFERS_INDEX, id: offerId });
    return {
      _id: res.body?._id,
      _version: res.body?._version,
      found: res.body?.found,
      source: res.body?._source,
    };
  } catch (err: unknown) {
    const osErr = err as { statusCode?: number; meta?: { statusCode?: number } };
    if ((osErr?.statusCode ?? osErr?.meta?.statusCode) === 404) {
      return null;
    }
    throw err;
  }
}
