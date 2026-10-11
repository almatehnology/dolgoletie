import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from './paths';
import { atomicJson, readProtectedJson, removeDurably } from './atomic-files';
import { authMetadataSchema } from '@/lib/auth/metadata-schema';
import { vaultConfigSchema } from './vault-schema';
import { z } from 'zod';
const transitionSchema = z.object({ format: z.literal(1), auth: authMetadataSchema, vault: vaultConfigSchema }).strict();
function paths() { const dir = dataDirectory(); return { marker: join(dir, 'credential-transition.json'), vault: join(dir, 'vault.json'), auth: process.env.AUTH_FILE ?? join(dir, 'auth.json') }; }
/** The marker contains only password hashes and wrapped keys, never live keys. */
export function commitCredentialFiles(auth: unknown, vault: unknown) {
  const data = transitionSchema.parse({ format: 1, auth, vault }), p = paths();
  atomicJson(p.marker, data);
  atomicJson(p.vault, data.vault); atomicJson(p.auth, data.auth); removeDurably(p.marker);
}
export function recoverCredentialTransition() {
  const p = paths(); if (!existsSync(p.marker)) return;
  const data = transitionSchema.parse(readProtectedJson(p.marker));
  atomicJson(p.vault, data.vault); atomicJson(p.auth, data.auth); removeDurably(p.marker);
}
