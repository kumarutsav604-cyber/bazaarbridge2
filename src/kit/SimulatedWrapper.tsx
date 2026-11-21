import React from 'react';

interface SimulatedWrapperProps {
  featureFlag?: string;
  label?: string;
  children: React.ReactNode;
}

/**
 * Wraps simulated or sample-data modules with an explicit yellow
 * "SIMULATED / SAMPLE DATA" indicator per v7.2 honesty rules.
 */
export function SimulatedWrapper({
  featureFlag,
  label = 'SIMULATED / SAMPLE DATA',
  children,
}: SimulatedWrapperProps) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/60 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 pb-2">
        <span className="inline-flex items-center rounded bg-amber-300 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-amber-950">
          {label}
        </span>
        {featureFlag && (
          <span className="font-mono text-xs text-amber-800">{featureFlag}</span>
        )}
      </div>
      {children}
    </div>
  );
}
