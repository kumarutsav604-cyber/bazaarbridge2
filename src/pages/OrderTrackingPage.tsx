import { ArrowLeft, CheckCircle2, Clock, KeyRound, Package, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CardGridSkeleton, ErrorState } from '../components/States';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise, usePolling } from '../kit';

interface OrderItemDetail {
  order_item_id: string;
  group_id: string;
  product_name: string;
  brand: string;
  shop_name: string;
  quantity: number;
  line_price: number;
  discount_share: number;
  delivery_fee_share: number;
  item_paid_amount: number;
  fulfilment_route: string;
  stock_finalised: boolean;
  item_status: string;
  stock_location_name: string;
  stock_location_city: string;
  transfer_id: string | null;
  transfer_status: string | null;
  cancel_on_receipt: boolean | null;
  refund_id: string | null;
  refund_status: string | null;
  refund_item_amount: number | null;
  refund_fee_amount: number | null;
}

interface TimelineEntry {
  timeline_id: string;
  status: string;
  note: string | null;
  created_at: string;
}

interface FulfilmentGroupDetail {
  group_id: string;
  mode: 'quick' | 'standard' | 'transfer';
  status: string;
  fee_total: number;
  location_name: string | null;
  location_city: string | null;
  eta_window_start: string;
  eta_window_end: string;
  cancellable: boolean;
  delivery_otp?: string;
  delivery_otp_label?: string;
  timeline: TimelineEntry[];
}

interface OrderTrackingResponse {
  order: {
    order_id: string;
    items_total: number;
    discount_total: number;
    delivery_fee_total: number;
    total_amount: number;
    coupon_code: string | null;
    delivery_pin_code: string;
    status: string;
    placed_at: string;
    payment_status: string;
    payment_gateway_ref: string;
    payment_label: string;
  };
  items: OrderItemDetail[];
  groups: FulfilmentGroupDetail[];
}

