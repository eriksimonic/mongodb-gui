// Runs `action` over every item with at most `limit` calls in flight. Results keep the order of
// the input.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await action(items[index] as T);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
