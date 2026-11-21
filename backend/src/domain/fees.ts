export const FEE_QUICK_PAISE = 4900; // SAMPLE: Rs.49
export const FEE_STANDARD_PAISE = 2900; // SAMPLE: Rs.29
export const FEE_TRANSFER_PAISE = 6900; // SAMPLE: Rs.29 handling + Rs.40 inter-location
export const FREE_STANDARD_THRESHOLD_PAISE = 99900; // SAMPLE: Rs.999

export type DeliveryMode = 'quick' | 'standard' | 'transfer';
export type StockLocationType = 'warehouse' | 'hub' | 'holding' | 'quarantine';

export interface HubContext {
  hub_id: string;
  location_id: string;
  active: boolean;
  hours: { open?: string; close?: string } | Record<string, { open?: string; close?: string }> | null;
  order_capacity: number;
  groups_accepted_today: number;
}

export interface ReservationClassificationInput {
  reservation_id: string;
  location_id: string;
  location_type: StockLocationType;
  is_home: boolean;
  eligible_modes: string[];
  mode_preference?: 'quick' | 'standard';
}

export class ModeRuleError extends Error {
  code: 'QUICK_NOT_AVAILABLE' | 'LOCATION_NOT_SELLABLE';
  constructor(code: 'QUICK_NOT_AVAILABLE' | 'LOCATION_NOT_SELLABLE', message: string) {
    super(message);
    this.code = code;
  }
}

export function isWithinHubHours(
  hours: HubContext['hours'],
  now: Date = new Date()
): boolean {
  if (!hours) return true;
  // Format time in Asia/Kolkata (HH:MM)
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const currentHm = formatter.format(now); // e.g. "14:35"

  const flatHours = hours as { open?: string; close?: string };
  if (flatHours.open && flatHours.close) {
    return currentHm >= flatHours.open && currentHm <= flatHours.close;
  }

  return true;
}

export function isQuickEligibleForLocation(
  input: Pick<ReservationClassificationInput, 'location_id' | 'location_type' | 'eligible_modes'>,
  hub: HubContext | null,
  now: Date = new Date()
): boolean {
  if (input.location_type !== 'hub') return false;
  if (!hub || !hub.active) return false;
  if (hub.location_id !== input.location_id) return false;
  if (!isWithinHubHours(hub.hours, now)) return false;
  if (hub.groups_accepted_today >= hub.order_capacity) return false;
  if (!input.eligible_modes.includes('quick')) return false;
  return true;
}

export function resolveReservationMode(
  input: ReservationClassificationInput,
  hub: HubContext | null,
  now: Date = new Date()
): DeliveryMode {
  if (input.location_type === 'quarantine') {
    throw new ModeRuleError(
      'LOCATION_NOT_SELLABLE',
      'This inventory is quarantined and not sellable.'
    );
  }

  if (input.location_type === 'hub') {
    const quickEligible = isQuickEligibleForLocation(input, hub, now);
    if (input.mode_preference === 'standard') {
      return 'standard';
    }
    if (input.mode_preference === 'quick') {
      if (!quickEligible) {
        throw new ModeRuleError(
          'QUICK_NOT_AVAILABLE',
          'Quick delivery is currently unavailable for this PIN code or hub.'
        );
      }
      return 'quick';
    }
    return quickEligible ? 'quick' : 'standard';
  }

  // Non-hub locations: warehouse (is_home) or holding (transfer)
  if (input.mode_preference === 'quick') {
    throw new ModeRuleError(
      'QUICK_NOT_AVAILABLE',
      'Quick delivery is only available from an active local fulfilment hub.'
    );
  }

  if (input.is_home || input.location_type === 'warehouse') {
    return 'standard';
  }

  if (input.location_type === 'holding') {
    return 'transfer';
  }

  throw new ModeRuleError('LOCATION_NOT_SELLABLE', 'Location is not sellable.');
}

export function computeGroupFeePaise(mode: DeliveryMode, groupItemsTotalPaise: number): number {
  if (mode === 'quick') return FEE_QUICK_PAISE;
  if (mode === 'transfer') return FEE_TRANSFER_PAISE;
  return groupItemsTotalPaise >= FREE_STANDARD_THRESHOLD_PAISE ? 0 : FEE_STANDARD_PAISE;
}

/**
 * Floor proportional allocation; leftover paise distributed +1 each in input order
 * (callers MUST pass linePrices sorted by order_item_id ASC).
 */
export function allocatePaise(totalPaise: number, linePrices: number[]): number[] {
  if (linePrices.length === 0) return [];
  if (totalPaise <= 0) return linePrices.map(() => 0);

  const sumLines = linePrices.reduce((acc, p) => acc + p, 0);
  if (sumLines <= 0) return linePrices.map(() => 0);

  const shares = linePrices.map((price) => Math.floor((totalPaise * price) / sumLines));
  const allocated = shares.reduce((acc, s) => acc + s, 0);
  let remainder = totalPaise - allocated;

  for (let i = 0; i < shares.length && remainder > 0; i += 1) {
    shares[i] += 1;
    remainder -= 1;
  }

  return shares;
}
