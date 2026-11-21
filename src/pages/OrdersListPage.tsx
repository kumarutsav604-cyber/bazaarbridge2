import { ArrowRight, PackageCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { apiFetch, formatPaise } from '../kit';

interface OrderSummaryRow {
  order_id: string;
  items_total: number;
  discount_total: number;
  delivery_fee_total: number;
  total_amount: number;
  coupon_code: string | null;
  delivery_pin_code: string;
  status: string;
  placed_at: string;
  payment_status: string | null;
  item_count: number;
}

export function OrdersListPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<OrderSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ orders: OrderSummaryRow[] }>('/api/orders');
      setOrders(res.orders || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-[#111827] sm:text-3xl">
          My Orders &amp; Live Tracking
        </h1>
        <p className="mt-1 text-sm text-[#64748B]">
          Track multi-group fulfilment stages, inter-city transfers, and item-level cancellations.
        </p>
      </div>

      {loading && <CardGridSkeleton count={3} />}

      {!loading && error && (
        <ErrorState
          title="Could not load order history"
          message={error}
          onRetry={() => void loadOrders()}
        />
      )}

      {!loading && !error && orders.length === 0 && (
        <EmptyState
          title="No orders placed yet"
          description="Explore multi-dealer offers, add items to your cart, and complete checkout to track live delivery events."
          actionLabel="Browse Products"
          onAction={() => navigate('/products')}
        />
      )}

      {!loading && !error && orders.length > 0 && (
        <div className="space-y-4">
          {orders.map((order) => (
            <Link
              key={order.order_id}
              to={`/orders/${order.order_id}`}
              className="flex flex-col justify-between gap-4 rounded-xl border border-[#E2E8F0] bg-white p-5 transition-all hover:border-[#4F46E5] sm:flex-row sm:items-center"
            >
              <div>
                <div className="flex items-center gap-2">
                  <PackageCheck className="h-4 w-4 text-[#4F46E5]" />
                  <span className="font-mono text-xs font-semibold text-[#111827]">
                    Order #{order.order_id.slice(0, 8)}
                  </span>
                  <span className="text-xs text-[#64748B]">
                    · {new Date(order.placed_at).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-[#64748B]">
                  {order.item_count} item{order.item_count === 1 ? '' : 's'} · PIN{' '}
                  <span className="font-mono text-[#111827]">{order.delivery_pin_code}</span> ·{' '}
                  Status: <span className="font-semibold text-[#111827]">{order.status}</span>
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="font-mono text-base font-bold text-[#111827] tabular-nums">
                    {formatPaise(order.total_amount)}
                  </p>
                  <p className="text-xs text-[#64748B]">
                    Payment: {order.payment_status || 'simulated'}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-[#4F46E5]" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
