import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProductImage } from '../components/ProductImage';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise } from '../kit';

interface WishlistItem {
  wishlist_id: string;
  product_id: string;
  name: string;
  brand: string;
  image_url: string | null;
  category_name: string;
  min_price_paise: number | null;
  free_units: number;
}

interface RecentItem {
  product_id: string;
  name: string;
  brand: string;
  image_url: string | null;
  category_name: string;
  min_price_paise: number | null;
}

export function WishlistPage() {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [wishlist, setWishlist] = useState<WishlistItem[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wRes, rRes] = await Promise.all([
        apiFetch<{ items: WishlistItem[] }>('/api/wishlist'),
        apiFetch<{ items: RecentItem[] }>('/api/recently-viewed').catch(() => ({ items: [] })),
      ]);
      setWishlist(wRes.items || []);
      setRecent(rRes.items || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load wishlist.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const removeWishlist = async (productId: string) => {
    try {
      await apiFetch('/api/wishlist/toggle', {
        method: 'POST',
        body: JSON.stringify({ product_id: productId }),
      });
      setWishlist((prev) => prev.filter((item) => item.product_id !== productId));
      addToast('Removed from wishlist.', 'info');
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Could not update wishlist.', 'error');
    }
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="mb-6 font-display text-2xl font-bold text-[#111827] sm:text-3xl">
        Saved Wishlist &amp; Recently Viewed
      </h1>

      {loading && <CardGridSkeleton count={3} />}
      {!loading && error && (
        <ErrorState title="Wishlist unavailable" message={error} onRetry={() => void load()} />
      )}

      {!loading && !error && wishlist.length === 0 && (
        <EmptyState
          title="No saved wishlist items yet"
          description="Save electronics you are watching from any product page."
          actionLabel="Explore Catalog"
          onAction={() => navigate('/products')}
        />
      )}

      {!loading && !error && wishlist.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {wishlist.map((item) => (
            <article
              key={item.wishlist_id}
              className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white p-4"
            >
              <Link to={`/products/${item.product_id}`} className="block rounded-lg bg-slate-50">
                <ProductImage
                  src={item.image_url}
                  alt={item.name}
                  className="aspect-[4/3] w-full rounded-lg object-cover"
                />
              </Link>
              <p className="mt-3 text-xs font-semibold text-[#64748B] uppercase">
                {item.brand} · {item.category_name}
              </p>
              <Link
                to={`/products/${item.product_id}`}
                className="mt-1 block font-display text-base font-semibold text-[#111827] hover:text-[#4F46E5]"
              >
                {item.name}
              </Link>
              <div className="mt-3 flex items-center justify-between">
                <span className="font-mono text-base font-bold text-[#111827] tabular-nums">
                  {item.min_price_paise ? formatPaise(item.min_price_paise) : 'Out of stock'}
                </span>
                <button
                  type="button"
                  onClick={() => void removeWishlist(item.product_id)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#DC2626] hover:underline"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Remove</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && recent.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-4 font-display text-lg font-bold text-[#111827]">
            Recently Viewed (Up to 8)
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {recent.map((r) => (
              <Link
                key={r.product_id}
                to={`/products/${r.product_id}`}
                className="rounded-xl border border-[#E2E8F0] bg-white p-3 hover:border-[#4F46E5]"
              >
                <ProductImage
                  src={r.image_url}
                  alt={r.name}
                  className="aspect-[4/3] w-full rounded-lg object-cover"
                />
                <p className="mt-2 line-clamp-1 text-sm font-semibold text-[#111827]">{r.name}</p>
                <p className="mt-0.5 font-mono text-xs text-[#64748B]">
                  {r.min_price_paise ? formatPaise(r.min_price_paise) : 'Check offers'}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
