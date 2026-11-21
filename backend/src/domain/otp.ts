import crypto from 'crypto';

/**
 * Deterministic HMAC-based OTP derivation and constant-time proof verification
 * per BazaarBridge v7.2 locked contract.
 * Raw OTPs NEVER enter outbox payloads, Kafka, logs, or OpenSearch.
 */

export function deriveOtp(groupId: string, secret: string): string {
  const rawHex = crypto.createHmac('sha256', secret).update(`otp:${groupId}`).digest('hex');
  const numeric = parseInt(rawHex.slice(0, 8), 16) % 1000000;
  return String(numeric).padStart(6, '0');
}

export function hashOtpSubmission(code: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`hash:${code}`).digest('hex');
}

export function deriveOtpHash(groupId: string, secret: string): string {
  const code = deriveOtp(groupId, secret);
  return hashOtpSubmission(code, secret);
}

export function verifyOtpProofAgainstHash(storedHashHex: string, submittedProofHex: string): boolean {
  if (!storedHashHex || !submittedProofHex) return false;
  if (!/^[0-9a-f]{64}$/i.test(storedHashHex) || !/^[0-9a-f]{64}$/i.test(submittedProofHex)) {
    return false;
  }
  const a = Buffer.from(storedHashHex.toLowerCase(), 'hex');
  const b = Buffer.from(submittedProofHex.toLowerCase(), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
