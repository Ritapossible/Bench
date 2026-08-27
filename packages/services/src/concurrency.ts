/**
 * Bounded-concurrency map. Both Phase 1 services fan out over third-party
 * hosts — the indexer resolving agent cards, the prober hitting endpoints —
 * and unbounded `Promise.all` over a few thousand agents would open a few
 * thousand sockets, exhaust the file-descriptor limit, and make Bench look
 * like a denial-of-service attempt from the far end.
 *
 * Results come back in input order, and a rejected task rejects the whole
 * call, so callers that must not lose the batch pass a task that catches.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/** Outcome-preserving variant: one failure never discards the batch. */
export type Settled<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: unknown };

export async function mapLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  return mapLimit(items, limit, async (item, i) => {
    try {
      return { ok: true as const, value: await fn(item, i) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
}
