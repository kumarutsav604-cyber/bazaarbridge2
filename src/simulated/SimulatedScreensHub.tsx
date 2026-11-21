import { useState } from 'react';
import { SimulatedWrapper, formatPaise } from '../kit';

type SimTab = 'picker' | 'rider' | 'refunds' | 'reviews' | 'support';

export function SimulatedScreensHub() {
  const [tab, setTab] = useState<SimTab>('picker');

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-[#111827]">
          Sample Operations & Auxiliary Screens
        </h1>
        <p className="mt-1 text-sm text-[#64748B]">
          Seeded Priority B screens clearly marked as SIMULATED / SAMPLE DATA per BazaarBridge scope rules.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-2 border-b border-[#E2E8F0] pb-3">
        {(
          [
            ['picker', 'Picker Dashboard'],
            ['rider', 'Rider Dispatch'],
            ['refunds', 'Refund Tracker'],
            ['reviews', 'Reviews & Q&A'],
            ['support', 'Support Centre'],
          ] as Array<[SimTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? 'bg-[#4F46E5] text-white'
                : 'border border-[#E2E8F0] bg-white text-[#64748B] hover:text-[#111827]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <SimulatedWrapper featureFlag="FEATURE_SIM_SCREENS" label="SIMULATED / SAMPLE DATA">
        {tab === 'picker' && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-[#111827]">
              Indiranagar Hub Picker Queue (SAMPLE)
            </h2>
            <p className="text-sm text-[#64748B]">
              Sample pick-list preview. Real group transitions are driven via Admin Simulator events.
            </p>
            <div className="overflow-x-auto rounded-lg border border-amber-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs text-[#64748B] uppercase">
                  <tr>
                    <th className="px-4 py-2.5">Bin</th>
                    <th className="px-4 py-2.5">SKU</th>
                    <th className="px-4 py-2.5">Qty</th>
                    <th className="px-4 py-2.5">Stage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr>
                    <td className="px-4 py-2.5 font-mono">A-04</td>
                    <td className="px-4 py-2.5">KeyForge Pro 75 Wireless Mechanical Keyboard</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">1</td>
                    <td className="px-4 py-2.5">Ready for Hub Pick</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'rider' && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-[#111827]">
              Local Rider Dispatch Board (SAMPLE)
            </h2>
            <p className="text-sm text-[#64748B]">
              Sample rider assignment view (live GPS is deliberately out of scope for 24h build).
            </p>
            <div className="rounded-lg border border-amber-200 bg-white p-4 text-sm">
              <p className="font-semibold text-[#111827]">Rider: Karthik M. (Sample Partner)</p>
              <p className="mt-1 text-[#64748B]">Zone: Indiranagar 560038 · Mode: Quick Hub</p>
            </div>
          </div>
        )}

        {tab === 'refunds' && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-[#111827]">
              Sandbox Refund Gateway Ledger (SIMULATED)
            </h2>
            <p className="text-sm text-[#64748B]">
              Real refund ledger rows and atomic caps live in PostgreSQL; gateway money movement is SIMULATED.
            </p>
            <div className="rounded-lg border border-amber-200 bg-white p-4 text-sm">
              <p className="font-mono text-xs text-[#64748B]">SAMPLE ENTRY</p>
              <p className="mt-1 font-semibold text-[#111827]">
                Path A Cancellation Credit: {formatPaise(72800)} · Status: Credited (Simulated UPI)
              </p>
            </div>
          </div>
        )}

        {tab === 'reviews' && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-[#111827]">
              Dealer Reviews & Product Q&A (SAMPLE)
            </h2>
            <div className="rounded-lg border border-amber-200 bg-white p-4 text-sm">
              <p className="font-semibold text-[#111827]">Premier Acoustics — 4.8 / 5 (Sample)</p>
              <p className="mt-1 text-[#64748B]">
                "Sealed retail unit arrived on time from Bangalore Central Warehouse."
              </p>
            </div>
          </div>
        )}

        {tab === 'support' && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-[#111827]">
              Customer Support Centre (SAMPLE)
            </h2>
            <p className="text-sm text-[#64748B]">
              Sample FAQ & grievance escalation preview. Real order cancellations run from Order Tracking.
            </p>
            <div className="rounded-lg border border-amber-200 bg-white p-4 text-sm">
              <p className="font-medium text-[#111827]">
                Need to cancel an order before dispatch? Visit Orders and select Cancel Item.
              </p>
            </div>
          </div>
        )}
      </SimulatedWrapper>
    </div>
  );
}
