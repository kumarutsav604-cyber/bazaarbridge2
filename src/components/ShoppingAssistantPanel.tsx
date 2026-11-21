import { AlertCircle, Search, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSystem } from '../context/SystemContext';
import { apiFetch, formatPaise } from '../kit';

interface AssistantOffer {
  offer_id: string;
  product_id: string;
  product_name: string;
  shop_name: string;
  dealer_city: string;
  selling_price: number;
  available_units: number;
  quick_available: boolean;
}

const SAMPLE_PROMPTS = [
  'Bluetooth speaker under Rs 800',
  'Quick delivery wireless keyboard in Bangalore',
  'Bluetooth earphones from Mysuru',
];

export function ShoppingAssistantPanel() {
  const { user } = useAuth();
  const { isFeatureEnabled } = useSystem();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    filters: Record<string, unknown>;
    results: AssistantOffer[];
    message: string;
    fallback: boolean;
  } | null>(null);

  if (!isFeatureEnabled('FEATURE_ASSISTANT')) return null;

  const runQuery = async (promptText: string) => {
    if (!promptText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{
        filters: Record<string, unknown>;
        results: AssistantOffer[];
        message: string;
        fallback: boolean;
      }>('/api/shopping-assistant', {
        method: 'POST',
        body: JSON.stringify({ message: promptText.trim() }),
      });
      setResult(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Assistant request failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-medium text-[#111827] shadow-xs transition-colors hover:border-[#4F46E5] hover:text-[#4F46E5]"
      >
        <Sparkles className="h-4 w-4 text-[#4F46E5]" />
        <span>Filter Assistant</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
          <div className="flex h-full w-full max-w-lg flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] px-5 py-4">
              <div>
                <h2 className="font-display text-base font-bold text-[#111827]">
                  Shopping Filter Assistant
                </h2>
                <p className="text-xs text-[#64748B]">
                  Translates your request into validated PostgreSQL + OpenSearch filters.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close filter assistant"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {!user ? (
                <div className="rounded-xl border border-[#E2E8F0] bg-slate-50 p-4 text-sm text-[#64748B]">
                  Please{' '}
                  <Link to="/login" onClick={() => setOpen(false)} className="font-semibold text-[#4F46E5] underline">
                    sign in
                  </Link>{' '}
                  to use the Shopping Filter Assistant.
                </div>
              ) : (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void runQuery(message);
                    }}
                    className="flex gap-2"
                  >
                    <input
                      type="text"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      maxLength={500}
                      placeholder="e.g. Bluetooth speaker under Rs 800"
                      className="flex-1 rounded-lg border border-[#E2E8F0] px-3.5 py-2.5 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={loading || !message.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#4F46E5] px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Search className="h-4 w-4" />
                      <span>Search</span>
                    </button>
                  </form>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {SAMPLE_PROMPTS.map((sample) => (
                      <button
                        key={sample}
                        type="button"
                        onClick={() => {
                          setMessage(sample);
                          void runQuery(sample);
                        }}
                        className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-medium text-[#111827] hover:border-[#4F46E5]"
                      >
                        {sample}
                      </button>
                    ))}
                  </div>

                  {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-[#DC2626]">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  {result && (
                    <div className="mt-5 space-y-4">
                      {result.fallback && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                          Showing normal search results ({result.message})
                        </div>
                      )}

                      <div>
                        <p className="text-xs font-semibold text-[#64748B] uppercase">
                          Extracted Filters
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {Object.entries(result.filters).length === 0 ? (
                            <span className="text-xs text-[#64748B]">Broad search (no strict filters)</span>
                          ) : (
                            Object.entries(result.filters).map(([k, v]) => (
                              <span
                                key={k}
                                className="rounded border border-[#E2E8F0] bg-slate-50 px-2 py-1 font-mono text-xs text-[#111827]"
                              >
                                {k}: {Array.isArray(v) ? v.join(', ') : String(v)}
                              </span>
                            ))
                          )}
                        </div>
                      </div>

                      <div>
                        <p className="mb-2 text-xs font-semibold text-[#64748B] uppercase">
                          Verified Offers ({result.results.length})
                        </p>
                        <div className="space-y-2.5">
                          {result.results.map((offer) => (
                            <Link
                              key={offer.offer_id}
                              to={`/products/${offer.product_id}`}
                              onClick={() => setOpen(false)}
                              className="block rounded-lg border border-[#E2E8F0] p-3 hover:border-[#4F46E5]"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold text-[#111827]">
                                    {offer.product_name}
                                  </p>
                                  <p className="mt-0.5 text-xs text-[#64748B]">
                                    {offer.shop_name} · {offer.dealer_city} · {offer.available_units} units
                                  </p>
                                </div>
                                <span className="font-mono text-sm font-semibold text-[#111827] tabular-nums">
                                  {formatPaise(offer.selling_price)}
                                </span>
                              </div>
                            </Link>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
