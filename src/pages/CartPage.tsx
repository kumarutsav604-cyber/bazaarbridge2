import { ArrowRight, Bookmark, Clock, Lock, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProductImage } from '../components/ProductImage';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { useCart, type CartItemRow } from '../context/CartContext';
import { useSystem } from '../context/SystemContext';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise } from '../kit';

function formatCountdown(expiresAt: string | null, nowMs: number): string | null {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt).getTime() - nowMs;
  if (diff <= 0) return 'Expired';
  const totalSec = Math.floor(diff / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function CartPage() {
  const navigate = useNavigate();
  const { items, savedItems, subtotalPaise, loading, error, refreshCart, removeCartItem } =
    useCart();
  const { isFeatureEnabled } = useSystem();
  const { addToast } = useToast();

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleQtyChange = async (item: CartItemRow, nextQty: number) => {
    if (nextQty < 1 || nextQty > 20) return;
    setBusyId(item.cart_item_id);
    try {
      if (item.reservation_id && item.reservation_status === 'reserved') {
        await apiFetch('/api/cart/release', {
          method: 'POST',
          body: JSON.stringify({ reservation_id: item.reservation_id }),
        }).catch(() => {});
      }
      await apiFetch('/api/cart/items', {
        method: 'POST',
        body: JSON.stringify({
          cart_item_id: item.cart_item_id,
          offer_id: item.offer_id,
          quantity: nextQty,
        }),
      });
      await refreshCart();
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to update quantity.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleReserve = async (item: CartItemRow) => {
    setBusyId(item.cart_item_id);
    try {
      await apiFetch('/api/cart/reserve', {
        method: 'POST',
        body: JSON.stringify({
          cart_item_id: item.cart_item_id,
          offer_id: item.offer_id,
          location_id: item.preferred_location_id || undefined,
          quantity: item.quantity,
          request_key: `ui-${item.cart_item_id}-${Date.now()}`,
        }),
      });
      await refreshCart();
      addToast(`Reserved ${item.quantity} unit(s) of ${item.product_name} for 10 minutes.`, 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Reservation failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRelease = async (item: CartItemRow) => {
    if (!item.reservation_id) return;
    setBusyId(item.cart_item_id);
    try {
      await apiFetch('/api/cart/release', {
        method: 'POST',
        body: JSON.stringify({ reservation_id: item.reservation_id }),
      });
      await refreshCart();
      addToast('Released stock hold.', 'info');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Could not release hold.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveForLater = async (cartItemId: string) => {
    setBusyId(cartItemId);
    try {
      await apiFetch(`/api/cart/items/${cartItemId}/save-for-later`, { method: 'POST' });
      await refreshCart();
      addToast('Moved item to Saved for Later.', 'info');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to save item.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (cartItemId: string) => {
    setBusyId(cartItemId);
    try {
      const res = await apiFetch<{
        price_changed: boolean;
        old_price_paise: number;
        new_price_paise: number;
        in_stock: boolean;
      }>(`/api/cart/items/${cartItemId}/restore`, { method: 'POST' });
      await refreshCart();
      if (res.price_changed) {
        addToast(
          `Restored to cart — price updated from ${formatPaise(res.old_price_paise)} to ${formatPaise(res.new_price_paise)}.`,
          'info'
        );
      } else {
        addToast('Restored item to active cart.', 'success');
      }
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to restore item.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (cartItemId: string) => {
    setBusyId(cartItemId);
    try {
      await removeCartItem(cartItemId);
      addToast('Removed item from cart.', 'info');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to remove item.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#111827] sm:text-3xl">
            Shopping Cart &amp; Stock Reservations
          </h1>
          <p className="mt-1 text-sm text-[#64748B]">
            Lock inventory atomically for 10 minutes before checkout or let Checkout reserve
            automatically.
          </p>
        </div>
        <Link to="/products" className="text-sm font-medium text-[#4F46E5] hover:underline">
          Continue shopping →
        </Link>
      </div>

      {loading && <CardGridSkeleton count={2} />}

      {!loading && error && (
        <ErrorState
          title="Unable to load cart"
          message={error}
          onRetry={() => void refreshCart()}
        />
      )}

      {!loading && !error && items.length === 0 && savedItems.length === 0 && (
        <EmptyState
          title="Your cart is empty"
          description="Browse multi-dealer electronics and compare offers before adding items to your cart."
          actionLabel="Browse Catalog"
          onAction={() => navigate('/products')}
        />
      )}

      {!loading && !error && (items.length > 0 || savedItems.length > 0) && (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-8">
            {items.map((item) => {
              const isReserved =
                item.reservation_status === 'reserved' &&
                item.reservation_expires_at &&
                new Date(item.reservation_expires_at).getTime() > nowMs;
              const countdown = isReserved
                ? formatCountdown(item.reservation_expires_at, nowMs)
                : null;
              const isBusy = busyId === item.cart_item_id;

              return (
                <article
                  key={item.cart_item_id}
                  className="flex flex-col gap-4 rounded-xl border border-[#E2E8F0] bg-white p-4 sm:flex-row"
                >
                  <Link
                    to={`/products/${item.product_id}`}
                    className="w-full shrink-0 overflow-hidden rounded-lg bg-slate-50 sm:w-32"
                  >
                    <ProductImage
                      src={item.image_url}
                      alt={item.product_name}
                      className="aspect-[4/3] w-full object-cover"
                    />
                  </Link>

                  <div className="flex flex-1 flex-col justify-between">
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <Link
                            to={`/products/${item.product_id}`}
                            className="font-display text-base font-semibold text-[#111827] hover:text-[#4F46E5]"
                          >
                            {item.product_name}
                          </Link>
                          <p className="mt-0.5 text-xs text-[#64748B]">
                            {item.shop_name} · {item.dealer_city} · {item.available_units} free units
                          </p>
                        </div>

                        <div className="text-right">
                          <p className="font-mono text-base font-bold text-[#111827] tabular-nums">
                            {formatPaise(item.current_price_paise * item.quantity)}
                          </p>
                          <p className="font-mono text-xs text-[#64748B] tabular-nums">
                            {formatPaise(item.current_price_paise)} each
                          </p>
                        </div>
                      </div>

                      {item.price_changed && (
                        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                          Dealer price changed from {formatPaise(item.price_snapshot)} to{' '}
                          {formatPaise(item.current_price_paise)}.
                        </p>
                      )}

                      {isReserved && countdown && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-[#16A34A]">
                          <Clock className="h-3.5 w-3.5" />
                          <span>Stock Reserved · Expires in {countdown}</span>
                        </div>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isBusy || item.quantity <= 1}
                          onClick={() => void handleQtyChange(item, item.quantity - 1)}
                          aria-label="Decrease quantity"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#111827] hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-6 text-center font-mono text-sm font-semibold tabular-nums">
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          disabled={isBusy || item.quantity >= 20}
                          onClick={() => void handleQtyChange(item, item.quantity + 1)}
                          aria-label="Increase quantity"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#111827] hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {isReserved ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleRelease(item)}
                            className="rounded-lg border border-[#E2E8F0] px-3 py-1.5 text-xs font-medium text-[#64748B] hover:text-[#111827]"
                          >
                            Release Hold
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isBusy || item.available_units < item.quantity}
                            onClick={() => void handleReserve(item)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[#4F46E5] px-3 py-1.5 text-xs font-semibold text-[#4F46E5] hover:bg-indigo-50 disabled:opacity-50"
                          >
                            <Lock className="h-3 w-3" />
                            <span>Reserve 10m</span>
                          </button>
                        )}

                        {isFeatureEnabled('FEATURE_SAVE_LATER') && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleSaveForLater(item.cart_item_id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[#E2E8F0] px-3 py-1.5 text-xs font-medium text-[#64748B] hover:text-[#111827]"
                          >
                            <Bookmark className="h-3 w-3" />
                            <span>Save</span>
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleRemove(item.cart_item_id)}
                          aria-label="Remove item"
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-red-50"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Remove</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}

            {/* Saved for Later List [FEATURE_SAVE_LATER] */}
            {savedItems.length > 0 && (
              <section className="mt-8 rounded-xl border border-[#E2E8F0] bg-white p-5">
                <h2 className="font-display text-base font-bold text-[#111827]">
                  Saved for Later ({savedItems.length})
                </h2>
                <div className="mt-3 divide-y divide-slate-100">
                  {savedItems.map((saved) => (
                    <div
                      key={saved.cart_item_id}
                      className="flex flex-wrap items-center justify-between gap-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-[#111827]">{saved.product_name}</p>
                        <p className="text-xs text-[#64748B]">
                          {saved.shop_name} · {formatPaise(saved.current_price_paise)} ·{' '}
                          {saved.available_units} available
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busyId === saved.cart_item_id}
                          onClick={() => void handleRestore(saved.cart_item_id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] px-3 py-1.5 text-xs font-semibold text-[#4F46E5] hover:bg-indigo-50"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Move to Cart</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyId === saved.cart_item_id}
                          onClick={() => void handleRemove(saved.cart_item_id)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Order Summary Sidebar */}
          {items.length > 0 && (
            <aside className="lg:col-span-4">
              <div className="sticky top-24 rounded-2xl border border-[#E2E8F0] bg-white p-6">
                <h2 className="font-display text-lg font-bold text-[#111827]">Cart Summary</h2>
                <dl className="mt-4 space-y-2.5 border-b border-[#E2E8F0] pb-4 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-[#64748B]">
                      Items ({items.reduce((s, i) => s + i.quantity, 0)})
                    </dt>
                    <dd className="font-mono font-semibold text-[#111827] tabular-nums">
                      {formatPaise(subtotalPaise)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#64748B]">Delivery Fees</dt>
                    <dd className="text-xs text-[#64748B]">Calculated by PIN &amp; group</dd>
                  </div>
                </dl>

                <p className="mt-3 text-xs text-[#64748B]">
                  Standard delivery is free at Rs.999+ per group. Quick Hub is Rs.49 and Inter-City
                  Transfer is Rs.69 (SAMPLE rates).
                </p>

                <button
                  type="button"
                  onClick={() => navigate('/checkout')}
                  className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#4F46E5] px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
                >
                  <span>Proceed to Checkout</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </aside>
          )}
        </div>
      )}
    </main>
  );
}
