import { Filter, Search, ShoppingCart, SlidersHorizontal, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ProductImage } from '../components/ProductImage';
import { ShoppingAssistantPanel } from '../components/ShoppingAssistantPanel';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise } from '../kit';

interface SearchOfferResult {
  offer_id: string;
  product_id: string;
  product_name: string;
  brand: string;
  image_url: string | null;
  category_name: string;
  dealer_id: string;
  shop_name: string;
  dealer_city: string;
  dealer_state: string;
  dealer_rating: number;
  total_reviews: number;
  selling_price: number;
  bangalore_delivery_days: number | null;
  transfer_days_max: number | null;
  eligible_modes: string[];
  available_units: number;
  home_units: number;
  quick_available: boolean;
}

interface FilterOptions {
  categories: Array<{ category_id: string; category_name: string }>;
  cities: string[];
}

export function ProductsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { addToCart } = useCart();
  const { addToast } = useToast();

  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [category, setCategory] = useState(searchParams.get('category') || '');
  const [city, setCity] = useState(searchParams.get('city') || '');
  const [maxPriceRupees, setMaxPriceRupees] = useState(searchParams.get('max_price_rs') || '');
  const [quickOnly, setQuickOnly] = useState(searchParams.get('quick') === 'true');
  const [sortBy, setSortBy] = useState<'relevance' | 'price_asc' | 'rating_desc'>('relevance');

  const [filters, setFilters] = useState<FilterOptions>({ categories: [], cities: [] });
  const [results, setResults] = useState<SearchOfferResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<FilterOptions>('/api/search/filters')
      .then((res) => setFilters(res))
      .catch(() => {});
  }, []);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set('q', query.trim());
      if (category) qs.set('category', category);
      if (city) qs.set('city', city);
      const maxRs = Number(maxPriceRupees);
      if (maxPriceRupees.trim() && Number.isFinite(maxRs) && maxRs > 0) {
        qs.set('max_price', String(Math.round(maxRs * 100)));
      }
      if (quickOnly) qs.set('quick', 'true');

      const res = await apiFetch<{ results: SearchOfferResult[] }>(
        `/api/search?${qs.toString()}`
      );
      setResults(res.results || []);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Search failed. Ensure Aiven OpenSearch and PostgreSQL are configured.'
      );
    } finally {
      setLoading(false);
    }
  }, [query, category, city, maxPriceRupees, quickOnly]);

  useEffect(() => {
    void fetchResults();
  }, [fetchResults]);

  const applyFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (query.trim()) next.set('q', query.trim());
    if (category) next.set('category', category);
    if (city) next.set('city', city);
    if (maxPriceRupees.trim()) next.set('max_price_rs', maxPriceRupees.trim());
    if (quickOnly) next.set('quick', 'true');
    setSearchParams(next);
  };

  const resetFilters = () => {
    setQuery('');
    setCategory('');
    setCity('');
    setMaxPriceRupees('');
    setQuickOnly(false);
    setSearchParams(new URLSearchParams());
  };

  const handleAddToCart = async (offerId: string, productName: string) => {
    if (!user) {
      addToast('Sign in to add items to your cart.', 'info');
      return;
    }
    setAddingId(offerId);
    try {
      await addToCart(offerId, 1);
      addToast(`Added ${productName} to cart.`, 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Unable to add to cart.', 'error');
    } finally {
      setAddingId(null);
    }
  };

  const sortedResults = [...results].sort((a, b) => {
    if (sortBy === 'price_asc') return a.selling_price - b.selling_price;
    if (sortBy === 'rating_desc') return b.dealer_rating - a.dealer_rating;
    return 0;
  });

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#111827] sm:text-3xl">
            Marketplace Catalog &amp; Search
          </h1>
          <p className="mt-1 text-sm text-[#64748B]">
            Typo-tolerant OpenSearch discovery with live PostgreSQL price and stock verification.
          </p>
        </div>
        <ShoppingAssistantPanel />
      </div>

      {/* Filter Toolbar */}
      <form
        onSubmit={applyFilterSubmit}
        className="mb-8 rounded-xl border border-[#E2E8F0] bg-white p-4 sm:p-5"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
          <div className="relative md:col-span-4">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search products, e.g. "bluetoth"'
              aria-label="Search query"
              className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] pr-3 pl-9 text-sm text-[#111827] focus:border-[#4F46E5] focus:bg-white focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Filter by category"
              className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
            >
              <option value="">All Categories</option>
              {filters.categories.map((c) => (
                <option key={c.category_id} value={c.category_name}>
                  {c.category_name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              aria-label="Filter by dealer city"
              className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
            >
              <option value="">All Dealer Cities</option>
              {filters.cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <input
              type="number"
              min={0}
              value={maxPriceRupees}
              onChange={(e) => setMaxPriceRupees(e.target.value)}
              placeholder="Max price (Rs)"
              aria-label="Max price in rupees"
              className="h-10 w-full rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2 md:col-span-2">
            <button
              type="submit"
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#4F46E5] px-4 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Filter className="h-3.5 w-3.5" />
              <span>Apply</span>
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="h-10 rounded-lg border border-[#E2E8F0] px-3 text-xs font-medium text-[#64748B] hover:text-[#111827]"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[#111827]">
            <input
              type="checkbox"
              checked={quickOnly}
              onChange={(e) => setQuickOnly(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-[#4F46E5] focus:ring-[#4F46E5]"
            />
            <Zap className="h-3.5 w-3.5 text-[#16A34A]" />
            <span>Quick Hub Eligible Only</span>
          </label>

          <div className="flex items-center gap-2 text-sm">
            <SlidersHorizontal className="h-3.5 w-3.5 text-[#64748B]" />
            <span className="text-xs text-[#64748B]">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(e.target.value as 'relevance' | 'price_asc' | 'rating_desc')
              }
              aria-label="Sort results"
              className="rounded-md border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#111827]"
            >
              <option value="relevance">Relevance</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="rating_desc">Top Rated Dealer</option>
            </select>
          </div>
        </div>
      </form>

      {/* Results */}
      {loading && <CardGridSkeleton count={6} />}

      {!loading && error && (
        <ErrorState
          title="Search currently unavailable"
          message={error}
          onRetry={() => void fetchResults()}
        />
      )}

      {!loading && !error && sortedResults.length === 0 && (
        <EmptyState
          title="No matching in-stock offers found"
          description="Try broadening your search terms, removing the max price cap, or clearing Quick-only filtering."
          actionLabel="Clear All Filters"
          onAction={resetFilters}
        />
      )}

      {!loading && !error && sortedResults.length > 0 && (
        <>
          <p className="mb-4 text-xs font-medium text-[#64748B]">
            Showing {sortedResults.length} verified offer{sortedResults.length === 1 ? '' : 's'}
          </p>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {sortedResults.map((offer) => (
              <article
                key={offer.offer_id}
                className="flex flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-white transition-all hover:shadow-md"
              >
                <Link to={`/products/${offer.product_id}`} className="block bg-slate-50">
                  <ProductImage
                    src={offer.image_url}
                    alt={offer.product_name}
                    className="aspect-[4/3] w-full object-cover"
                  />
                </Link>

                <div className="flex flex-1 flex-col p-4">
                  <p className="text-[11px] font-semibold tracking-wider text-[#64748B] uppercase">
                    {offer.brand} · {offer.category_name}
                  </p>

                  <Link
                    to={`/products/${offer.product_id}`}
                    className="mt-1.5 line-clamp-2 font-display text-base font-semibold text-[#111827] hover:text-[#4F46E5]"
                  >
                    {offer.product_name}
                  </Link>

                  <p className="mt-1.5 text-xs text-[#64748B]">
                    Dealer: <span className="font-medium text-[#111827]">{offer.shop_name}</span> ·{' '}
                    {offer.dealer_city}
                  </p>

                  <div className="mt-3 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-lg font-bold text-[#111827] tabular-nums">
                      {formatPaise(offer.selling_price)}
                    </span>
                    {offer.quick_available ? (
                      <span className="text-xs font-semibold text-[#16A34A]">Quick Hub</span>
                    ) : offer.home_units > 0 ? (
                      <span className="text-xs font-medium text-[#4F46E5]">
                        BLR Warehouse · {offer.bangalore_delivery_days ?? 2}d
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-[#F59E0B]">
                        Transfer · ~{offer.transfer_days_max ?? 3}d
                      </span>
                    )}
                  </div>

                  <p className="mt-1.5 text-xs text-[#64748B] tabular-nums">
                    {offer.available_units} units ready · ★ {offer.dealer_rating.toFixed(1)} (
                    {offer.total_reviews})
                  </p>

                  <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      disabled={addingId === offer.offer_id}
                      onClick={() => void handleAddToCart(offer.offer_id, offer.product_name)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#4F46E5] px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <ShoppingCart className="h-3.5 w-3.5" />
                      <span>{addingId === offer.offer_id ? 'Adding...' : 'Add to Cart'}</span>
                    </button>
                    <Link
                      to={`/compare?productId=${offer.product_id}`}
                      className="inline-flex items-center justify-center rounded-lg border border-[#E2E8F0] px-3 py-2 text-xs font-semibold text-[#111827] hover:border-[#4F46E5] hover:text-[#4F46E5]"
                    >
                      Compare
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
