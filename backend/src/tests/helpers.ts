import { getPool } from '../db/pool.ts';
import { pauseConsumer, resumeConsumer } from '../events/consumers.ts';
import { deriveOtp } from '../events/otpService.ts';

export { pauseConsumer, resumeConsumer };

export async function getToken(
  baseUrl: string,
  email: string,
  password: string
): Promise<{ token: string; user: { user_id: string; name: string; role: string } }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`getToken failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as {
    token: string;
    user: { user_id: string; name: string; role: string };
  };
}

export async function resetOffer(
  offerId: string,
  qty: number,
  locationId?: string
): Promise<void> {
  const pool = getPool();
  if (locationId) {
    await pool.query(
      `UPDATE inventory
          SET quantity = $3, reserved_quantity = 0
        WHERE offer_id = $1 AND location_id = $2`,
      [offerId, locationId, qty]
    );
  } else {
    await pool.query(
      `UPDATE inventory
          SET quantity = $2, reserved_quantity = 0
        WHERE offer_id = $1`,
      [offerId, qty]
    );
  }
}

export async function setTransferStatus(
  orderItemId: string,
  status: string
): Promise<void> {
  await getPool().query(
    `UPDATE stock_transfers SET status = $2 WHERE order_item_id = $1`,
    [orderItemId, status]
  );
}

export async function deleteInventoryRow(
  offerId: string,
  locationId: string
): Promise<void> {
  await getPool().query(
    `DELETE FROM inventory WHERE offer_id = $1 AND location_id = $2`,
    [offerId, locationId]
  );
}

export function readOtp(groupId: string): string {
  return deriveOtp(groupId);
}
