const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after any earlier work queued under the same key has finished. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  }).catch(() => undefined);
  return next;
}
