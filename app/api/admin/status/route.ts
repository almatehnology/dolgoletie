import { requireAdmin } from '@/lib/auth/guards';
import { readAuth } from '@/lib/auth/store';
import { authFailure, authJson } from '@/lib/auth/errors';
import { vaultEncryptionEnabled } from '@/lib/storage/vault';
import { readSessionSettings } from '@/lib/auth/security-settings';

export async function GET() {
  try {
    await requireAdmin();
    const { primary } = await readAuth();
    return authJson({ primary: primary ? { id: primary.id, username: primary.username, version: primary.version } : null, encryptionEnabled: vaultEncryptionEnabled(), sessionSettings: readSessionSettings() });
  } catch (error) { return authFailure(error); }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
