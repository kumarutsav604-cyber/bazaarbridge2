import { AlertTriangle, Database, RefreshCw, Inbox } from 'lucide-react';
import { useSystem } from '../context/SystemContext';

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white p-4"
        >
          <div className="mb-4 h-44 w-full animate-pulse rounded-lg bg-slate-100" />
          <div className="mb-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
          <div className="mb-3 h-5 w-3/4 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-[#E2E8F0] bg-white px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Inbox className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-[#111827]">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-[#64748B]">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ErrorState({
  title = 'Unable to load data',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-white p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#DC2626]" />
          <div>
            <h3 className="text-sm font-semibold text-[#111827]">{title}</h3>
            <p className="mt-1 text-sm text-[#64748B]">{message}</p>
          </div>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-medium text-[#111827] transition-colors hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export function ServiceReadinessBanner() {
  const { health, loading, refreshHealth } = useSystem();

  if (loading || !health || health.readiness.allCoreConfigured) {
    return null;
  }

  const onlyKafkaMissing =
    health.readiness.postgresConfigured &&
    health.readiness.opensearchConfigured &&
    !health.readiness.kafkaConfigured;

  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2.5 sm:items-center">
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 sm:mt-0" />
          {onlyKafkaMissing ? (
            <p className="leading-snug">
              <span className="font-semibold">Aiven PostgreSQL &amp; OpenSearch Connected</span>{' '}
              · Missing{' '}
              <span className="font-mono text-xs">
                {health.readiness.missingCore.join(', ')}
              </span>
              . Catalog, search, comparison, cart, reservations, and checkout are active; click
              &ldquo;Show&rdquo; on Password in Aiven Kafka Overview and add it to{' '}
              <span className="font-mono text-xs">.env</span> to activate async Kafka outbox
              consumers.
            </p>
          ) : (
            <p className="leading-snug">
              <span className="font-semibold">Aiven Environment Setup Required:</span>{' '}
              Missing variables{' '}
              <span className="font-mono text-xs">
                {health.readiness.missingCore.join(', ')}
              </span>
              . Configure Aiven PostgreSQL, Kafka, and OpenSearch credentials in Secrets / .env, then run{' '}
              <span className="font-mono text-xs">npm run db:migrate && npm run db:seed</span>.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refreshHealth()}
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 sm:self-auto"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Re-check Services
        </button>
      </div>
    </div>
  );
}
