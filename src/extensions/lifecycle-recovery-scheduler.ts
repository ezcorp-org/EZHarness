export interface LifecycleRecoveryClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface LifecycleRecoveryScheduler {
  request(options?: { deadline?: number; followUp?: boolean }): void;
  drain(): Promise<void>;
}

const systemClock: LifecycleRecoveryClock = { now: Date.now, setTimeout, clearTimeout };

/** Coalesces recovery without losing a completion signal while a scan is active. */
export function createLifecycleRecoveryScheduler(recover: () => Promise<number | undefined>, report: (error: unknown) => void, clock: LifecycleRecoveryClock = systemClock): LifecycleRecoveryScheduler {
  let running: Promise<void> | undefined;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Number.POSITIVE_INFINITY;

  const request = ({ deadline, followUp = true }: { deadline?: number; followUp?: boolean } = {}): void => {
    if (deadline !== undefined && deadline > clock.now()) {
      if (deadline >= timerAt) return;
      if (timer) clock.clearTimeout(timer);
      timerAt = deadline;
      timer = clock.setTimeout(() => {
        timer = undefined;
        timerAt = Number.POSITIVE_INFINITY;
        request();
      }, Math.max(1, deadline - clock.now()));
      timer.unref?.();
      return;
    }
    if (running) {
      if (followUp) requested = true;
      return;
    }
    requested = true;
    running = Promise.resolve().then(async () => {
      do {
        requested = false;
        const nextDeadline = await recover();
        if (nextDeadline !== undefined) request({ deadline: nextDeadline });
        else if (timer) {
          clock.clearTimeout(timer);
          timer = undefined;
          timerAt = Number.POSITIVE_INFINITY;
        }
      } while (requested);
    }).catch(error => {
      report(error);
      throw error;
    }).finally(() => {
      running = undefined;
      if (requested) request();
    });
    void running.catch(() => {});
  };

  return { request, async drain() { while (running) await running; } };
}
