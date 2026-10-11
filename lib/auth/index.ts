export { readAuth, updateAuth, authFilePath, AuthStoreError } from './store';
export { hashPassword, verifyPassword } from './password';
export { requireUser, requireAdmin } from './guards';
export { withAuthOperation } from './mutex';
export { accountVersion, authorizeSession, currentAccount, assertVaultUnlocked } from './authorization';
export type { AuthMetadata, AdminAccount, PrimaryAccount, AuthRole, SessionData, VaultHooks } from './types';
