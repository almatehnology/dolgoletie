type MutexRegistry = Map<string, Promise<void>>;
const globalAuth = globalThis as typeof globalThis & { travelAuthMutexes?: MutexRegistry };
const mutexes = globalAuth.travelAuthMutexes ??= new Map();

export async function withMutex<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutexes.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (mutexes.get(key) === current) mutexes.delete(key);
  }
}

/** Serialize local vault/session transitions; encryption operations should use this too. */
export function withAuthOperation<T>(task: () => Promise<T>): Promise<T> {
  return withMutex('vault-session-transition', task);
}
