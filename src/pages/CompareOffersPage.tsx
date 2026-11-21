import { Award, CheckCircle2, ShoppingCart, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { type ProductSummary } from '../components/ProductCard';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useSystem } from '../context/SystemContext';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise } from '../kit';

type CategoryKey = 'budget' | 'fastest' | 'rated' | 'value' | 'available';

const CATEGORY_TABS: Array<{ key: CategoryKey; label: string }> = [
  { key: 'budget', label: 'Best Budget' },
  { key: 'fastest', label: 'Fastest Delivery' },
  { key: 'rated', label: 'Top Rated' },
  { key: 'value', label: 'Best Value' },
  { key: 'available', label: 'Most Available' },
];

interface RankedOffer {
  offer_id: string;
  product_id: string;
  shop_name: string;
  dealer_city: string;
  dealer_rating: number;
  total_reviews: number;
  verified: boolean;
  selling_price: number;
  effective_days: number;
  value_score: number;
  sellable_free_units: number;
  home_units: number;
  warranty_months: number;
  reason: string;
}

interface CompareSpecProduct {
  product_id: string;
  name: string;
  brand: string;
  category_name: string;
  min_price_paise: number | null;
  dealer_count: number;
  specs: Record<string, unknown> | null;
}

export function CompareOffersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToCart } = useCart();
  const { isFeatureEnabled } = useSystem();
  const { addToast } = useToast();

  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [selectedProductId, setSelectedProductId] = useState(searchParams.get('productId') || '');
  const [activeTab, setActiveTab] = useState<CategoryKey>('budget');

  const [winner, setWinner] = useState<RankedOffer | null>(null);
  const [offers, setOffers] = useState<RankedOffer[]>([]);
  const [reason, setReason] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  // Side-by-side multi-product spec comparison [FEATURE_COMPARE]
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareProducts, setCompareProducts] = useState<CompareSpecProduct[]>([]);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ products: ProductSummary[] }>('/api/products');
      const list = res.products || [];
      setProducts(list);
      if (list.length > 0 && !selectedProductId) {
        const multi = list.find((p) => p.dealer_count >= 5) || list[0];
        setSelectedProductId(multi.product_id);
      } else if (list.length === 0) {
        setLoading(false);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load products.');
      setLoading(false);
    }
  }, [selectedProductId]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const loadComparison = useCallback(async () => {
    if (!selectedProductId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{
        category: CategoryKey;
        winner: RankedOffer | null;
        offers: RankedOffer[];
        reason: string;
      }>(`/api/products/${selectedProductId}/offers?category=${activeTab}`);
      setWinner(res.winner);
      setOffers(res.offers || []);
      setReason(res.reason || '');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rank dealer offers.');
    } finally {
      setLoading(false);
    }
  }, [selectedProductId, activeTab]);

  useEffect(() => {
    void loadComparison();
  }, [loadComparison]);

  useEffect(() => {
    if (!isFeatureEnabled('FEATURE_COMPARE') || compareIds.length === 0) {
      setCompareProducts([]);
      return;
    }
    apiFetch<{ products: CompareSpecProduct[] }>(
      `/api/products/compare?ids=${encodeURIComponent(compareIds.join(','))}`
    )
      .then((res) => setCompareProducts(res.products || []))
      .catch(() => setCompareProducts([]));
  }, [compareIds, isFeatureEnabled]);

  const handleSelectProduct = (pid: string) => {
    setSelectedProductId(pid);
    setSearchParams({ productId: pid });
  };

  const handleAdd = async (offerId: string, shopName: string) => {
    if (!user) {
      addToast('Sign in to reserve and add dealer offers to your cart.', 'info');
      navigate('/login');
      return;
    }
    setAddingId(offerId);
    try {
      await addToCart(offerId, 1);
      addToast(`Added offer from ${shopName} to cart.`, 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to add offer.', 'error');
    } finally {
      setAddingId(null);
    }
  };

  const toggleSpecCompare = (pid: string) => {
    setCompareIds((prev) =>
      prev.includes(pid) ? prev.filter((id) => id !== pid) : [...prev.slice(-2), pid]
    );
  };

  const allSpecKeys = Array.from(
    new Set(compareProducts.flatMap((p) => (p.specs ? Object.keys(p.specs) : [])))
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#111827] sm:text-3xl">
            Multi-Dealer Offer Comparison
          </h1>
          <p className="mt-1 text-sm text-[#64748B]">
            Server-side SQL ranking across 5 decision categories using only active in-stock offers.
          </p>
        </div>

        <div className="w-full sm:w-80">
          <label
            htmlFor="compare-product-select"
            className="mb-1 block text-xs font-semibold text-[#64748B] uppercase"
          >
            Select Product
          </label>
          <select
            id="compare-product-select"
            value={selectedProductId}
            disabled={products.length === 0}
            onChange={(e) => handleSelectProduct(e.target.value)}
            className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm font-medium text-[#111827] focus:border-[#4F46E5] focus:outline-none disabled:bg-slate-50 disabled:text-[#64748B]"
          >
            {products.length === 0 ? (
              <option value="">No catalog products loaded</option>
            ) : (
              products.map((p) => (
                <option key={p.product_id} value={p.product_id}>
                  {p.name} ({p.dealer_count} dealers)
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      {/* 5 Category Tabs */}
      <div
        role="tablist"
        aria-label="Comparison categories"
        className="mb-6 flex flex-wrap gap-2 border-b border-[#E2E8F0] pb-3"
      >
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              activeTab === tab.key
                ? 'bg-[#4F46E5] text-white'
                : 'border border-[#E2E8F0] bg-white text-[#64748B] hover:text-[#111827]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && <CardGridSkeleton count={3} />}

      {!loading && error && (
        <ErrorState
          title="Unable to compare offers"
          message={error}
          onRetry={() => void (selectedProductId ? loadComparison() : loadProducts())}
        />
      )}

      {!loading && !error && !winner && (
        <EmptyState
          title="No active in-stock offers for this product"
          description="Select another multi-dealer product above to compare active offers."
        />
      )}

      {!loading && !error && winner && (
        <div className="space-y-6">
          {/* API Winner Banner displaying verbatim API reason */}
          <section className="rounded-2xl border-2 border-[#4F46E5] bg-white p-6 shadow-sm">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-[#4F46E5] uppercase">
                  <Award className="h-4 w-4" />
                  <span>{CATEGORY_TABS.find((t) => t.key === activeTab)?.label} Winner</span>
                </div>
                <h2 className="mt-2 font-display text-xl font-bold text-[#111827]">
                  {winner.shop_name}{' '}
                  <span className="text-sm font-normal text-[#64748B]">
                    · {winner.dealer_city}
                  </span>
                </h2>
                <p className="mt-1.5 text-sm font-medium text-[#111827]">{reason}</p>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="font-mono text-2xl font-bold text-[#111827] tabular-nums">
                    {formatPaise(winner.selling_price)}
                  </p>
                  <p className="text-xs text-[#64748B] tabular-nums">
                    {winner.effective_days}-day ETA · {winner.sellable_free_units} units ready · ★{' '}
                    {winner.dealer_rating.toFixed(1)}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={addingId === winner.offer_id}
                  onClick={() => void handleAdd(winner.offer_id, winner.shop_name)}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#4F46E5] px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <ShoppingCart className="h-4 w-4" />
                  <span>{addingId === winner.offer_id ? 'Adding...' : 'Choose Winner'}</span>
                </button>
              </div>
            </div>
          </section>

          {/* Ranked Offers Table */}
          <section className="overflow-hidden rounded-2xl border border-[#E2E8F0] bg-white">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-semibold text-[#64748B] uppercase">
                  <tr>
                    <th className="px-4 py-3">Rank</th>
                    <th className="px-4 py-3">Dealer</th>
                    <th className="px-4 py-3">Price</th>
                    <th className="px-4 py-3">Delivery</th>
                    <th className="px-4 py-3">Rating</th>
                    <th className="px-4 py-3">Ready Stock</th>
                    <th className="px-4 py-3">Value Score</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {offers.map((offer, idx) => (
                    <tr key={offer.offer_id} className={idx === 0 ? 'bg-indigo-50/40' : ''}>
                      <td className="px-4 py-3.5 font-mono font-semibold text-[#111827] tabular-nums">
                        #{idx + 1}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5 font-semibold text-[#111827]">
                          <span>{offer.shop_name}</span>
                          {offer.verified && (
                            <CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A]" />
                          )}
                        </div>
                        <p className="text-xs text-[#64748B]">
                          {offer.dealer_city} · {offer.warranty_months}m warranty
                        </p>
                      </td>
                      <td className="px-4 py-3.5 font-mono font-semibold text-[#111827] tabular-nums">
                        {formatPaise(offer.selling_price)}
                      </td>
                      <td className="px-4 py-3.5 text-[#111827] tabular-nums">
                        {offer.effective_days} day{offer.effective_days === 1 ? '' : 's'}
                      </td>
                      <td className="px-4 py-3.5 text-[#111827] tabular-nums">
                        ★ {offer.dealer_rating.toFixed(1)}{' '}
                        <span className="text-xs text-[#64748B]">({offer.total_reviews})</span>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-[#111827] tabular-nums">
                        {offer.sellable_free_units}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-[#64748B] tabular-nums">
                        {offer.value_score.toFixed(1)}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <button
                          type="button"
                          disabled={addingId === offer.offer_id}
                          onClick={() => void handleAdd(offer.offer_id, offer.shop_name)}
                          className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-semibold text-[#111827] hover:border-[#4F46E5] hover:text-[#4F46E5] disabled:opacity-50"
                        >
                          {addingId === offer.offer_id ? 'Adding...' : 'Add to Cart'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* Optional Side-by-Side Spec Comparison [FEATURE_COMPARE] */}
      {isFeatureEnabled('FEATURE_COMPARE') && products.length > 1 && (
        <section className="mt-10 rounded-2xl border border-[#E2E8F0] bg-white p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[#4F46E5]" />
              <h2 className="font-display text-lg font-bold text-[#111827]">
                Side-by-Side Product Spec Comparison (Up to 3)
              </h2>
            </div>
            <span className="text-xs text-[#64748B]">
              Missing attributes display &ldquo;Not available&rdquo;
            </span>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {products.slice(0, 8).map((p) => {
              const selected = compareIds.includes(p.product_id);
              return (
                <button
                  key={p.product_id}
                  type="button"
                  onClick={() => toggleSpecCompare(p.product_id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                    selected
                      ? 'border-[#4F46E5] bg-indigo-50 text-[#4F46E5]'
                      : 'border-[#E2E8F0] bg-white text-[#64748B] hover:text-[#111827]'
                  }`}
                >
                  {selected ? '✓ ' : '+ '}
                  {p.name}
                </button>
              );
            })}
          </div>

          {compareProducts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold text-[#64748B] uppercase">Attribute</th>
                    {compareProducts.map((cp) => (
                      <th key={cp.product_id} className="px-3 py-2.5 font-semibold text-[#111827]">
                        <Link to={`/products/${cp.product_id}`} className="hover:text-[#4F46E5]">
                          {cp.name}
                        </Link>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr>
                    <td className="px-3 py-2 font-medium text-[#64748B]">Lowest Offer</td>
                    {compareProducts.map((cp) => (
                      <td key={cp.product_id} className="px-3 py-2 font-mono font-semibold">
                        {cp.min_price_paise ? formatPaise(cp.min_price_paise) : 'Not available'}
                      </td>
                    ))}
                  </tr>
                  {allSpecKeys.map((specKey) => (
                    <tr key={specKey}>
                      <td className="px-3 py-2 font-medium text-[#64748B] capitalize">
                        {specKey.replace(/_/g, ' ')}
                      </td>
                      {compareProducts.map((cp) => (
                        <td key={cp.product_id} className="px-3 py-2 text-[#111827]">
                          {cp.specs && cp.specs[specKey] !== undefined
                            ? String(cp.specs[specKey])
                            : 'Not available'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
