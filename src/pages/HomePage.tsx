import { ArrowRight, Clock, MapPin, Search, ShieldCheck, Truck, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProductCard, type ProductSummary } from '../components/ProductCard';
import { ProductImage } from '../components/ProductImage';
import { CardGridSkeleton, EmptyState, ErrorState } from '../components/States';
import { apiFetch } from '../kit';

interface CategoryRow {
  category_id: string;
  category_name: string;
}

export function HomePage() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ products: ProductSummary[]; categories: CategoryRow[] }>(
        '/api/products'
      );
      setProducts(res.products || []);
      setCategories(res.categories || []);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to load storefront catalog from PostgreSQL.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchTerm.trim();
    navigate(q ? `/products?q=${encodeURIComponent(q)}` : '/products');
  };

  return (
    <main>
      {/* Hero Banner */}
      <section className="border-b border-[#E2E8F0] bg-white">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-12 lg:px-8 lg:py-16">
          <div className="lg:col-span-6">
            <p className="text-xs font-semibold tracking-wider text-[#4F46E5] uppercase">
              Multi-Dealer Marketplace · Bangalore &amp; Partner Hubs
            </p>
            <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-[#111827] sm:text-4xl lg:text-5xl">
              Better Deals. Smarter Choices. Delivered Locally.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-[#64748B]">
              Compare verified local dealers across price, delivery speed, and rating. Reserve real
              stock atomically for 10 minutes and check out across Quick Hub, Standard Warehouse, or
              inter-city Transfer routes.
            </p>

            {/* Primary Search Bar */}
            <form onSubmit={handleSearch} className="mt-6 flex max-w-xl gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder='Search electronics — try "bluetoth" for typo tolerance'
                  aria-label="Search marketplace products"
                  className="h-12 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] pr-4 pl-10 text-sm text-[#111827] placeholder:text-slate-400 focus:border-[#4F46E5] focus:bg-white focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="inline-flex h-12 shrink-0 items-center gap-2 rounded-lg bg-[#4F46E5] px-5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
              >
                <span>Search</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-[#64748B]">
              <Link to="/products?q=bluetoth" className="font-medium text-[#4F46E5] hover:underline">
                Try typo search: &ldquo;bluetoth&rdquo;
              </Link>
              <span aria-hidden="true">·</span>
              <Link to="/compare" className="font-medium text-[#111827] hover:text-[#4F46E5]">
                5-Winner Dealer Comparison
              </Link>
              <span aria-hidden="true">·</span>
              <Link
                to="/outside-bangalore"
                className="font-medium text-[#111827] hover:text-[#4F46E5]"
              >
                Outside Bangalore Stock
              </Link>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="overflow-hidden rounded-2xl border border-[#E2E8F0] bg-slate-50 shadow-sm">
              <ProductImage
                src="/src/assets/images/hero_marketplace_showcase_1795284933801.jpg"
                alt="BazaarBridge Multi-Dealer Electronics Showcase"
                className="aspect-[16/9] w-full object-cover"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Hybrid Fulfilment Explainer */}
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5">
            <div className="flex items-center gap-2.5 text-[#16A34A]">
              <Zap className="h-4 w-4" />
              <h2 className="font-display text-sm font-bold text-[#111827]">
                Quick Local Hub (15–35 mins)
              </h2>
            </div>
            <p className="mt-2 text-sm text-[#64748B]">
              Served from active Indiranagar &amp; Koramangala hubs for covered PIN codes like
              560038. Rs.49 flat delivery fee (SAMPLE).
            </p>
          </div>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5">
            <div className="flex items-center gap-2.5 text-[#4F46E5]">
              <Truck className="h-4 w-4" />
              <h2 className="font-display text-sm font-bold text-[#111827]">
                Standard Bangalore Warehouse (1–2 Days)
              </h2>
            </div>
            <p className="mt-2 text-sm text-[#64748B]">
              Ships from Bangalore Central Warehouse across all serviceable PINs. Free at Rs.999+
              per group, else Rs.29 (SAMPLE).
            </p>
          </div>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5">
            <div className="flex items-center gap-2.5 text-[#F59E0B]">
              <MapPin className="h-4 w-4" />
              <h2 className="font-display text-sm font-bold text-[#111827]">
                Inter-City Transfer (~2–3 Days)
              </h2>
            </div>
            <p className="mt-2 text-sm text-[#64748B]">
              Moved from partner holding cities such as Mysuru to Bangalore Central before dispatch.
              Rs.69 combined handling + transfer fee (SAMPLE).
            </p>
          </div>
        </div>
      </section>

      {/* Categories Strip */}
      {categories.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-[#111827]">Browse by Category</h2>
            <Link to="/products" className="text-sm font-medium text-[#4F46E5] hover:underline">
              View all catalog →
            </Link>
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {categories.map((cat) => (
              <Link
                key={cat.category_id}
                to={`/products?category=${encodeURIComponent(cat.category_name)}`}
                className="rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-medium text-[#111827] transition-colors hover:border-[#4F46E5] hover:text-[#4F46E5]"
              >
                {cat.category_name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Featured Catalog */}
      <section className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold text-[#111827]">
              Featured Multi-Dealer Electronics
            </h2>
            <p className="mt-1 text-sm text-[#64748B]">
              Live offers verified against PostgreSQL inventory with 10-minute atomic reservations.
            </p>
          </div>
          <Link
            to="/outside-bangalore"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#4F46E5] hover:underline"
          >
            <span>Explore Outside Bangalore Stock</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {loading && <CardGridSkeleton count={6} />}

        {!loading && error && (
          <ErrorState
            title="Catalog unavailable"
            message={error}
            onRetry={() => void loadCatalog()}
          />
        )}

        {!loading && !error && products.length === 0 && (
          <EmptyState
            title="No products in catalog yet"
            description="Run the PostgreSQL migration and seed script to populate verified products, dealers, and hubs."
            actionLabel="Retry Catalog Check"
            onAction={() => void loadCatalog()}
          />
        )}

        {!loading && !error && products.length > 0 && (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {products.slice(0, 9).map((product) => (
              <ProductCard key={product.product_id} product={product} />
            ))}
          </div>
        )}
      </section>

      {/* Trust & Transparency Footer Strip */}
      <section className="mx-auto max-w-7xl px-4 pt-10 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-6 rounded-2xl border border-[#E2E8F0] bg-white p-6 sm:grid-cols-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#4F46E5]" />
            <div>
              <h3 className="text-sm font-semibold text-[#111827]">PostgreSQL Truth Guarantee</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#64748B]">
                Every OpenSearch hit is rechecked against live PostgreSQL price and free-unit stock
                before display or checkout.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-[#4F46E5]" />
            <div>
              <h3 className="text-sm font-semibold text-[#111827]">10-Minute Atomic Holds</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#64748B]">
                Reserving a unit locks stock with row-level concurrency protection and prevents
                overselling under simultaneous orders.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Truck className="mt-0.5 h-5 w-5 shrink-0 text-[#4F46E5]" />
            <div>
              <h3 className="text-sm font-semibold text-[#111827]">Clear Mixed-Cart Grouping</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#64748B]">
                Quick Hub, Standard Warehouse, and Inter-City Transfer items split into transparent
                fulfilment groups with separate ETAs.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
