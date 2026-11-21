import {
  ArrowLeft,
  BellPlus,
  Heart,
  MapPin,
  Scale,
  ShieldCheck,
  ShoppingCart,
  TrendingDown,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ProductImage } from '../components/ProductImage';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useSystem } from '../context/SystemContext';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise } from '../kit';

interface ProductDetail {
  product_id: string;
  name: string;
  description: string;
  brand: string;
  specs: Record<string, unknown> | null;
  image_url: string | null;
  category_name: string;
}

interface OfferRow {
  offer_id: string;
  dealer_id: string;
  shop_name: string;
  dealer_city: string;
  dealer_rating: number;
  total_reviews: number;
  verified: boolean;
  selling_price: number;
  bangalore_delivery_days: number | null;
  transfer_days_min: number | null;
  transfer_days_max: number | null;
  warranty_months: number;
  warranty_note: string | null;
  eligible_modes: string[];
  sellable_free_units: number;
  home_units: number;
  preferred_location_name: string | null;
}

interface StockLocationRow {
  offer_id: string;
  location_id: string;
  location_name: string;
  city: string;
  state: string;
  location_type: string;
  is_home: boolean;
  free_units: number;
}

interface PriceHistoryResponse {
  reference_price_paise: number | null;
  current_min_price_paise: number | null;
  show_was_price: boolean;
  data_label: string;
  history: Array<{
    history_id: string;
    shop_name: string;
    selling_price: number;
    valid_from: string;
    valid_to: string | null;
  }>;
}

interface RelatedProduct {
  product_id: string;
  name: string;
  brand: string;
  image_url: string | null;
  category_name: string;
  min_price_paise: number | null;
}

