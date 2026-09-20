export type ControlledOutcome<T> =
  | { type: "done"; value: T }
  | { type: "timeout" }
  | { type: "aborted" };

/** Race an operation against cancellation and a deadline without retaining either handle. */
export async function raceControlled<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ControlledOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const competitors: Array<Promise<ControlledOutcome<T>>> = [
      operation.then((value) => ({ type: "done" as const, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
      }),
    ];
    if (signal) {
      competitors.push(new Promise((resolve) => {
        abort = () => resolve({ type: "aborted" });
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }));
    }
    return await Promise.race(competitors);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}
