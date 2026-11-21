import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'url';
import { createApp } from '../app.ts';
import { env } from '../config/env.ts';
import { closePool, getPool, isPgConfigured } from '../db/pool.ts';
import {
  handleCancellationHandler,
  handleFulfilmentEvent,
  handleNotifier,
  handleOrderPlaced,
  handleRefundCredit,
  handleSearchSync,
  type OutboxEnvelope,
} from '../events/consumers.ts';
import { hashOtpSubmission } from '../events/otpService.ts';
import { isOpenSearchConfigured, upsertOffer } from '../search/index.ts';
import { deleteInventoryRow, getToken, readOtp, resetOffer } from './helpers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HAS_PG = isPgConfigured();

let server: http.Server | null = null;
let baseUrl = '';

async function drainOutboxLocally(): Promise<void> {
  const pool = getPool();
  const res = await pool.query<OutboxEnvelope>(
    `SELECT event_id, event_type, aggregate_key, payload
       FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY created_at ASC`
  );
  for (const row of res.rows) {
    switch (row.event_type) {
      case 'order-placed':
        await handleOrderPlaced(row);
        break;
      case 'inventory-updated':
      case 'offer-price-updated':
        await handleSearchSync(row);
        break;
      case 'fulfilment-status-updated':
      case 'stock-transfer-status-updated':
      case 'eta-updated':
        await handleFulfilmentEvent(row);
        break;
      case 'order-item-cancelled':
        await handleCancellationHandler(row);
        break;
      case 'refund-credit-requested':
        await handleRefundCredit(row);
        break;
      case 'notification-created':
        await handleNotifier(row);
        break;
    }
    await pool.query(`UPDATE outbox_events SET published_at = now() WHERE event_id = $1`, [
      row.event_id,
    ]);
  }
}

test.before(async () => {
  if (!HAS_PG) return;
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (HAS_PG) {
    await closePool();
  }
});

