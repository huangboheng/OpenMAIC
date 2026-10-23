'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAppConfig } from '@/lib/contexts/app-config-context';

interface HomeLinkProps {
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * Home CTA that stays inside the app when the home page is enabled, and
 * intentionally leaves the basePath for the host site when it is disabled.
 */
export function HomeLink({ className, children }: HomeLinkProps) {
  const { homeEnabled } = useAppConfig();

  if (homeEnabled) {
    return (
      <Link href="/" className={className}>
        {children}
      </Link>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional host-root exit when the app home is disabled
    <a href="/" className={className}>
      {children}
    </a>
  );
}
