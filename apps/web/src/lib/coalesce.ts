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