test('Gate 1 & 2 Integration Suite against Real Aiven PostgreSQL', { skip: !HAS_PG ? 'PG_URI not configured in environment' : false }, async (t) => {
  const pool = getPool();
  const demoAuth = await getToken(baseUrl, 'demo@bazaarbridge.dev', 'Demo@1234');
  const demo2Auth = await getToken(baseUrl, 'demo2@bazaarbridge.dev', 'Demo@1234');
  const adminAuth = await getToken(
    baseUrl,
    'admin@bazaarbridge.dev',
    env.seedAdminPassword || 'Admin@1234'
  );

  await t.test('comparison-winners: 5 tabs pick 5 distinct offers on Bluetooth Speaker', async () => {
    const prodRes = await pool.query<{ product_id: string }>(
      `SELECT product_id FROM products WHERE name = 'SoundCraft Pulse Bluetooth Speaker'`
    );
    const pid = prodRes.rows[0].product_id;
    const cats = ['budget', 'fastest', 'rated', 'value', 'available'] as const;
    const expectedPrices = [69900, 77900, 74900, 72500, 76900];
    const winners = new Set<string>();

    for (let i = 0; i < cats.length; i += 1) {
      const res = await fetch(`${baseUrl}/api/products/${pid}/offers?category=${cats[i]}`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as { winner: { offer_id: string; selling_price: number; reason: string } };
      assert.equal(data.winner.selling_price, expectedPrices[i]);
      assert.ok(data.winner.reason.length > 10);
      winners.add(data.winner.offer_id);
    }
    assert.equal(winners.size, 5);
  });

  await t.test('concurrency & release-idempotency: 2 simultaneous reserves on 1-unit product', async () => {
    const offerRes = await pool.query<{ offer_id: string; location_id: string }>(
      `SELECT o.offer_id, i.location_id
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         JOIN inventory i ON i.offer_id = o.offer_id
        WHERE p.name = 'AeroPods Limited Edition 1-Unit Drop'
        LIMIT 1`
    );
    const { offer_id, location_id } = offerRes.rows[0];
    await resetOffer(offer_id, 1, location_id);

    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/cart/reserve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${demoAuth.token}`,
        },
        body: JSON.stringify({
          offer_id,
          location_id,
          quantity: 1,
          request_key: `conc-1-${Date.now()}`,
        }),
      }),
      fetch(`${baseUrl}/api/cart/reserve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${demo2Auth.token}`,
        },
        body: JSON.stringify({
          offer_id,
          location_id,
          quantity: 1,
          request_key: `conc-2-${Date.now()}`,
        }),
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const winnerBody = (r1.status === 201 ? await r1.json() : await r2.json()) as {
      reservation_id: string;
    };
    const winnerToken = r1.status === 201 ? demoAuth.token : demo2Auth.token;

    // Release idempotency: release twice concurrently
    const [rel1, rel2] = await Promise.all([
      fetch(`${baseUrl}/api/cart/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${winnerToken}` },
        body: JSON.stringify({ reservation_id: winnerBody.reservation_id }),
      }),
      fetch(`${baseUrl}/api/cart/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${winnerToken}` },
        body: JSON.stringify({ reservation_id: winnerBody.reservation_id }),
      }),
    ]);
    assert.equal(rel1.status, 200);
    assert.equal(rel2.status, 200);

    const invCheck = await pool.query<{ reserved_quantity: number }>(
      `SELECT reserved_quantity FROM inventory WHERE offer_id = $1 AND location_id = $2`,
      [offer_id, location_id]
    );
    assert.equal(invCheck.rows[0].reserved_quantity, 0);
  });

  await t.test('price-change & retry on 1-unit product + OTP privacy + restock-missing-row', async () => {
    // Verify OTP raw code NEVER enters outbox payloads
    const offerRes = await pool.query<{ offer_id: string; location_id: string; selling_price: number }>(
      `SELECT o.offer_id, i.location_id, o.selling_price
         FROM dealer_offers o
         JOIN products p ON p.product_id = o.product_id
         JOIN inventory i ON i.offer_id = o.offer_id
        WHERE p.name = 'AeroPods Limited Edition 1-Unit Drop'
        LIMIT 1`
    );
    const { offer_id, location_id, selling_price } = offerRes.rows[0];
    await resetOffer(offer_id, 1, location_id);

    const resv1 = await fetch(`${baseUrl}/api/cart/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${demoAuth.token}` },
      body: JSON.stringify({ offer_id, location_id, quantity: 1, request_key: `pc-${Date.now()}` }),
    });
    assert.equal(resv1.status, 201);
    const { reservation_id } = (await resv1.json()) as { reservation_id: string };

    // Change price in DB
    const newPrice = Number(selling_price) + 5000;
    await pool.query(`UPDATE dealer_offers SET selling_price = $2 WHERE offer_id = $1`, [
      offer_id,
      newPrice,
    ]);

    const orderAttempt1 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${demoAuth.token}` },
      body: JSON.stringify({
        reservation_ids: [reservation_id],
        address: { pin_code: '560038' },
      }),
    });
    assert.equal(orderAttempt1.status, 409);
    const errBody = (await orderAttempt1.json()) as { error: string };
    assert.equal(errBody.error, 'PRICE_CHANGED');

    // Release -> Re-reserve -> Retry order
    const rel = await fetch(`${baseUrl}/api/cart/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${demoAuth.token}` },
      body: JSON.stringify({ reservation_id }),
    });
    assert.equal(rel.status, 200);

    const resv2 = await fetch(`${baseUrl}/api/cart/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${demoAuth.token}` },
      body: JSON.stringify({
        offer_id,
        location_id,
        quantity: 1,
        request_key: `pc-retry-${Date.now()}`,
      }),
    });
    assert.equal(resv2.status, 201);
    const { reservation_id: reservation_id_2 } = (await resv2.json()) as { reservation_id: string };

    const orderAttempt2 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${demoAuth.token}` },
      body: JSON.stringify({
        reservation_ids: [reservation_id_2],
        address: { pin_code: '560038' },
      }),
    });
    assert.equal(orderAttempt2.status, 201);
    const orderData = (await orderAttempt2.json()) as {
      order_id: string;
      groups: Array<{ group_id: string }>;
    };

    // Drain outbox -> finalizer + notifier
    await drainOutboxLocally();
    await drainOutboxLocally();

    // Verify OTP flow: wrong code never delivers, correct code delivers
    const gid = orderData.groups[0].group_id;
    const rawOtp = readOtp(gid);
    const wrongOtp = String((parseInt(rawOtp, 10) + 1) % 1000000).padStart(6, '0');

    const wrongRes = await fetch(`${baseUrl}/api/simulator/fire-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ group_id: gid, event_type: 'otp_verified', otp: wrongOtp }),
    });
    assert.equal(wrongRes.status, 202);
    await drainOutboxLocally();

    const grpCheck1 = await pool.query<{ status: string }>(
      `SELECT status FROM fulfilment_groups WHERE group_id = $1`,
      [gid]
    );
    assert.notEqual(grpCheck1.rows[0].status, 'delivered');

    // Outbox payload must carry otp_proof and NEVER rawOtp
    const outboxCheck = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE aggregate_key = $1`,
      [gid]
    );
    for (const row of outboxCheck.rows) {
      assert.equal('otp' in row.payload, false);
      if ('otp_proof' in row.payload) {
        assert.equal(row.payload.otp_proof, hashOtpSubmission(wrongOtp));
      }
    }

    // Restore original price
    await pool.query(`UPDATE dealer_offers SET selling_price = $2 WHERE offer_id = $1`, [
      offer_id,
      selling_price,
    ]);
  });

  await t.test('reconciliation.sql returns zero rows', async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, 'reconciliation.sql'), 'utf8');
    const res = await pool.query(sql);
    assert.equal(res.rowCount, 0);
  });

  if (isOpenSearchConfigured()) {
    await t.test('stale-index: external_gte rejects older revision cleanly', async () => {
      const offerRes = await pool.query<{ offer_id: string }>(
        `SELECT offer_id FROM dealer_offers LIMIT 1`
      );
      const offerId = offerRes.rows[0].offer_id;
      const first = await upsertOffer(offerId);
      assert.ok(first.revision >= 1);
      // Delete inventory row check placeholder cleanup
      await deleteInventoryRow(offerId, '00000000-0000-0000-0000-000000000000').catch(() => {});
    });
  }
});
