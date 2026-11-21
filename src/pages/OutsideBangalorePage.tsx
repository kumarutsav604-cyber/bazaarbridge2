import { MapPin, ShoppingCart, Truck, Warehouse } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProductImage } from '../components/ProductImage';
import { CardGridSkeleton, ErrorState } from '../components/States';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise } from '../kit';

interface OutsideOfferRow {
  offer_id: string;
  product_id: string;
  product_name: string;
  brand: string;
  image_url: string | null;
  category_name: string;
  shop_name: string;
  dealer_city: string;
  dealer_state: string;
  dealer_rating: number;
  selling_price: number;
  bangalore_delivery_days?: number | null;
  transfer_days_min?: number | null;
  transfer_days_max?: number | null;
  location_id: string;
  location_name: string;
  holding_city?: string;
  holding_state?: string;
  free_units: number;
}

export function OutsideBangalorePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToCart } = useCart();
  const { addToast } = useToast();

  const [sectionA, setSectionA] = useState<OutsideOfferRow[]>([]);
  const [sectionB, setSectionB] = useState<OutsideOfferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{
        section_a: OutsideOfferRow[];
        section_b: OutsideOfferRow[];
      }>('/api/outside-bangalore');
      setSectionA(res.section_a || []);
      setSectionB(res.section_b || []);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Unable to load Outside Bangalore catalog.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleAdd = async (offerId: string, productName: string) => {
    if (!user) {
      addToast('Sign in to reserve and order items.', 'info');
      navigate('/login');
      return;
    }
    setAddingId(offerId);
    try {
      await addToCart(offerId, 1);
      addToast(`Added ${productName} to cart.`, 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Could not add item to cart.', 'error');
    } finally {
      setAddingId(null);
    }
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="font-display text-2xl font-bold text-[#111827] sm:text-3xl">
          Outside Bangalore Inventory &amp; Regional Partners
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-[#64748B]">
          Offers from dealers outside Bangalore are clearly separated by where the physical stock
          resides right now — already stored in Bangalore or held at a regional stock location for
          transfer.
        </p>
      </div>

      {loading && <CardGridSkeleton count={4} />}

      {!loading && error && (
        <ErrorState
          title="Unable to load Outside Bangalore offers"
          message={error}
          onRetry={() => void loadData()}
        />
      )}

      {!loading && !error && (
        <div className="space-y-12">
          {/* Section A — Always visible even if empty */}
          <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
            <div className="mb-5 flex items-start gap-3">
              <Warehouse className="mt-0.5 h-5 w-5 shrink-0 text-[#4F46E5]" />
              <div>
                <h2 className="font-display text-xl font-bold text-[#111827]">
                  In Bangalore Stock – Faster Delivery
                </h2>
                <p className="mt-1 text-sm text-[#64748B]">
                  Outside-Bangalore dealers whose inventory is already positioned in the Bangalore
                  Central Warehouse for standard 1–2 day local dispatch.
                </p>
              </div>
            </div>

            {sectionA.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-6 text-sm text-[#64748B]">
                No outside-Bangalore dealer offers are currently stocked inside Bangalore
                warehouses.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {sectionA.map((item) => (
                  <article
                    key={item.offer_id}
                    className="flex flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-white"
                  >
                    <Link to={`/products/${item.product_id}`} className="block bg-slate-50">
                      <ProductImage
                        src={item.image_url}
                        alt={item.product_name}
                        className="aspect-[4/3] w-full object-cover"
                      />
                    </Link>
                    <div className="flex flex-1 flex-col p-4">
                      <p className="text-xs font-semibold text-[#64748B] uppercase">
                        {item.brand} · {item.category_name}
                      </p>
                      <Link
                        to={`/products/${item.product_id}`}
                        className="mt-1 font-display text-base font-semibold text-[#111827] hover:text-[#4F46E5]"
                      >
                        {item.product_name}
                      </Link>
                      <p className="mt-1 text-xs text-[#64748B]">
                        Dealer: {item.shop_name} ({item.dealer_city})
                      </p>
                      <p className="mt-1 text-xs font-medium text-[#4F46E5]">
                        Stocked at: {item.location_name} · ~{item.bangalore_delivery_days ?? 2}d
                      </p>
                      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                        <span className="font-mono text-base font-bold text-[#111827] tabular-nums">
                          {formatPaise(item.selling_price)}
                        </span>
                        <button
                          type="button"
                          disabled={addingId === item.offer_id}
                          onClick={() => void handleAdd(item.offer_id, item.product_name)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[#4F46E5] px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          <ShoppingCart className="h-3.5 w-3.5" />
                          <span>{addingId === item.offer_id ? 'Adding...' : 'Add to Cart'}</span>
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* Section B — Always visible even if empty */}
          <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
            <div className="mb-5 flex items-start gap-3">
              <Truck className="mt-0.5 h-5 w-5 shrink-0 text-[#F59E0B]" />
              <div>
                <h2 className="font-display text-xl font-bold text-[#111827]">
                  Moved From Another Stock Location – Approximately 2–3 Days
                </h2>
                <p className="mt-1 text-sm text-[#64748B]">
                  Held at a regional partner holding location (e.g., Mysuru) and transferred to
                  Bangalore Central Warehouse on order placement before last-mile dispatch.
                </p>
              </div>
            </div>

            {sectionB.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#E2E8F0] bg-[#F8FAFC] p-6 text-sm text-[#64748B]">
                No regional holding stock transfer offers are currently listed.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {sectionB.map((item) => (
                  <article
                    key={item.offer_id}
                    className="flex flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-white"
                  >
                    <Link to={`/products/${item.product_id}`} className="block bg-slate-50">
                      <ProductImage
                        src={item.image_url}
                        alt={item.product_name}
                        className="aspect-[4/3] w-full object-cover"
                      />
                    </Link>
                    <div className="flex flex-1 flex-col p-4">
                      <p className="text-xs font-semibold text-[#64748B] uppercase">
                        {item.brand} · {item.category_name}
                      </p>
                      <Link
                        to={`/products/${item.product_id}`}
                        className="mt-1 font-display text-base font-semibold text-[#111827] hover:text-[#4F46E5]"
                      >
                        {item.product_name}
                      </Link>
                      <p className="mt-1 text-xs text-[#64748B]">
                        Dealer: {item.shop_name} ({item.dealer_city}, {item.dealer_state})
                      </p>
                      <p className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-amber-800">
                        <MapPin className="h-3.5 w-3.5" />
                        Holding city: {item.holding_city || item.dealer_city} · Est.{' '}
                        {item.transfer_days_min ?? 2}–{item.transfer_days_max ?? 3} days
                      </p>
                      <p className="mt-1 text-xs text-[#64748B] tabular-nums">
                        {item.free_units} units available at holding location
                      </p>
                      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                        <span className="font-mono text-base font-bold text-[#111827] tabular-nums">
                          {formatPaise(item.selling_price)}
                        </span>
                        <button
                          type="button"
                          disabled={addingId === item.offer_id}
                          onClick={() => void handleAdd(item.offer_id, item.product_name)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[#4F46E5] px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          <ShoppingCart className="h-3.5 w-3.5" />
                          <span>{addingId === item.offer_id ? 'Adding...' : 'Add to Cart'}</span>
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
