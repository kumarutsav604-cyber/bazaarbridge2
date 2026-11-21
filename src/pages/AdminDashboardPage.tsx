import {
  Activity,
  CheckCircle2,
  Database,
  KeyRound,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  Truck,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { CardGridSkeleton, ErrorState } from '../components/States';
import { useToast } from '../context/ToastContext';
import { apiFetch, formatPaise, usePolling } from '../kit';

interface OverviewStats {
  total_products: number;
  total_dealers: number;
  total_orders: number;
  active_groups: number;
  pending_transfers: number;
  refund_cases: number;
  total_units: number;
  reserved_units: number;
}

interface AdminGroupRow {
  group_id: string;
  order_id: string;
  mode: 'quick' | 'standard' | 'transfer';
  status: string;
  fee_total: number;
  location_name: string | null;
  delivery_pin_code: string;
  customer_email: string;
  transfer_id: string | null;
  transfer_status: string | null;
  cancel_on_receipt: boolean | null;
  created_at: string;
}

interface AdminRefundRow {
  refund_id: string;
  order_id: string;
  order_item_id: string;
  product_name: string;
  kind: string;
  item_amount: number;
  fee_amount: number;
  status: string;
  gateway_ref: string | null;
}

interface AdminHubRow {
  hub_id: string;
  location_id: string;
  location_name: string;
  city: string;
  active: boolean;
  order_capacity: number;
  pin_codes: string[];
}

interface LiveProofData {
  outbox: Array<{
    event_id: string;
    event_type: string;
    aggregate_key: string;
    payload: Record<string, unknown>;
    created_at: string;
    published_at: string | null;
  }>;
  processed_events: Array<{
    event_id: string;
    consumer_name: string;
    processed_at: string;
  }>;
  opensearch_doc: Record<string, unknown> | null;
  pg_revision: number | null;
}

const FULFILMENT_STEPS = [
  'picked',
  'packed',
  'rider_assigned',
  'picked_up',
  'out_for_delivery',
] as const;

const TRANSFER_STEPS = ['in_transit', 'received_checked', 'allocated'] as const;

export function AdminDashboardPage() {
  const { addToast } = useToast();

  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [groups, setGroups] = useState<AdminGroupRow[]>([]);
  const [refunds, setRefunds] = useState<AdminRefundRow[]>([]);
  const [hubs, setHubs] = useState<AdminHubRow[]>([]);
  const [liveProof, setLiveProof] = useState<LiveProofData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    try {
      const [ovRes, grpRes, refRes, hubRes, proofRes] = await Promise.all([
        apiFetch<{ overview: OverviewStats }>('/api/admin/overview'),
        apiFetch<{ groups: AdminGroupRow[] }>('/api/admin/groups'),
        apiFetch<{ refunds: AdminRefundRow[] }>('/api/admin/refunds'),
        apiFetch<{ hubs: AdminHubRow[] }>('/api/admin/hubs'),
        apiFetch<LiveProofData>('/api/admin/live-proof'),
      ]);
      setOverview(ovRes.overview);
      setGroups(grpRes.groups || []);
      setRefunds(refRes.refunds || []);
      setHubs(hubRes.hubs || []);
      setLiveProof(proofRes);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load admin console data.');
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(loadAll, 6000, true);

  const fireEvent = async (groupId: string, eventType: string, otp?: string) => {
    setBusyKey(`${groupId}:${eventType}`);
    try {
      await apiFetch('/api/simulator/fire-event', {
        method: 'POST',
        body: JSON.stringify({ group_id: groupId, event_type: eventType, otp }),
      });
      addToast(`Enqueued simulator event "${eventType}".`, 'success');
      setTimeout(() => void loadAll(), 800);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Event submission failed.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const fetchDemoOtpAndVerify = async (groupId: string, wrong = false) => {
    setBusyKey(`${groupId}:otp`);
    try {
      const res = await apiFetch<{ demo_otp: string }>(`/api/admin/groups/${groupId}/demo-otp`);
      const code = wrong
        ? String((parseInt(res.demo_otp, 10) + 1) % 1000000).padStart(6, '0')
        : res.demo_otp;
      setOtpInputs((prev) => ({ ...prev, [groupId]: code }));
      await fireEvent(groupId, 'otp_verified', code);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'OTP lookup failed.', 'error');
      setBusyKey(null);
    }
  };

  const creditRefund = async (refundId: string) => {
    setBusyKey(`refund:${refundId}`);
    try {
      await apiFetch(`/api/admin/refunds/${refundId}/credit`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      addToast('Enqueued simulated refund credit via Kafka.', 'success');
      setTimeout(() => void loadAll(), 800);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Failed to credit refund.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleHubStatus = async (hub: AdminHubRow) => {
    setBusyKey(`hub:${hub.hub_id}`);
    try {
      const res = await apiFetch<{ offers_notified: number; groups_notified: number }>(
        `/api/admin/hubs/${hub.hub_id}/status`,
        {
          method: 'POST',
          body: JSON.stringify({ active: !hub.active }),
        }
      );
      addToast(
        `Hub ${!hub.active ? 'activated' : 'paused'} (${res.offers_notified} offers & ${res.groups_notified} groups updated via Kafka).`,
        'success'
      );
      await loadAll();
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Failed to toggle hub.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  if (loading && !overview) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <CardGridSkeleton count={4} />
      </main>
    );
  }

  if (error && !overview) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <ErrorState
          title="Admin Console Error"
          message={error}
          onRetry={() => void loadAll()}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wider text-[#4F46E5] uppercase">
            Admin Simulator &amp; Diagnostics
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-[#111827] sm:text-3xl">
            Fulfilment, Hub &amp; Kafka Live-Proof Console
          </h1>
        </div>
        <button
          type="button"
          onClick={() => void loadAll()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#111827] hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh Live State</span>
        </button>
      </div>

      {/* Real DB Overview KPIs */}
      {overview && (
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <p className="text-xs text-[#64748B]">Products / Dealers</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#111827] tabular-nums">
              {overview.total_products} / {overview.total_dealers}
            </p>
          </div>
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <p className="text-xs text-[#64748B]">Orders / Active Groups</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#111827] tabular-nums">
              {overview.total_orders} / {overview.active_groups}
            </p>
          </div>
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <p className="text-xs text-[#64748B]">Pending Transfers / Refunds</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#111827] tabular-nums">
              {overview.pending_transfers} / {overview.refund_cases}
            </p>
          </div>
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <p className="text-xs text-[#64748B]">Inventory (Total / Reserved)</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#111827] tabular-nums">
              {overview.total_units} / {overview.reserved_units}
            </p>
          </div>
        </section>
      )}

      {/* Fulfilment & Transfer Simulator */}
      <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
        <div className="mb-4 flex items-center gap-2">
          <Truck className="h-5 w-5 text-[#4F46E5]" />
          <h2 className="font-display text-lg font-bold text-[#111827]">
            Fulfilment &amp; Transfer Event Simulator
          </h2>
        </div>
        <p className="mb-5 text-xs text-[#64748B]">
          All simulator clicks insert an outbox event published to Kafka. Delivery OTP verification
          submits HMAC proof only; raw OTPs never enter outbox, Kafka, or logs.
        </p>

        {groups.length === 0 ? (
          <p className="text-sm text-[#64748B]">No fulfilment groups created yet.</p>
        ) : (
          <div className="space-y-4">
            {groups.map((grp) => (
              <div
                key={grp.group_id}
                className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <p className="font-mono text-xs font-bold text-[#111827]">
                      Group #{grp.group_id.slice(0, 8)} · Mode: {grp.mode.toUpperCase()} · Status:{' '}
                      <span className="text-[#4F46E5]">{grp.status}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[#64748B]">
                      Customer: {grp.customer_email} · PIN {grp.delivery_pin_code} ·{' '}
                      {grp.location_name || 'Stock Location'}
                      {grp.transfer_status ? ` · Transfer: ${grp.transfer_status}` : ''}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-[#64748B]">
                    Order #{grp.order_id.slice(0, 8)}
                  </span>
                </div>

                {/* 3 Separate Transfer Step Buttons for transfer mode */}
                {grp.mode === 'transfer' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-amber-900">Transfer Steps:</span>
                    {TRANSFER_STEPS.map((step) => (
                      <button
                        key={step}
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => void fireEvent(grp.group_id, step)}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-100 disabled:opacity-50"
                      >
                        {step}
                      </button>
                    ))}
                  </div>
                )}

                {/* Fulfilment Steps */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[#111827]">Fulfilment:</span>
                  {FULFILMENT_STEPS.map((step) => (
                    <button
                      key={step}
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() => void fireEvent(grp.group_id, step)}
                      className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#111827] hover:border-[#4F46E5] hover:text-[#4F46E5] disabled:opacity-50"
                    >
                      {step}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void fireEvent(grp.group_id, 'exception')}
                    className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-[#DC2626] hover:bg-red-50 disabled:opacity-50"
                  >
                    exception
                  </button>
                </div>

                {/* OTP Verification Controls */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
                  <KeyRound className="h-3.5 w-3.5 text-[#4F46E5]" />
                  <input
                    type="text"
                    maxLength={6}
                    value={otpInputs[grp.group_id] || ''}
                    onChange={(e) =>
                      setOtpInputs((prev) => ({ ...prev, [grp.group_id]: e.target.value }))
                    }
                    placeholder="6-digit OTP"
                    className="h-8 w-28 rounded border border-[#E2E8F0] bg-white px-2 font-mono text-xs"
                  />
                  <button
                    type="button"
                    disabled={busyKey !== null || !(otpInputs[grp.group_id] || '').trim()}
                    onClick={() =>
                      void fireEvent(grp.group_id, 'otp_verified', otpInputs[grp.group_id])
                    }
                    className="rounded-lg bg-[#16A34A] px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Verify Typed OTP
                  </button>
                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void fetchDemoOtpAndVerify(grp.group_id, false)}
                    className="rounded-lg border border-[#4F46E5] bg-white px-3 py-1 text-xs font-semibold text-[#4F46E5] hover:bg-indigo-50 disabled:opacity-50"
                  >
                    Autofill SAMPLE Demo OTP &amp; Deliver
                  </button>
                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void fetchDemoOtpAndVerify(grp.group_id, true)}
                    className="rounded-lg border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-[#DC2626] hover:bg-red-50 disabled:opacity-50"
                  >
                    Test Wrong OTP
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Hubs Control & Refund Credits */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Fulfilment Hubs */}
        <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
          <h2 className="mb-4 font-display text-lg font-bold text-[#111827]">
            Quick Fulfilment Hubs
          </h2>
          <div className="space-y-3">
            {hubs.map((hub) => (
              <div
                key={hub.hub_id}
                className="flex items-center justify-between gap-4 rounded-xl border border-[#E2E8F0] p-4"
              >
                <div>
                  <p className="font-semibold text-[#111827]">{hub.location_name}</p>
                  <p className="mt-0.5 text-xs text-[#64748B]">
                    {hub.city} · PINs: {hub.pin_codes?.filter(Boolean).join(', ') || 'None'} · Cap{' '}
                    {hub.order_capacity}/day
                  </p>
                  <p
                    className={`mt-1 text-xs font-semibold ${
                      hub.active ? 'text-[#16A34A]' : 'text-[#DC2626]'
                    }`}
                  >
                    {hub.active ? 'Active (Quick Enabled)' : 'Paused (Standard Fallback)'}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={busyKey === `hub:${hub.hub_id}`}
                  onClick={() => void toggleHubStatus(hub)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white ${
                    hub.active
                      ? 'bg-[#DC2626] hover:bg-red-700'
                      : 'bg-[#16A34A] hover:bg-emerald-700'
                  }`}
                >
                  {hub.active ? (
                    <>
                      <PauseCircle className="h-4 w-4" />
                      <span>Pause Hub</span>
                    </>
                  ) : (
                    <>
                      <PlayCircle className="h-4 w-4" />
                      <span>Resume Hub</span>
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Refunds Queue */}
        <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-[#111827]">
              Refunds Queue (SIMULATED GATEWAY)
            </h2>
          </div>
          {refunds.length === 0 ? (
            <p className="text-sm text-[#64748B]">No refund cases recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {refunds.map((ref) => (
                <div
                  key={ref.refund_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E2E8F0] p-3.5"
                >
                  <div>
                    <p className="text-sm font-semibold text-[#111827]">{ref.product_name}</p>
                    <p className="text-xs text-[#64748B]">
                      {formatPaise(Number(ref.item_amount) + Number(ref.fee_amount))} ·{' '}
                      <span className="font-mono">{ref.status}</span>
                      {ref.gateway_ref ? ` · ${ref.gateway_ref}` : ''}
                    </p>
                  </div>
                  {ref.status === 'credited' ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#16A34A]">
                      <CheckCircle2 className="h-4 w-4" />
                      Credited
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busyKey === `refund:${ref.refund_id}`}
                      onClick={() => void creditRefund(ref.refund_id)}
                      className="rounded-lg bg-[#4F46E5] px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      Credit Refund (Simulated)
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Live Proof Panel (Outbox, processed_events, OpenSearch revision vs PG revision) */}
      {liveProof && (
        <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-[#4F46E5]" />
              <h2 className="font-display text-lg font-bold text-[#111827]">
                Kafka Outbox, Idempotency &amp; OpenSearch Live-Proof Panel
              </h2>
            </div>
            <div className="flex items-center gap-3 font-mono text-xs text-[#64748B]">
              <Database className="h-4 w-4 text-[#4F46E5]" />
              <span>PG revision: {liveProof.pg_revision ?? 'N/A'}</span>
              <span>·</span>
              <span>
                OS revision:{' '}
                {liveProof.opensearch_doc &&
                typeof liveProof.opensearch_doc.source === 'object' &&
                liveProof.opensearch_doc.source !== null &&
                'revision' in liveProof.opensearch_doc.source
                  ? String((liveProof.opensearch_doc.source as Record<string, unknown>).revision)
                  : liveProof.opensearch_doc && 'revision' in liveProof.opensearch_doc
                    ? String(liveProof.opensearch_doc.revision)
                    : 'N/A'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-[#64748B] uppercase">
                Recent Outbox Events (OTP codes never stored)
              </h3>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {liveProof.outbox.slice(0, 12).map((evt) => (
                  <div
                    key={evt.event_id}
                    className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-2.5 text-xs"
                  >
                    <div className="flex justify-between font-mono font-semibold text-[#111827]">
                      <span>{evt.event_type}</span>
                      <span className={evt.published_at ? 'text-[#16A34A]' : 'text-amber-700'}>
                        {evt.published_at ? 'Published' : 'Pending'}
                      </span>
                    </div>
                    <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-[#64748B]">
                      {JSON.stringify(evt.payload)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold text-[#64748B] uppercase">
                Processed Consumer Events &amp; OpenSearch Sample Doc
              </h3>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-2.5">
                {liveProof.processed_events.length === 0 ? (
                  <p className="text-xs text-[#64748B]">No consumer events processed yet.</p>
                ) : (
                  liveProof.processed_events.slice(0, 12).map((pe) => (
                    <div
                      key={`${pe.event_id}-${pe.consumer_name}`}
                      className="flex justify-between font-mono text-[11px]"
                    >
                      <span className="font-semibold text-[#111827]">{pe.consumer_name}</span>
                      <span className="text-[#64748B]">{pe.event_id.slice(0, 8)}</span>
                    </div>
                  ))
                )}
              </div>

              {liveProof.opensearch_doc && (
                <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-slate-50 p-3">
                  <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[#111827]">
                    <ShieldAlert className="h-3.5 w-3.5 text-[#4F46E5]" />
                    <span>OpenSearch Indexed Offer Document</span>
                  </p>
                  <pre className="max-h-28 overflow-auto font-mono text-[11px] text-[#64748B]">
                    {JSON.stringify(liveProof.opensearch_doc, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
