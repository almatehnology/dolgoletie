export type AuthRole = 'user' | 'admin';

export interface AdminAccount {
  id: string;
  username: 'admin';
  passwordHash: string;
}

/** Shared with the database during sync. The admin account stays on this installation. */
export interface PrimaryAccount {
  id: string;
  username: string;
  passwordHash: string;
  version: number;
}

export interface AuthMetadata {
  version: 1;
  admin?: AdminAccount;
  primary?: PrimaryAccount;
}

export interface SessionData {
  authenticated?: boolean;
  userId?: string;
  role?: AuthRole;
  // A primary user's access version, or a local admin credential fingerprint.
  authVersion?: number | string;
}

export interface VaultHooks {
  vaultUnlock(password: string): Promise<void>;
  vaultLock(): Promise<void>;
  vaultIsUnlocked(): boolean;
  vaultEncryptionEnabled(): boolean;
}