export function OrderTrackingPage() {
  const { id } = useParams<{ id: string }>();
  const { addToast } = useToast();

  const [data, setData] = useState<OrderTrackingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const loadOrder = useCallback(async () => {
    if (!id) return;
    try {
      const res = await apiFetch<OrderTrackingResponse>(`/api/orders/${id}`);
      setData(res);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load order tracking.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Poll every 5 seconds for live Kafka consumer status updates
  usePolling(loadOrder, 5000, Boolean(id));

  const handleCancelItem = async (orderItemId: string) => {
    if (!id) return;
    setCancellingId(orderItemId);
    try {
      const res = await apiFetch<{
        refund: { item_amount: number; fee_amount: number; status: string; label: string };
      }>(`/api/orders/${id}/items/${orderItemId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({
          request_key: `cancel-${orderItemId}`,
          reason_code: 'customer_requested',
        }),
      });
      addToast(
        `Item cancelled. Refund ${formatPaise(res.refund.item_amount + res.refund.fee_amount)} (${res.refund.status} · ${res.refund.label}).`,
        'success'
      );
      await loadOrder();
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Cancellation failed.', 'error');
    } finally {
      setCancellingId(null);
    }
  };

  if (loading && !data) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <CardGridSkeleton count={2} />
      </main>
    );
  }

  if (error && !data) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <ErrorState
          title="Order tracking unavailable"
          message={error}
          onRetry={() => void loadOrder()}
        />
      </main>
    );
  }

  if (!data) return null;

  const { order, groups, items } = data;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            to="/orders"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[#64748B] hover:text-[#111827]"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>All Orders</span>
          </Link>
          <h1 className="mt-2 font-display text-2xl font-bold text-[#111827] sm:text-3xl">
            Order #{order.order_id.slice(0, 8)}
          </h1>
          <p className="mt-1 text-xs text-[#64748B]">
            Placed {new Date(order.placed_at).toLocaleString()} · PIN{' '}
            <span className="font-mono text-[#111827]">{order.delivery_pin_code}</span> · Polling
            live every 5s
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadOrder()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3.5 py-2 text-xs font-semibold text-[#111827] hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh Now</span>
        </button>
      </div>

      {/* Order Financial Summary */}
      <section className="mb-8 rounded-2xl border border-[#E2E8F0] bg-white p-6">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
          <div>
            <p className="text-xs text-[#64748B]">Items Total</p>
            <p className="mt-1 font-mono font-semibold text-[#111827] tabular-nums">
              {formatPaise(order.items_total)}
            </p>
          </div>
          <div>
            <p className="text-xs text-[#64748B]">Discount</p>
            <p className="mt-1 font-mono font-semibold text-[#16A34A] tabular-nums">
              -{formatPaise(order.discount_total)}
            </p>
          </div>
          <div>
            <p className="text-xs text-[#64748B]">Delivery Fees</p>
            <p className="mt-1 font-mono font-semibold text-[#111827] tabular-nums">
              {formatPaise(order.delivery_fee_total)}
            </p>
          </div>
          <div>
            <p className="text-xs text-[#64748B]">Grand Total</p>
            <p className="mt-1 font-mono text-base font-bold text-[#111827] tabular-nums">
              {formatPaise(order.total_amount)}
            </p>
          </div>
          <div>
            <p className="text-xs text-[#64748B]">Payment ({order.payment_label})</p>
            <p className="mt-1 font-semibold text-[#16A34A]">{order.payment_status}</p>
          </div>
        </div>
      </section>

      {/* Fulfilment Groups */}
      <div className="space-y-6">
        {groups.map((grp, idx) => {
          const groupItems = items.filter((i) => i.group_id === grp.group_id);
          return (
            <section
              key={grp.group_id}
              className="rounded-2xl border border-[#E2E8F0] bg-white p-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E2E8F0] pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Package className="h-4 w-4 text-[#4F46E5]" />
                    <h2 className="font-display text-lg font-bold text-[#111827]">
                      Fulfilment Group {idx + 1} · {grp.mode.toUpperCase()}
                    </h2>
                    <span className="font-mono text-xs font-semibold text-[#4F46E5]">
                      Status: {grp.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#64748B]">
                    Origin: {grp.location_name || 'Warehouse'} ({grp.location_city || 'Bangalore'})
                    · Fee: {grp.fee_total === 0 ? 'FREE' : formatPaise(grp.fee_total)}
                  </p>
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-[#111827]">
                    <Clock className="h-3.5 w-3.5 text-[#4F46E5]" />
                    ETA Window: {new Date(grp.eta_window_start).toLocaleString()} –{' '}
                    {new Date(grp.eta_window_end).toLocaleString()}
                  </p>
                </div>

                {/* SAMPLE DEMO OTP for owning customer while undelivered */}
                {grp.delivery_otp && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5">
                    <p className="font-mono text-[10px] font-bold tracking-wider text-amber-900 uppercase">
                      {grp.delivery_otp_label || 'SAMPLE DEMO OTP'}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 font-mono text-lg font-bold text-amber-950">
                      <KeyRound className="h-4 w-4" />
                      <span>{grp.delivery_otp}</span>
                    </p>
                  </div>
                )}
              </div>

              {/* Group Items & Cancel Controls */}
              <div className="mt-4 divide-y divide-slate-100">
                {groupItems.map((item) => {
                  const canCancel =
                    grp.cancellable &&
                    (item.item_status === 'placed' || item.item_status === 'confirmed');
                  return (
                    <div
                      key={item.order_item_id}
                      className="flex flex-col justify-between gap-4 py-3.5 sm:flex-row sm:items-center"
                    >
                      <div>
                        <p className="text-sm font-semibold text-[#111827]">
                          {item.product_name} × {item.quantity}
                        </p>
                        <p className="mt-0.5 text-xs text-[#64748B]">
                          {item.shop_name} · Stock: {item.stock_location_name} · Item Status:{' '}
                          <span className="font-semibold text-[#111827]">{item.item_status}</span> ·{' '}
                          Stock finalised: {item.stock_finalised ? 'Yes' : 'Pending'}
                        </p>

                        {item.transfer_id && (
                          <p className="mt-1 font-mono text-xs text-amber-800">
                            Transfer status: {item.transfer_status}
                            {item.cancel_on_receipt ? ' (Cancel on receipt flagged)' : ''}
                          </p>
                        )}

                        {item.refund_id && (
                          <p className="mt-1 text-xs font-medium text-[#16A34A]">
                            Path A Refund ({item.refund_status} · SIMULATED GATEWAY):{' '}
                            {formatPaise(
                              Number(item.refund_item_amount || 0) +
                                Number(item.refund_fee_amount || 0)
                            )}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm font-semibold text-[#111827] tabular-nums">
                          Paid {formatPaise(item.item_paid_amount + item.delivery_fee_share)}
                        </span>

                        {canCancel ? (
                          <button
                            type="button"
                            disabled={cancellingId === item.order_item_id}
                            onClick={() => void handleCancelItem(item.order_item_id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#DC2626] hover:bg-red-50 disabled:opacity-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>
                              {cancellingId === item.order_item_id ? 'Cancelling...' : 'Cancel Item'}
                            </span>
                          </button>
                        ) : (
                          <span className="text-xs text-[#64748B]">
                            {item.item_status === 'cancelled'
                              ? 'Cancelled'
                              : 'Dispatched (locked)'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Group Timeline */}
              <div className="mt-5 border-t border-slate-100 pt-4">
                <h3 className="text-xs font-semibold text-[#64748B] uppercase">
                  Fulfilment Event Timeline
                </h3>
                {grp.timeline.length === 0 ? (
                  <p className="mt-2 text-xs text-[#64748B]">
                    Order placed; awaiting Kafka fulfilment pipeline confirmation.
                  </p>
                ) : (
                  <ol className="mt-3 space-y-2.5">
                    {grp.timeline.map((step) => (
                      <li key={step.timeline_id} className="flex items-start gap-2.5 text-xs">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#4F46E5]" />
                        <div>
                          <span className="font-mono font-semibold text-[#111827]">
                            {step.status}
                          </span>
                          {step.note && <span className="text-[#64748B]"> — {step.note}</span>}
                          <p className="font-mono text-[10px] text-slate-400">
                            {new Date(step.created_at).toLocaleString()}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
