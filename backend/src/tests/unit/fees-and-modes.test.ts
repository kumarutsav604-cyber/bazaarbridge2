import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEE_QUICK_PAISE,
  FEE_STANDARD_PAISE,
  FEE_TRANSFER_PAISE,
  FREE_STANDARD_THRESHOLD_PAISE,
  allocatePaise,
  computeGroupFeePaise,
  resolveReservationMode,
  ModeRuleError,
  type HubContext,
} from '../../domain/fees.ts';
import { calculateEtaWindow } from '../../domain/eta.ts';

const activeHub: HubContext = {
  hub_id: 'hub-1',
  location_id: 'loc-hub',
  active: true,
  hours: { open: '00:00', close: '23:59' },
  order_capacity: 20,
  groups_accepted_today: 5,
};

test('fee constants match locked v7.2 contract', () => {
  assert.equal(FEE_QUICK_PAISE, 4900);
  assert.equal(FEE_STANDARD_PAISE, 2900);
  assert.equal(FEE_TRANSFER_PAISE, 6900);
  assert.equal(FREE_STANDARD_THRESHOLD_PAISE, 99900);

  assert.equal(computeGroupFeePaise('quick', 200000), 4900);
  assert.equal(computeGroupFeePaise('standard', 99899), 2900);
  assert.equal(computeGroupFeePaise('standard', 99900), 0);
  assert.equal(computeGroupFeePaise('transfer', 500000), 6900);
});

test('allocatePaise distributes floor proportional shares + leftover paise accurately', () => {
  const shares = allocatePaise(100, [333, 333, 334]);
  assert.deepEqual(shares, [34, 33, 33]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 100);

  const feeShares = allocatePaise(4900, [69900, 72500]);
  assert.equal(feeShares.reduce((a, b) => a + b, 0), 4900);
});

test('mode resolution honours downgrade and rejects invalid quick requests', () => {
  // Hub reservation defaults to quick when eligible
  assert.equal(
    resolveReservationMode(
      {
        reservation_id: 'r1',
        location_id: 'loc-hub',
        location_type: 'hub',
        is_home: false,
        eligible_modes: ['quick', 'standard'],
      },
      activeHub
    ),
    'quick'
  );

  // Customer downgrade hub -> standard is allowed
  assert.equal(
    resolveReservationMode(
      {
        reservation_id: 'r1',
        location_id: 'loc-hub',
        location_type: 'hub',
        is_home: false,
        eligible_modes: ['quick', 'standard'],
        mode_preference: 'standard',
      },
      activeHub
    ),
    'standard'
  );

  // Quick requested on warehouse is ALWAYS rejected
  assert.throws(
    () =>
      resolveReservationMode(
        {
          reservation_id: 'r2',
          location_id: 'loc-wh',
          location_type: 'warehouse',
          is_home: true,
          eligible_modes: ['standard'],
          mode_preference: 'quick',
        },
        activeHub
      ),
    (err: unknown) => err instanceof ModeRuleError && err.code === 'QUICK_NOT_AVAILABLE'
  );

  // Quarantine is rejected with LOCATION_NOT_SELLABLE
  assert.throws(
    () =>
      resolveReservationMode(
        {
          reservation_id: 'r3',
          location_id: 'loc-q',
          location_type: 'quarantine',
          is_home: false,
          eligible_modes: [],
        },
        activeHub
      ),
    (err: unknown) => err instanceof ModeRuleError && err.code === 'LOCATION_NOT_SELLABLE'
  );

  // Paused hub falls back to standard if no preference, rejects if quick explicitly requested
  const pausedHub: HubContext = { ...activeHub, active: false };
  assert.equal(
    resolveReservationMode(
      {
        reservation_id: 'r4',
        location_id: 'loc-hub',
        location_type: 'hub',
        is_home: false,
        eligible_modes: ['quick', 'standard'],
      },
      pausedHub
    ),
    'standard'
  );
  assert.throws(
    () =>
      resolveReservationMode(
        {
          reservation_id: 'r4',
          location_id: 'loc-hub',
          location_type: 'hub',
          is_home: false,
          eligible_modes: ['quick', 'standard'],
          mode_preference: 'quick',
        },
        pausedHub
      ),
    (err: unknown) => err instanceof ModeRuleError && err.code === 'QUICK_NOT_AVAILABLE'
  );
});

test('ETA calculation produces +/- 15m quick range and multi-day ranges', () => {
  const now = new Date('2026-11-21T10:00:00Z');
  const quick = calculateEtaWindow('quick', { pickingQueueCount: 2, now });
  // center = 5 + 2*4 + 5 + 5 + 20 = 43 mins => 28m to 58m (30m span)
  assert.equal(
    Math.round((quick.windowEnd.getTime() - quick.windowStart.getTime()) / 60000),
    30
  );
  assert.equal(quick.basis.center_minutes, 43);

  const transfer = calculateEtaWindow('transfer', { transferDaysMax: 3, now });
  assert.equal(transfer.basis.transfer_days_max, 3);
  assert.ok(transfer.windowEnd > transfer.windowStart);
});
