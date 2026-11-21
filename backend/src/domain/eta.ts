import type { DeliveryMode } from './fees.ts';

export interface EtaCalculation {
  windowStart: Date;
  windowEnd: Date;
  basis: {
    mode: DeliveryMode;
    formula: string;
    picking_queue?: number;
    center_minutes?: number;
    range_plus_minus_minutes?: number;
    transfer_days_max?: number;
    sample_estimate: true;
  };
  displayLabel: string;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function calculateEtaWindow(
  mode: DeliveryMode,
  options: { pickingQueueCount?: number; transferDaysMax?: number; now?: Date } = {}
): EtaCalculation {
  const now = options.now ?? new Date();

  if (mode === 'quick') {
    const queue = Math.max(0, options.pickingQueueCount ?? 0);
    // accept 5m + picking_queue*4m + pack 5m + assign 5m + travel 20m
    const centerMinutes = 5 + queue * 4 + 5 + 5 + 20;
    const minMinutes = Math.max(15, centerMinutes - 15);
    const maxMinutes = centerMinutes + 15;

    return {
      windowStart: new Date(now.getTime() + minMinutes * MINUTE_MS),
      windowEnd: new Date(now.getTime() + maxMinutes * MINUTE_MS),
      basis: {
        mode: 'quick',
        formula: 'accept(5m) + queue*4m + pack(5m) + assign(5m) + travel(20m) +/- 15m',
        picking_queue: queue,
        center_minutes: centerMinutes,
        range_plus_minus_minutes: 15,
        sample_estimate: true,
      },
      displayLabel: `${minMinutes}–${maxMinutes} mins (Quick Hub range)`,
    };
  }

  if (mode === 'standard') {
    // warehouse 1 business day + local 1-2 days => 2 to 3 days
    return {
      windowStart: new Date(now.getTime() + 2 * DAY_MS),
      windowEnd: new Date(now.getTime() + 3 * DAY_MS),
      basis: {
        mode: 'standard',
        formula: 'warehouse 1 business day + local 1-2 days',
        sample_estimate: true,
      },
      displayLabel: '2–3 days (Standard warehouse)',
    };
  }

  const transferDays = Math.max(1, options.transferDaysMax ?? 2);
  // transfer_days_max + warehouse 1 day + local 1-2 days
  const minDays = transferDays + 2;
  const maxDays = transferDays + 3;

  return {
    windowStart: new Date(now.getTime() + minDays * DAY_MS),
    windowEnd: new Date(now.getTime() + maxDays * DAY_MS),
    basis: {
      mode: 'transfer',
      formula: 'transfer_days_max + warehouse 1 day + local 1-2 days',
      transfer_days_max: transferDays,
      sample_estimate: true,
    },
    displayLabel: `${minDays}–${maxDays} days (Inter-city transfer + local)`,
  };
}
