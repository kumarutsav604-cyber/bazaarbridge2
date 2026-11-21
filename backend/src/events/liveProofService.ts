import { getPool } from '../db/pool.ts';
import { getIndexedOfferDoc, isOpenSearchConfigured } from '../search/index.ts';

export async function getLiveProofSnapshot(offerId?: string): Promise<{
  outbox: Array<Record<string, unknown>>;
  processed_events: Array<Record<string, unknown>>;
  opensearch_doc: Record<string, unknown> | null;
  pg_revision: number | null;
}> {
  const pool = getPool();

  const outboxRes = await pool.query(
    `SELECT event_id, event_type, aggregate_key, payload, created_at, published_at
       FROM outbox_events
      ORDER BY created_at DESC
      LIMIT 30`
  );

  const processedRes = await pool.query(
    `SELECT event_id, consumer_name, processed_at
       FROM processed_events
      ORDER BY processed_at DESC
      LIMIT 30`
  );

  let targetOfferId = offerId;
  if (!targetOfferId) {
    const firstOffer = await pool.query<{ offer_id: string }>(
      `SELECT offer_id FROM offer_state_versions ORDER BY updated_at DESC LIMIT 1`
    );
    targetOfferId = firstOffer.rows[0]?.offer_id;
  }

  let pgRevision: number | null = null;
  let opensearchDoc: Record<string, unknown> | null = null;
  if (targetOfferId) {
    const revRes = await pool.query<{ revision: number }>(
      `SELECT revision FROM offer_state_versions WHERE offer_id = $1`,
      [targetOfferId]
    );
    pgRevision = revRes.rows[0]?.revision ?? null;
    if (isOpenSearchConfigured()) {
      try {
        opensearchDoc = await getIndexedOfferDoc(targetOfferId);
      } catch {
        opensearchDoc = null;
      }
    }
  }

  return {
    outbox: outboxRes.rows,
    processed_events: processedRes.rows,
    opensearch_doc: opensearchDoc,
    pg_revision: pgRevision,
  };
}
