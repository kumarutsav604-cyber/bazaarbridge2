import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveOtp,
  deriveOtpHash,
  hashOtpSubmission,
  verifyOtpProofAgainstHash,
} from '../../domain/otp.ts';
import {
  isGroupCancellable,
  getNextGroupStatusForFulfilmentEvent,
  isValidSimulatorEventType,
} from '../../domain/stateMachines.ts';

test('OTP derivation is deterministic and constant-time proof matches only correct code', () => {
  const secret = 'test-otp-secret-key';
  const groupId = '11111111-2222-3333-4444-555555555555';

  const code1 = deriveOtp(groupId, secret);
  const code2 = deriveOtp(groupId, secret);
  assert.equal(code1, code2);
  assert.match(code1, /^\d{6}$/);

  const storedHash = deriveOtpHash(groupId, secret);
  const validProof = hashOtpSubmission(code1, secret);
  assert.equal(verifyOtpProofAgainstHash(storedHash, validProof), true);

  const wrongCode = String((parseInt(code1, 10) + 1) % 1000000).padStart(6, '0');
  const wrongProof = hashOtpSubmission(wrongCode, secret);
  assert.equal(verifyOtpProofAgainstHash(storedHash, wrongProof), false);
});

test('Group cancellation and fulfilment state machine rules match v7.2 contract', () => {
  assert.equal(isGroupCancellable('order_accepted'), true);
  assert.equal(isGroupCancellable('in_transit_to_bangalore'), true);
  assert.equal(isGroupCancellable('picked_up'), false);
  assert.equal(isGroupCancellable('out_for_delivery'), false);
  assert.equal(isGroupCancellable('delivered'), false);
  assert.equal(isGroupCancellable('cancelled'), false);

  assert.equal(isValidSimulatorEventType('otp_verified'), true);
  assert.equal(isValidSimulatorEventType('received_checked'), true);
  assert.equal(isValidSimulatorEventType('invented_event'), false);

  const step = getNextGroupStatusForFulfilmentEvent('quick', 'out_for_delivery', 'otp_verified');
  assert.equal(step.nextStatus, 'delivered');

  const failStep = getNextGroupStatusForFulfilmentEvent('quick', 'out_for_delivery', 'otp_failed');
  assert.equal(failStep.nextStatus, null);
});
