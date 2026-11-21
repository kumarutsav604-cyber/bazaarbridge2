import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch } from '../kit';

export interface SystemHealth {
  ok: boolean;
  readiness: {
    postgresConfigured: boolean;
    kafkaConfigured: boolean;
    opensearchConfigured: boolean;
    geminiConfigured: boolean;
    allCoreConfigured: boolean;
    missingCore: string[];
  };
  services: {
    postgres: { status: string; error?: string };
    kafka: { status: string };
    opensearch: { status: string; error?: string };
  };
  featureFlags: Record<string, boolean>;
}

interface SystemContextValue {
  health: SystemHealth | null;
  loading: boolean;
  refreshHealth: () => Promise<void>;
  isFeatureEnabled: (flag: string) => boolean;
}

const SystemContext = createContext<SystemContextValue>({
  health: null,
  loading: true,
  refreshHealth: async () => {},
  isFeatureEnabled: () => true,
});

export function SystemProvider({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await apiFetch<SystemHealth>('/api/health');
      setHealth(res);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const isFeatureEnabled = useCallback(
    (flag: string) => {
      if (!health?.featureFlags) return true;
      return Boolean(health.featureFlags[flag]);
    },
    [health]
  );

  return (
    <SystemContext.Provider value={{ health, loading, refreshHealth, isFeatureEnabled }}>
      {children}
    </SystemContext.Provider>
  );
}

export function useSystem() {
  return useContext(SystemContext);
}
