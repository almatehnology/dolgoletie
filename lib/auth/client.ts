'use client';

import { api } from '@/lib/store/api';
import type { AppStore } from '@/lib/store';
import { closeSearchModal, dismissToast, hideScans } from '@/lib/store/ui-slice';
import type { AuthRole } from './types';
import { SESSION_LEAVING_EVENT } from './activity-monitor';

export function clearClientSession(store: AppStore): void {
  try { window.sessionStorage.removeItem('tdb-batch-import'); window.sessionStorage.removeItem('tdb-batch-import-confirmation'); } catch { /* Storage can be unavailable. */ }
  const ui = store.getState().ui;
  store.dispatch(api.util.resetApiState());
  store.dispatch(closeSearchModal());
  for (const id of Object.keys(ui.scansRevealedFor)) store.dispatch(hideScans(id));
  for (const toast of ui.toasts) store.dispatch(dismissToast(toast.id));
}

export function expireClientSession(store: AppStore, role: AuthRole): void {
  clearClientSession(store);
  window.location.replace(role === 'admin' ? '/login?role=admin&expired=1' : '/login?expired=1');
}

// A full document navigation discards all Redux state and Next's prefetched content.
export async function leaveAccount(store: AppStore, destination = '/login'): Promise<void> {
  window.dispatchEvent?.(new Event(SESSION_LEAVING_EVENT));
  try { await fetch('/api/auth/logout', { method: 'POST' }); }
  finally {
    clearClientSession(store);
    window.location.replace(destination);
  }
}

export function safeUserDestination(destination: string | null): string {
  if (!destination?.startsWith('/') || destination.startsWith('//') || /[\\\u0000-\u0020]/.test(destination) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|20)/i.test(destination)) return '/';
  const pathname = destination.split(/[?#]/)[0];
  if (['/admin', '/login', '/setup', '/api'].some((path) => pathname === path || pathname.startsWith(`${path}/`))) return '/';
  return destination;
}

export function safeAdminDestination(syncToken: string | null): string {
  return syncToken && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(syncToken) ? `/admin?syncToken=${encodeURIComponent(syncToken)}` : '/admin';
}
