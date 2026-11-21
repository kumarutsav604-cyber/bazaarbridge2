import type { DeliveryMode } from './fees.ts';

export const NON_CANCELLABLE_GROUP_STATUSES = [
  'picked_up',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;

export const FULFILMENT_EVENT_TYPES = [
  'picked',
  'packed',
  'rider_assigned',
  'picked_up',
  'out_for_delivery',
  'otp_verified',
  'otp_failed',
  'exception',
] as const;

export const TRANSFER_EVENT_TYPES = [
  'transfer_requested',
  'in_transit',
  'received_checked',
  'allocated',
] as const;

export type FulfilmentEventType = (typeof FULFILMENT_EVENT_TYPES)[number];
export type TransferEventType = (typeof TRANSFER_EVENT_TYPES)[number];
export type SimulatorEventType = FulfilmentEventType | TransferEventType;

export function isGroupCancellable(groupStatus: string | null | undefined): boolean {
  if (!groupStatus) return true;
  return !NON_CANCELLABLE_GROUP_STATUSES.includes(
    groupStatus as (typeof NON_CANCELLABLE_GROUP_STATUSES)[number]
  );
}

export function getNextGroupStatusForFulfilmentEvent(
  mode: DeliveryMode,
  currentStatus: string,
  eventType: FulfilmentEventType
): { expectedCurrent: string[]; nextStatus: string | null } {
  if (eventType === 'otp_failed' || eventType === 'exception') {
    return { expectedCurrent: [currentStatus], nextStatus: null }; // timeline row only
  }

  if (mode === 'quick') {
    switch (eventType) {
      case 'picked':
        return { expectedCurrent: ['order_accepted'], nextStatus: 'picked' };
      case 'packed':
        return { expectedCurrent: ['picked'], nextStatus: 'packed' };
      case 'rider_assigned':
        return { expectedCurrent: ['packed'], nextStatus: 'rider_assigned' };
      case 'picked_up':
        return { expectedCurrent: ['rider_assigned'], nextStatus: 'picked_up' };
      case 'out_for_delivery':
        return { expectedCurrent: ['picked_up'], nextStatus: 'out_for_delivery' };
      case 'otp_verified':
        return { expectedCurrent: ['out_for_delivery'], nextStatus: 'delivered' };
    }
  }

  if (mode === 'standard') {
    switch (eventType) {
      case 'picked':
        return { expectedCurrent: ['order_accepted'], nextStatus: 'processing' };
      case 'packed':
        return { expectedCurrent: ['processing', 'order_accepted'], nextStatus: 'packed' };
      case 'rider_assigned':
        return { expectedCurrent: ['packed'], nextStatus: 'rider_assigned' };
      case 'picked_up':
        return { expectedCurrent: ['rider_assigned'], nextStatus: 'picked_up' };
      case 'out_for_delivery':
        return { expectedCurrent: ['picked_up', 'in_transit'], nextStatus: 'out_for_delivery' };
      case 'otp_verified':
        return { expectedCurrent: ['out_for_delivery'], nextStatus: 'delivered' };
    }
  }

  // transfer mode after allocation
  switch (eventType) {
    case 'picked':
      return { expectedCurrent: ['allocated'], nextStatus: 'packed' };
    case 'packed':
      return { expectedCurrent: ['allocated'], nextStatus: 'packed' };
    case 'rider_assigned':
      return { expectedCurrent: ['packed'], nextStatus: 'rider_assigned' };
    case 'picked_up':
      return { expectedCurrent: ['rider_assigned'], nextStatus: 'picked_up' };
    case 'out_for_delivery':
      return { expectedCurrent: ['picked_up'], nextStatus: 'out_for_delivery' };
    case 'otp_verified':
      return { expectedCurrent: ['out_for_delivery'], nextStatus: 'delivered' };
  }
}

export function isValidSimulatorEventType(eventType: string): eventType is SimulatorEventType {
  return (
    (FULFILMENT_EVENT_TYPES as readonly string[]).includes(eventType) ||
    (TRANSFER_EVENT_TYPES as readonly string[]).includes(eventType)
  );
}
