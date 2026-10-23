'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAppConfig } from '@/lib/contexts/app-config-context';

/**
 * Navigate to the app home when this deployment serves it; otherwise leave the
 * basePath and land on the host site root (Philochora's main site).
 */
export function useHomeNavigation(): () => void {
  const router = useRouter();
  const { homeEnabled } = useAppConfig();

  return useCallback(() => {
    if (homeEnabled) {
      router.push('/');
      return;
    }
    window.location.assign('/');
  }, [homeEnabled, router]);
}