export function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { addToCart } = useCart();
  const { isFeatureEnabled } = useSystem();
  const { addToast } = useToast();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [locations, setLocations] = useState<StockLocationRow[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceHistoryResponse | null>(null);
  const [related, setRelated] = useState<RelatedProduct[]>([]);
  const [wishlisted, setWishlisted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingOfferId, setAddingOfferId] = useState<string | null>(null);

  const loadProduct = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, histRes, relRes] = await Promise.all([
        apiFetch<{
          product: ProductDetail;
          offers: OfferRow[];
          stock_locations: StockLocationRow[];
        }>(`/api/products/${id}`),
        apiFetch<PriceHistoryResponse>(`/api/products/${id}/price-history`).catch(() => null),
        apiFetch<{ related: RelatedProduct[] }>(`/api/products/${id}/related`).catch(() => ({
          related: [],
        })),
      ]);
      setProduct(detailRes.product);
      setOffers(detailRes.offers || []);
      setLocations(detailRes.stock_locations || []);
      setPriceHistory(histRes);
      setRelated(relRes.related || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load product details.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadProduct();
  }, [loadProduct]);

  const handleAdd = async (offerId: string, shopName: string) => {
    if (!user) {
      addToast('Sign in first to add items to your cart.', 'info');
      navigate('/login');
      return;
    }
    setAddingOfferId(offerId);
    try {
      await addToCart(offerId, 1);
      addToast(`Added ${product?.name} (${shopName}) to cart.`, 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Failed to add to cart.', 'error');
    } finally {
      setAddingOfferId(null);
    }
  };

  const handleToggleWishlist = async () => {
    if (!user || !product) {
      addToast('Sign in to save items to your wishlist.', 'info');
      return;
    }
    try {
      const res = await apiFetch<{ wishlisted: boolean }>('/api/wishlist/toggle', {
        method: 'POST',
        body: JSON.stringify({ product_id: product.product_id }),
      });
      setWishlisted(res.wishlisted);
      addToast(res.wishlisted ? 'Saved to wishlist.' : 'Removed from wishlist.', 'success');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Wishlist update failed.', 'error');
    }
  };

  const handleSubscribeAlert = async (type: 'back_in_stock' | 'price_drop', offerId?: string) => {
    if (!user || !product) {
      addToast('Sign in to subscribe to stock or price alerts.', 'info');
      return;
    }
    try {
      await apiFetch('/api/alerts/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          product_id: product.product_id,
          offer_id: offerId,
          type,
        }),
      });
      addToast(
        type === 'price_drop'
          ? 'Subscribed to price drop notifications.'
          : 'Subscribed to back-in-stock notifications.',
        'success'
      );
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Could not create alert.', 'error');
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <CardGridSkeleton count={3} />
      </main>
    );
  }

  if (error || !product) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <ErrorState
          title="Product details unavailable"
          message={error || 'Product not found.'}
          onRetry={() => void loadProduct()}
        />
      </main>
    );
  }

  const lowestOffer = offers.length > 0
    ? [...offers].sort((a, b) => a.selling_price - b.selling_price)[0]
    : null;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        to="/products"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-[#64748B] hover:text-[#111827]"
      >
        <ArrowLeft className="h-4 w-4" />
        <span>Back to catalog</span>
      </Link>

      {/* Top Product Overview */}
      <section className="grid grid-cols-1 gap-8 rounded-2xl border border-[#E2E8F0] bg-white p-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-slate-50">
            <ProductImage
              src={product.image_url}
              alt={product.name}
              className="aspect-[4/3] w-full object-cover"
            />
          </div>
        </div>

        <div className="flex flex-col justify-between lg:col-span-7">
          <div>
            <p className="text-xs font-semibold tracking-wider text-[#64748B] uppercase">
              {product.brand} · {product.category_name}
            </p>
            <h1 className="mt-2 font-display text-2xl font-bold text-[#111827] sm:text-3xl">
              {product.name}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-[#64748B]">{product.description}</p>

            {/* Price & 30-day SAMPLE Reference Price */}
            <div className="mt-5 flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-2xl font-bold text-[#111827] tabular-nums">
                {lowestOffer ? formatPaise(lowestOffer.selling_price) : 'Out of Stock'}
              </span>
              {priceHistory?.show_was_price && priceHistory.reference_price_paise && (
                <span className="text-sm text-[#64748B]">
                  Was{' '}
                  <span className="font-mono line-through tabular-nums">
                    {formatPaise(priceHistory.reference_price_paise)}
                  </span>{' '}
                  <span className="text-xs font-medium text-amber-800">(SAMPLE 30d history)</span>
                </span>
              )}
            </div>

            {/* Action Buttons */}
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                to={`/compare?productId=${product.product_id}`}
                className="inline-flex items-center gap-2 rounded-lg bg-[#4F46E5] px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                <Scale className="h-4 w-4" />
                <span>Compare Dealer Offers ({offers.length})</span>
              </Link>

              {isFeatureEnabled('FEATURE_WISHLIST') && (
                <button
                  type="button"
                  onClick={() => void handleToggleWishlist()}
                  className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium ${
                    wishlisted
                      ? 'border-indigo-300 bg-indigo-50 text-[#4F46E5]'
                      : 'border-[#E2E8F0] bg-white text-[#111827] hover:bg-slate-50'
                  }`}
                >
                  <Heart className={`h-4 w-4 ${wishlisted ? 'fill-[#4F46E5]' : ''}`} />
                  <span>{wishlisted ? 'Wishlisted' : 'Save to Wishlist'}</span>
                </button>
              )}

              {isFeatureEnabled('FEATURE_ALERTS') && (
                <button
                  type="button"
                  onClick={() =>
                    void handleSubscribeAlert(
                      offers.length === 0 ? 'back_in_stock' : 'price_drop',
                      lowestOffer?.offer_id
                    )
                  }
                  className="inline-flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2.5 text-sm font-medium text-[#111827] hover:bg-slate-50"
                >
                  <BellPlus className="h-4 w-4 text-[#4F46E5]" />
                  <span>
                    {offers.length === 0 ? 'Notify Back in Stock' : 'Price Drop Alert'}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Product Specs */}
          {product.specs && Object.keys(product.specs).length > 0 && (
            <div className="mt-6 border-t border-slate-100 pt-5">
              <h2 className="text-xs font-semibold tracking-wider text-[#64748B] uppercase">
                Verified Specifications
              </h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {Object.entries(product.specs).map(([key, val]) => (
                  <div key={key}>
                    <dt className="text-xs text-[#64748B] capitalize">{key.replace(/_/g, ' ')}</dt>
                    <dd className="font-medium text-[#111827]">{String(val)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </section>

      {/* Dealer Offers Table */}
      <section className="mt-8 rounded-2xl border border-[#E2E8F0] bg-white p-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-[#111827]">
              Active Dealer Offers ({offers.length})
            </h2>
            <p className="text-xs text-[#64748B]">
              Every offer reflects real PostgreSQL inventory across hubs, Bangalore warehouse, and
              partner holding locations.
            </p>
          </div>
          <Link
            to={`/compare?productId=${product.product_id}`}
            className="text-sm font-semibold text-[#4F46E5] hover:underline"
          >
            Open 5-Category Ranking →
          </Link>
        </div>

        {offers.length === 0 ? (
          <EmptyState
            title="Currently out of sellable stock"
            description="No active dealer offers have free sellable units right now."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {offers.map((offer) => {
              const offerLocs = locations.filter((l) => l.offer_id === offer.offer_id);
              return (
                <div
                  key={offer.offer_id}
                  className="flex flex-col justify-between gap-4 py-4 sm:flex-row sm:items-center"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[#111827]">{offer.shop_name}</span>
                      {offer.verified && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-[#16A34A]">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Verified Dealer
                        </span>
                      )}
                      <span className="text-xs text-[#64748B]">
                        · {offer.dealer_city} · ★ {offer.dealer_rating.toFixed(1)} (
                        {offer.total_reviews})
                      </span>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-[#64748B]">
                      <span>{offer.sellable_free_units} units sellable</span>
                      <span>·</span>
                      <span>Warranty: {offer.warranty_months} months</span>
                      {offerLocs.map((loc) => (
                        <span key={loc.location_id} className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {loc.location_name} ({loc.free_units})
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="font-mono text-lg font-bold text-[#111827] tabular-nums">
                        {formatPaise(offer.selling_price)}
                      </p>
                      <p className="text-xs text-[#64748B]">
                        {offer.home_units > 0
                          ? `Bangalore delivery ~${offer.bangalore_delivery_days ?? 1}d`
                          : `Transfer from ${offer.dealer_city} ~${offer.transfer_days_max ?? 3}d`}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={addingOfferId === offer.offer_id}
                      onClick={() => void handleAdd(offer.offer_id, offer.shop_name)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#4F46E5] px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <ShoppingCart className="h-3.5 w-3.5" />
                      <span>{addingOfferId === offer.offer_id ? 'Adding...' : 'Add to Cart'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* SAMPLE 30-day Price History */}
      {priceHistory && priceHistory.history.length > 0 && (
        <section className="mt-8 rounded-2xl border border-amber-200 bg-amber-50/40 p-6">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-amber-800" />
              <h2 className="font-display text-base font-bold text-[#111827]">
                30-Day Price History
              </h2>
            </div>
            <span className="rounded bg-amber-200 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-950">
              {priceHistory.data_label} DATA
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-amber-200 text-[#64748B] uppercase">
                <tr>
                  <th className="py-2 pr-4">Dealer</th>
                  <th className="py-2 pr-4">Recorded Price</th>
                  <th className="py-2 pr-4">From</th>
                  <th className="py-2">To</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {priceHistory.history.slice(0, 6).map((h) => (
                  <tr key={h.history_id}>
                    <td className="py-2 pr-4 font-medium text-[#111827]">{h.shop_name}</td>
                    <td className="py-2 pr-4 font-mono tabular-nums">
                      {formatPaise(h.selling_price)}
                    </td>
                    <td className="py-2 pr-4 text-[#64748B]">
                      {new Date(h.valid_from).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-[#64748B]">
                      {h.valid_to ? new Date(h.valid_to).toLocaleDateString() : 'Current'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Related Products */}
      {related.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 font-display text-lg font-bold text-[#111827]">
            Related in {product.category_name}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((rel) => (
              <Link
                key={rel.product_id}
                to={`/products/${rel.product_id}`}
                className="rounded-xl border border-[#E2E8F0] bg-white p-3 transition-shadow hover:shadow-md"
              >
                <ProductImage
                  src={rel.image_url}
                  alt={rel.name}
                  className="aspect-[4/3] w-full rounded-lg object-cover"
                />
                <p className="mt-2.5 text-xs text-[#64748B]">{rel.brand}</p>
                <p className="line-clamp-1 text-sm font-semibold text-[#111827]">{rel.name}</p>
                <p className="mt-1 font-mono text-sm font-semibold text-[#111827] tabular-nums">
                  {rel.min_price_paise ? formatPaise(rel.min_price_paise) : 'Check offers'}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
