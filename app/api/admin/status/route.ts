import { requireAdmin } from '@/lib/auth/guards';
import { readAuth } from '@/lib/auth/store';
import { authFailure, authJson } from '@/lib/auth/errors';
import { vaultEncryptionEnabled } from '@/lib/storage/vault';

export async function GET() {
  try {
    await requireAdmin();
    const { primary } = await readAuth();
    return authJson({ primary: primary ? { id: primary.id, username: primary.username, version: primary.version } : null, encryptionEnabled: vaultEncryptionEnabled() });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
