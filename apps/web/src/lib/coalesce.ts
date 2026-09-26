/**
 * Runs `fn` at most once per `ms`: the first call schedules it, later calls inside that window join the same run.
 * Unlike a debounce it still fires during an endless stream of calls, so a view keeps updating while it is busy.
 */
export function coalesce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
}

export type RefreshKey = { key: readonly unknown[]; exact?: boolean };

/**
 * Collects query keys to refresh and hands them to `flush` together, deduplicated, at most once per `ms`. A key
 * that is a prefix of another in the same batch covers it, so it is not refreshed twice.
 */
export function refreshQueue(flush: (keys: RefreshKey[]) => void, ms: number) {
  const pending = new Map<string, RefreshKey>();
  const run = coalesce(() => {
    const all = [...pending.values()];
    pending.clear();
    const covers = (a: RefreshKey, b: RefreshKey) =>
      a !== b && !a.exact && a.key.length < b.key.length && a.key.every((part, i) => part === b.key[i]);
    flush(all.filter((k) => !all.some((other) => covers(other, k))));
  }, ms);
  return (key: readonly unknown[], exact = false) => {
    const id = JSON.stringify([key, exact]);
    if (!pending.has(id)) pending.set(id, { key, exact });
    run();
  };
}
