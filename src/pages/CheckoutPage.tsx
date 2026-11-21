import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Tag,
  Truck,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/States';
import { useCart, type CartItemRow } from '../context/CartContext';
import { useSystem } from '../context/SystemContext';
import { useToast } from '../context/ToastContext';
import { ApiClientError, apiFetch, formatPaise } from '../kit';

interface PinCheckResult {
  pin_code: string;
  quick_available: boolean;
  standard_available: boolean;
  hub_id: string | null;
  hub_location_id: string | null;
  hub_name?: string;
  reason: string;
}

interface SavedAddress {
  address_id: string;
  label: string;
  recipient_name: string;
  phone: string;
  line1: string;
  city: string;
  state: string;
  pin_code: string;
  is_default: boolean;
}

interface CouponPreview {
  valid: boolean;
  code: string;
  kind: 'fixed_paise' | 'percent';
  value: number;
  discount_paise: number;
}

interface PriceChangeConflict {
  reservation_id: string;
  offer_id: string;
  current_price_paise: number;
}

export function CheckoutPage() {
  const navigate = useNavigate();
  const { items, subtotalPaise, refreshCart } = useCart();
  const { isFeatureEnabled } = useSystem();
  const { addToast } = useToast();

  const [pinCode, setPinCode] = useState('560038');
  const [pinCheck, setPinCheck] = useState<PinCheckResult | null>(null);
  const [checkingPin, setCheckingPin] = useState(false);

  const [modePrefs, setModePrefs] = useState<Record<string, 'quick' | 'standard'>>({});
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [showNewAddress, setShowNewAddress] = useState(false);
  const [newAddr, setNewAddr] = useState({
    label: 'Home',
    recipient_name: 'Aarav Rao',
    phone: '9876543210',
    line1: '100 Feet Road, Indiranagar',
    city: 'Bangalore',
    state: 'Karnataka',
    pin_code: '560038',
  });

  const [couponCode, setCouponCode] = useState('');
  const [couponPreview, setCouponPreview] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);

  const [reservingAll, setReservingAll] = useState(false);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [priceConflicts, setPriceConflicts] = useState<PriceChangeConflict[]>([]);

  const checkPin = useCallback(async (pin: string) => {
    if (!/^\d{6}$/.test(pin.trim())) {
      setPinCheck(null);
      return;
    }
    setCheckingPin(true);
    try {
      const res = await apiFetch<PinCheckResult>('/api/check-pin', {
        method: 'POST',
        body: JSON.stringify({ pin_code: pin.trim() }),
      });
      setPinCheck(res);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to check PIN code.', 'error');
    } finally {
      setCheckingPin(false);
    }
  }, [addToast]);

  useEffect(() => {
    void checkPin(pinCode);
  }, [checkPin, pinCode]);

  useEffect(() => {
    if (!isFeatureEnabled('FEATURE_ADDRESSES')) return;
    apiFetch<{ addresses: SavedAddress[] }>('/api/addresses')
      .then((res) => {
        const list = res.addresses || [];
        setAddresses(list);
        const def = list.find((a) => a.is_default) || list[0];
        if (def) setPinCode(def.pin_code);
      })
      .catch(() => {});
  }, [isFeatureEnabled]);

  const unreservedItems = useMemo(
    () =>
      items.filter(
        (i) =>
          !i.reservation_id ||
          i.reservation_status !== 'reserved' ||
          !i.reservation_expires_at ||
          new Date(i.reservation_expires_at).getTime() <= Date.now()
      ),
    [items]
  );

  const reserveAllNeeded = async (): Promise<string[]> => {
    setReservingAll(true);
    setCheckoutError(null);
    try {
      const reservationIds: string[] = [];
      for (const item of items) {
        const validExisting =
          item.reservation_id &&
          item.reservation_status === 'reserved' &&
          item.reservation_expires_at &&
          new Date(item.reservation_expires_at).getTime() > Date.now();

        if (validExisting && item.reservation_id) {
          reservationIds.push(item.reservation_id);
        } else {
          const res = await apiFetch<{ reservation_id: string }>('/api/cart/reserve', {
            method: 'POST',
            body: JSON.stringify({
              cart_item_id: item.cart_item_id,
              offer_id: item.offer_id,
              location_id: item.preferred_location_id || undefined,
              quantity: item.quantity,
              request_key: `chk-${item.cart_item_id}-${Date.now()}`,
            }),
          });
          reservationIds.push(res.reservation_id);
        }
      }
      await refreshCart();
      return reservationIds;
    } finally {
      setReservingAll(false);
    }
  };

  // Group preview (mirrors backend (location_id, mode) grouping)
  const previewGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        mode: 'quick' | 'standard' | 'transfer';
        items: CartItemRow[];
        itemsTotal: number;
      }
    >();

    for (const item of items) {
      const locId = item.reservation_location_id || item.preferred_location_id || item.offer_id;
      const isHubItem =
        Boolean(pinCheck?.quick_available) &&
        Boolean(pinCheck?.hub_location_id) &&
        item.eligible_modes.includes('quick') &&
        locId === pinCheck?.hub_location_id;

      let mode: 'quick' | 'standard' | 'transfer' = 'standard';
      if (isHubItem) {
        const pref = item.reservation_id ? modePrefs[item.reservation_id] : undefined;
        mode = pref === 'standard' ? 'standard' : 'quick';
      } else if (item.dealer_city.toLowerCase() !== 'bangalore' && item.transfer_days_max) {
        // Note: authoritative route is resolved server-side from stock_locations.location_type
        mode = item.eligible_modes.includes('transfer') && !item.eligible_modes.includes('standard')
          ? 'transfer'
          : 'standard';
      }

      const key = `${locId}::${mode}`;
      const existing = groups.get(key) || { key, mode, items: [], itemsTotal: 0 };
      existing.items.push(item);
      existing.itemsTotal += item.current_price_paise * item.quantity;
      groups.set(key, existing);
    }

    return Array.from(groups.values()).map((g) => {
      const feePaise =
        g.mode === 'quick'
          ? 4900
          : g.mode === 'transfer'
            ? 6900
            : g.itemsTotal >= 99900
              ? 0
              : 2900;
      return { ...g, feePaise };
    });
  }, [items, pinCheck, modePrefs]);

  const estimatedDeliveryTotal = previewGroups.reduce((s, g) => s + g.feePaise, 0);
  const discountPaise = couponPreview?.discount_paise ?? 0;
  const estimatedGrandTotal = Math.max(0, subtotalPaise - discountPaise + estimatedDeliveryTotal);

  const handleValidateCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    setCouponError(null);
    setCouponPreview(null);
    if (!couponCode.trim()) return;
    try {
      const res = await apiFetch<CouponPreview>('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({
          code: couponCode.trim(),
          basket_total_paise: subtotalPaise,
        }),
      });
      setCouponPreview(res);
      addToast(`Coupon ${res.code} applied (-${formatPaise(res.discount_paise)}).`, 'success');
    } catch (err: unknown) {
      setCouponError(err instanceof Error ? err.message : 'Coupon cannot be applied.');
    }
  };

  const handleSaveAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ address: SavedAddress }>('/api/addresses', {
        method: 'POST',
        body: JSON.stringify({ ...newAddr, is_default: true }),
      });
      setAddresses((prev) => [res.address, ...prev]);
      setPinCode(res.address.pin_code);
      setShowNewAddress(false);
      addToast('Saved delivery address.', 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Could not save address.', 'error');
    }
  };

  const handlePlaceOrder = async () => {
    if (!/^\d{6}$/.test(pinCode.trim())) {
      setCheckoutError('Please enter a valid 6-digit Bangalore delivery PIN code.');
      return;
    }

    setPlacingOrder(true);
    setCheckoutError(null);
    setPriceConflicts([]);

    try {
      const reservationIds = await reserveAllNeeded();
      const res = await apiFetch<{ order_id: string }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          reservation_ids: reservationIds,
          address: { pin_code: pinCode.trim() },
          mode_preferences: modePrefs,
          ...(couponPreview?.code ? { coupon_code: couponPreview.code } : {}),
        }),
      });
      await refreshCart();
      addToast('Order placed! Redirecting to live fulfilment tracking.', 'success');
      navigate(`/orders/${res.order_id}`);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.code === 'PRICE_CHANGED') {
        const details = err.details as { reservations?: PriceChangeConflict[] } | undefined;
        setPriceConflicts(details?.reservations || []);
        setCheckoutError(
          'Offer price changed since you reserved it. Release the old hold and re-reserve at the new price below.'
        );
      } else {
        setCheckoutError(err instanceof Error ? err.message : 'Order placement failed.');
      }
    } finally {
      setPlacingOrder(false);
    }
  };

  const handleResolvePriceChange = async () => {
    setPlacingOrder(true);
    try {
      for (const conflict of priceConflicts) {
        await apiFetch('/api/cart/release', {
          method: 'POST',
          body: JSON.stringify({ reservation_id: conflict.reservation_id }),
        }).catch(() => {});
      }
      setPriceConflicts([]);
      setCheckoutError(null);
      await refreshCart();
      await reserveAllNeeded();
      addToast('Re-reserved at updated dealer price. Ready to place order.', 'success');
    } catch (err: unknown) {
      setCheckoutError(err instanceof Error ? err.message : 'Unable to re-reserve.');
    } finally {
      setPlacingOrder(false);
    }
  };

  if (items.length === 0) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
        <EmptyState
          title="No items ready for checkout"
          description="Add dealer offers to your cart first before proceeding to checkout."
          actionLabel="Return to Cart"
          onAction={() => navigate('/cart')}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link to="/cart" className="text-sm font-medium text-[#4F46E5] hover:underline">
          ← Back to Cart
        </Link>
        <h1 className="mt-2 font-display text-2xl font-bold text-[#111827] sm:text-3xl">
          Checkout &amp; Fulfilment Routing
        </h1>
        <p className="mt-1 text-sm text-[#64748B]">
          Verify your delivery PIN, inspect split fulfilment groups, and confirm your sandbox order.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-8">
          {/* PIN Code & Quick Hub Eligibility */}
          <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-[#4F46E5]" />
              <h2 className="font-display text-base font-bold text-[#111827]">
                Delivery PIN Code &amp; Local Hub Check
              </h2>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                type="text"
                maxLength={6}
                value={pinCode}
                onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
                placeholder="e.g. 560038"
                aria-label="6-digit delivery PIN code"
                className="h-10 w-40 rounded-lg border border-[#E2E8F0] px-3 font-mono text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void checkPin(pinCode)}
                disabled={checkingPin}
                className="h-10 rounded-lg border border-[#E2E8F0] px-4 text-xs font-semibold text-[#111827] hover:bg-slate-50"
              >
                {checkingPin ? 'Checking...' : 'Check Eligibility'}
              </button>
              <button
                type="button"
                onClick={() => setPinCode('560038')}
                className="text-xs font-medium text-[#4F46E5] hover:underline"
              >
                Use Indiranagar 560038 (Quick Eligible)
              </button>
              <button
                type="button"
                onClick={() => setPinCode('560001')}
                className="text-xs font-medium text-[#64748B] hover:underline"
              >
                Use Central 560001 (Standard Only)
              </button>
            </div>

            {pinCheck && (
              <div
                className={`mt-4 flex items-start gap-2.5 rounded-xl border p-3.5 text-xs ${
                  pinCheck.quick_available
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                    : 'border-slate-200 bg-slate-50 text-[#111827]'
                }`}
              >
                {pinCheck.quick_available ? (
                  <Zap className="mt-0.5 h-4 w-4 shrink-0 text-[#16A34A]" />
                ) : (
                  <Truck className="mt-0.5 h-4 w-4 shrink-0 text-[#4F46E5]" />
                )}
                <div>
                  <p className="font-semibold">
                    {pinCheck.quick_available
                      ? `Quick Delivery Available (${pinCheck.hub_name})`
                      : 'Standard & Transfer Delivery Available'}
                  </p>
                  <p className="mt-0.5 text-[#64748B]">{pinCheck.reason}</p>
                </div>
              </div>
            )}

            {/* Saved Addresses [FEATURE_ADDRESSES] */}
            {isFeatureEnabled('FEATURE_ADDRESSES') && (
              <div className="mt-5 border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#64748B] uppercase">
                    Saved Addresses
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowNewAddress(!showNewAddress)}
                    className="text-xs font-semibold text-[#4F46E5] hover:underline"
                  >
                    {showNewAddress ? 'Cancel' : '+ Add Address'}
                  </button>
                </div>

                {addresses.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {addresses.map((addr) => (
                      <button
                        key={addr.address_id}
                        type="button"
                        onClick={() => setPinCode(addr.pin_code)}
                        className={`rounded-lg border px-3 py-2 text-left text-xs ${
                          pinCode === addr.pin_code
                            ? 'border-[#4F46E5] bg-indigo-50/60'
                            : 'border-[#E2E8F0] bg-white'
                        }`}
                      >
                        <p className="font-semibold text-[#111827]">
                          {addr.label} · {addr.pin_code}
                        </p>
                        <p className="text-[#64748B]">{addr.line1}</p>
                      </button>
                    ))}
                  </div>
                )}

                {showNewAddress && (
                  <form
                    onSubmit={handleSaveAddress}
                    className="mt-3 grid grid-cols-1 gap-2.5 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 sm:grid-cols-2"
                  >
                    <input
                      type="text"
                      value={newAddr.recipient_name}
                      onChange={(e) => setNewAddr({ ...newAddr, recipient_name: e.target.value })}
                      placeholder="Recipient name"
                      required
                      className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs"
                    />
                    <input
                      type="text"
                      value={newAddr.phone}
                      onChange={(e) => setNewAddr({ ...newAddr, phone: e.target.value })}
                      placeholder="Phone"
                      required
                      className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs"
                    />
                    <input
                      type="text"
                      value={newAddr.line1}
                      onChange={(e) => setNewAddr({ ...newAddr, line1: e.target.value })}
                      placeholder="Street / Flat"
                      required
                      className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs sm:col-span-2"
                    />
                    <input
                      type="text"
                      maxLength={6}
                      value={newAddr.pin_code}
                      onChange={(e) => setNewAddr({ ...newAddr, pin_code: e.target.value })}
                      placeholder="6-digit PIN"
                      required
                      className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 font-mono text-xs"
                    />
                    <button
                      type="submit"
                      className="rounded-lg bg-[#4F46E5] px-4 py-1.5 text-xs font-semibold text-white"
                    >
                      Save Address
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>

          {/* Fulfilment Groups Preview */}
          <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-[#111827]">
                Fulfilment Groups Preview ({previewGroups.length})
              </h2>
              {unreservedItems.length > 0 && (
                <button
                  type="button"
                  disabled={reservingAll}
                  onClick={() => void reserveAllNeeded()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#4F46E5] px-3 py-1.5 text-xs font-semibold text-[#4F46E5] hover:bg-indigo-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>
                    {reservingAll
                      ? 'Reserving...'
                      : `Reserve ${unreservedItems.length} Unreserved Item(s)`}
                  </span>
                </button>
              )}
            </div>

            <div className="space-y-4">
              {previewGroups.map((grp, idx) => (
                <div
                  key={grp.key}
                  className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                    <div>
                      <p className="text-sm font-bold text-[#111827]">
                        Group {idx + 1} ·{' '}
                        {grp.mode === 'quick'
                          ? 'Quick Hub (15–35 mins)'
                          : grp.mode === 'transfer'
                            ? 'Inter-City Transfer (~2–3 days)'
                            : 'Standard Warehouse (1–2 days)'}
                      </p>
                    </div>
                    <span className="font-mono text-xs font-semibold text-[#111827] tabular-nums">
                      Fee: {grp.feePaise === 0 ? 'FREE' : formatPaise(grp.feePaise)}
                    </span>
                  </div>

                  <div className="mt-3 space-y-2.5">
                    {grp.items.map((item) => {
                      const canDowngrade =
                        item.reservation_id &&
                        pinCheck?.quick_available &&
                        item.eligible_modes.includes('quick') &&
                        item.preferred_location_id === pinCheck?.hub_location_id;

                      return (
                        <div
                          key={item.cart_item_id}
                          className="flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <p className="font-semibold text-[#111827]">
                              {item.product_name} × {item.quantity}
                            </p>
                            <p className="text-[#64748B]">
                              {item.shop_name} ·{' '}
                              {item.reservation_status === 'reserved'
                                ? 'Held for 10m'
                                : 'Will reserve on order'}
                            </p>
                          </div>

                          <div className="flex items-center gap-3">
                            {canDowngrade && item.reservation_id && (
                              <select
                                value={modePrefs[item.reservation_id] || 'quick'}
                                onChange={(e) =>
                                  setModePrefs((prev) => ({
                                    ...prev,
                                    [item.reservation_id!]: e.target.value as 'quick' | 'standard',
                                  }))
                                }
                                aria-label="Choose delivery mode"
                                className="rounded border border-[#E2E8F0] bg-white px-2 py-1 text-xs"
                              >
                                <option value="quick">Quick Hub (Rs.49)</option>
                                <option value="standard">Switch to Standard</option>
                              </select>
                            )}
                            <span className="font-mono font-semibold text-[#111827] tabular-nums">
                              {formatPaise(item.current_price_paise * item.quantity)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Price Change Conflict / Checkout Errors */}
          {checkoutError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-[#DC2626]">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold">{checkoutError}</p>
                  {priceConflicts.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {priceConflicts.map((c) => (
                        <p key={c.reservation_id} className="font-mono text-xs text-red-900">
                          Updated dealer price: {formatPaise(c.current_price_paise)}
                        </p>
                      ))}
                      <button
                        type="button"
                        onClick={() => void handleResolvePriceChange()}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#DC2626] px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Release &amp; Re-reserve at New Price</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Summary & Simulated Payment */}
        <aside className="lg:col-span-4">
          <div className="sticky top-24 space-y-4">
            {/* Coupons [FEATURE_COUPONS] */}
            {isFeatureEnabled('FEATURE_COUPONS') && (
              <form
                onSubmit={handleValidateCoupon}
                className="rounded-2xl border border-[#E2E8F0] bg-white p-5"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-[#111827] uppercase">
                  <Tag className="h-3.5 w-3.5 text-[#4F46E5]" />
                  <span>Promo Coupon (Optional)</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <input
                    type="text"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="e.g. SAVE100"
                    className="h-9 flex-1 rounded-lg border border-[#E2E8F0] px-3 font-mono text-xs uppercase focus:border-[#4F46E5] focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="h-9 rounded-lg border border-[#E2E8F0] px-3 text-xs font-semibold text-[#111827] hover:bg-slate-50"
                  >
                    Apply
                  </button>
                </div>
                {couponError && <p className="mt-2 text-xs text-[#DC2626]">{couponError}</p>}
                {couponPreview && (
                  <p className="mt-2 flex items-center gap-1 text-xs font-medium text-[#16A34A]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>
                      {couponPreview.code}: -{formatPaise(couponPreview.discount_paise)}
                    </span>
                  </p>
                )}
              </form>
            )}

            <div className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
              <h2 className="font-display text-lg font-bold text-[#111827]">Payment Summary</h2>

              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950">
                SIMULATED SANDBOX UPI GATEWAY — No real money moves; order &amp; ledger state are
                authoritative in PostgreSQL.
              </div>

              <dl className="mt-4 space-y-2 border-b border-[#E2E8F0] pb-4 text-sm">
                <div className="flex justify-between">
                  <dt className="text-[#64748B]">Items Total</dt>
                  <dd className="font-mono tabular-nums">{formatPaise(subtotalPaise)}</dd>
                </div>
                {discountPaise > 0 && (
                  <div className="flex justify-between text-[#16A34A]">
                    <dt>Coupon Discount</dt>
                    <dd className="font-mono tabular-nums">-{formatPaise(discountPaise)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-[#64748B]">Estimated Delivery Fees</dt>
                  <dd className="font-mono tabular-nums">{formatPaise(estimatedDeliveryTotal)}</dd>
                </div>
                <div className="flex justify-between pt-2 text-base font-bold text-[#111827]">
                  <dt>Total Payable</dt>
                  <dd className="font-mono tabular-nums">{formatPaise(estimatedGrandTotal)}</dd>
                </div>
              </dl>

              <button
                type="button"
                disabled={placingOrder || reservingAll}
                onClick={() => void handlePlaceOrder()}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#4F46E5] px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                <span>
                  {placingOrder ? 'Confirming Order...' : 'Place Order (Sandbox UPI)'}
                </span>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
