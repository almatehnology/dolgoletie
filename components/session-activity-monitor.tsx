'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store/hooks';
import { expireClientSession } from '@/lib/auth/client';
import { monitorSessionActivity } from '@/lib/auth/activity-monitor';
import type { AuthRole } from '@/lib/auth/types';

export function SessionActivityMonitor({ role }: { role: AuthRole }) {
  const store = useAppStore();
  useEffect(() => monitorSessionActivity({ role, onExpired() {
    expireClientSession(store, role);
  } }), [role, store]);
  return null;
}
