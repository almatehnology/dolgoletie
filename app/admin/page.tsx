import { readAuth } from '@/lib/auth/store';
import { requireAdmin } from '@/lib/auth/guards';
import { redirect } from 'next/navigation';
import { vaultEncryptionEnabled } from '@/lib/storage/vault';
import { AdminPanel } from './admin-panel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  try { await requireAdmin(); }
  catch (error) {
    if (error instanceof Response && (error.status === 401 || error.status === 403)) redirect('/login?role=admin');
    throw error;
  }
  const { primary } = await readAuth();
  return <AdminPanel initialStatus={{ primary: primary ? { username: primary.username, version: primary.version } : null, encryptionEnabled: vaultEncryptionEnabled() }} />;
}
