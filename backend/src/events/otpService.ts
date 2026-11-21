import { getPool } from '../db/pool.ts';
import { env } from '../config/env.ts';
import {
  deriveOtp as pureDeriveOtp,
  deriveOtpHash as pureDeriveOtpHash,
  hashOtpSubmission as pureHashOtpSubmission,
  verifyOtpProofAgainstHash,
} from '../domain/otp.ts';

export function deriveOtp(groupId: string): string {
  return pureDeriveOtp(groupId, env.otpHashSecret);
}

export function deriveOtpHash(groupId: string): string {
  return pureDeriveOtpHash(groupId, env.otpHashSecret);
}

export function hashOtpSubmission(code: string): string {
  return pureHashOtpSubmission(code, env.otpHashSecret);
}

export async function verifyOtpProof(groupId: string, proof: string): Promise<boolean> {
  const res = await getPool().query<{ otp_hash: string }>(
    `SELECT otp_hash FROM fulfilment_groups WHERE group_id = $1`,
    [groupId]
  );
  if (res.rowCount !== 1) return false;
  return verifyOtpProofAgainstHash(res.rows[0].otp_hash, proof);
}
