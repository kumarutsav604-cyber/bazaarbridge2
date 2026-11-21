import { Link } from 'react-router-dom';
import { formatPaise } from '../kit';
import { ProductImage } from './ProductImage';

export interface ProductSummary {
  product_id: string;
  name: string;
  brand?: string | null;
  category_name: string;
  image_url?: string | null;
  dealer_count: number;
  min_price_paise: number | null;
  top_dealer_rating?: number | null;
  total_free_units?: number;
  quick_available?: boolean;
}

export function ProductCard({ product }: { product: ProductSummary }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-[#E2E8F0] bg-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <Link to={`/products/${product.product_id}`} className="block bg-slate-50">
        <ProductImage
          src={product.image_url}
          alt={product.name}
          className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
        />
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <p className="text-[11px] font-semibold tracking-wider text-[#64748B] uppercase">
          {product.brand || 'BazaarBridge'} · {product.category_name}
        </p>

        <Link
          to={`/products/${product.product_id}`}
          className="mt-1.5 line-clamp-2 font-display text-base font-semibold leading-snug text-[#111827] hover:text-[#4F46E5]"
        >
          {product.name}
        </Link>

        <div className="mt-3 flex items-baseline justify-between gap-2">
          <span className="font-mono text-base font-semibold text-[#111827] tabular-nums">
            {product.min_price_paise !== null ? formatPaise(product.min_price_paise) : 'Unavailable'}
          </span>
          {product.quick_available && (
            <span className="text-xs font-medium text-[#16A34A]">Quick Hub Eligible</span>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2 text-xs text-[#64748B] tabular-nums">
          <span>{product.dealer_count} dealer{product.dealer_count === 1 ? '' : 's'}</span>
          {typeof product.total_free_units === 'number' && (
            <>
              <span aria-hidden="true">·</span>
              <span>{product.total_free_units} units ready</span>
            </>
          )}
          {product.top_dealer_rating ? (
            <>
              <span aria-hidden="true">·</span>
              <span>★ {Number(product.top_dealer_rating).toFixed(1)}</span>
            </>
          ) : null}
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100">
          <Link
            to={`/products/${product.product_id}`}
            className="inline-flex w-full items-center justify-center rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#111827] transition-colors hover:border-[#4F46E5] hover:text-[#4F46E5]"
          >
            Compare Dealer Offers
          </Link>
        </div>
      </div>
    </article>
  );
}
