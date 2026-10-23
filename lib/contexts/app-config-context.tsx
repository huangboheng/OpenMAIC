'use client';

import { createContext, useContext, type ReactNode } from 'react';

interface AppConfig {
  readonly homeEnabled: boolean;
}

/**
 * Deployment-level flags that client components need for navigation. The
 * server root layout resolves the real values; rendering outside a provider
 * (isolated unit tests) keeps the historical home-enabled behavior.
 */
const DEFAULT_APP_CONFIG: AppConfig = { homeEnabled: true };

const AppConfigContext = createContext<AppConfig>(DEFAULT_APP_CONFIG);

export function AppConfigProvider({
  homeEnabled,
  children,
}: {
  readonly homeEnabled: boolean;
  readonly children: ReactNode;
}) {
  return <AppConfigContext.Provider value={{ homeEnabled }}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}
