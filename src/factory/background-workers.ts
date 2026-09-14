/**
 * One bounded, stop-aware worker shape for every factory background role.
 *
 * The plan's W09 bullet names eight roles: compute polling, attempts,
 * command/inbox delivery, child settlement, projections, release outcomes,
 * reconciliation, and notifications. They differ only in the durable step they
 * take, so they share one loop here rather than eight copies of it. The step
 * itself always comes from an existing durable primitive — the outbox, the
 * attempt queue, the projector, the release notification queue — so this file
 * adds scheduling, never a second queue (C13).
 *
 * The loop is the shape already proven in
 * `packages/@ezcorp/factory-orchestrator/src/process.ts` `runDispatcher`: check
 * the signal, take one bounded step, and wait only when the step reports that
 * there is nothing to do. What that file does per process, this does per role
 * inside one process, and it adds the three things a hosted worker needs and
 * the process loop does not: an owned `AbortController` derived from the
 * shutdown signal, a batch bound so one role cannot starve the others, and a
 * `stop()` that awaits the in-flight step instead of abandoning it.
 *
 * **Why this is not `createLifecycleRecoveryScheduler`.** C13 names
 * `src/extensions/lifecycle-recovery-scheduler.ts` as the shared scheduling
 * module, and this file deliberately does not extend it. That scheduler is
 * edge-triggered and coalescing: a caller says "there may be work" and it
 * collapses overlapping requests into one pass, arming a timer for the next
 * durable lease deadline. It is the right shape for restart-time re-drive, and
 * it has no stop signal at all — you stop it by not calling `request()`.
 *
 * The roles here are the opposite shape. Nothing signals them: a durable queue
 * has work because another process wrote a row, so a continuous bounded poll is
 * the only way to observe it, and every role must abort mid-flight on shutdown
 * without abandoning a lease. Wrapping the coalescing scheduler to poll itself
 * would give it the one property it was written not to have. Recorded here as a
 * deliberate fork rather than left for a reader to infer, and a role that
 * genuinely is edge-triggered should use the shared scheduler instead.
 */

/** What one bounded step achieved. `worked` means step again immediately. */
export type FactoryWorkerProgress = "worked" | "idle";

export type FactoryWorkerStep = (signal: AbortSignal) => Promise<FactoryWorkerProgress>;

export interface FactoryBackgroundWorkerDefinition {
  /** Stable identity. Used in readiness, evidence, and the stop order. */
  readonly name: string;
  /** One bounded unit of durable work. It must return, never loop. */
  readonly step: FactoryWorkerStep;
  /** Consecutive `worked` steps before the worker yields to its peers. */
  readonly batch?: number;
  /** Abort-aware pause after an idle step. */
  readonly idleDelayMs?: number;
  /** Abort-aware pause after a failed step, doubled per consecutive failure. */
  readonly errorDelayMs?: number;
  /** Cap for the doubled failure pause. */
  readonly maxErrorDelayMs?: number;
  /**
   * Where a failed step is reported. A background role has no caller to throw
   * to, so an unreported failure is an invisible one. Mirrors the `report`
   * parameter of `createLifecycleRecoveryScheduler`.
   */
  readonly report: (error: unknown) => void;
}

export interface FactoryBackgroundWorkerState {
  readonly name: string;
  readonly running: boolean;
  readonly stopping: boolean;
  /** Steps that returned `worked`. */
  readonly worked: number;
  /** Steps that returned `idle`. */
  readonly idle: number;
  /** Steps that threw. */
  readonly failures: number;
  /** Consecutive failures since the last successful step. */
  readonly consecutiveFailures: number;
  /** Passes that stopped because the batch bound was reached. */
  readonly saturated: number;
}

export interface FactoryWorkerClock {
  /** Resolves on elapse or on abort. It never rejects: an aborted worker exits cleanly. */
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const DEFAULT_BATCH = 32;
const DEFAULT_IDLE_DELAY_MS = 250;
const DEFAULT_ERROR_DELAY_MS = 1_000;
const DEFAULT_MAX_ERROR_DELAY_MS = 60_000;

export class FactoryBackgroundWorkerError extends Error {
  constructor(readonly code: "factory_worker_invalid" | "factory_worker_duplicate" | "factory_worker_unknown", message: string) {
    super(message);
    this.name = "FactoryBackgroundWorkerError";
  }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new FactoryBackgroundWorkerError("factory_worker_invalid", `${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return resolved;
}

/**
 * A pause that ends on elapse or on abort, and resolves either way.
 *
 * Rejecting on abort would make every loop body need a try/catch to tell a
 * shutdown apart from a real failure, and one missed catch would report a
 * clean shutdown as a worker fault.
 */
export const factoryWorkerClock: FactoryWorkerClock = {
  wait(milliseconds, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  },
};

/**
 * One durable role, running until its own controller aborts.
 *
 * The controller is the worker's, not the caller's. Shutdown aborts it, which
 * is what lets a step that already holds a lease decide for itself whether it
 * can finish or must degrade to an uncertain outcome. Freezing the whole loop
 * on a shared signal would instead abandon the lease.
 */
export class FactoryBackgroundWorker {
  private readonly name_: string;
  private readonly step: FactoryWorkerStep;
  private readonly batch: number;
  private readonly idleDelayMs: number;
  private readonly errorDelayMs: number;
  private readonly maxErrorDelayMs: number;
  private readonly report: (error: unknown) => void;
  private readonly clock: FactoryWorkerClock;

  private controller: AbortController | undefined;
  private detach: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private worked = 0;
  private idle = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private saturated = 0;

  constructor(definition: FactoryBackgroundWorkerDefinition, clock: FactoryWorkerClock = factoryWorkerClock) {
    if (typeof definition.name !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(definition.name)) {
      throw new FactoryBackgroundWorkerError("factory_worker_invalid", "a worker name must be a lowercase dashed identifier");
    }
    if (typeof definition.step !== "function" || typeof definition.report !== "function") {
      throw new FactoryBackgroundWorkerError("factory_worker_invalid", `worker '${definition.name}' needs both a step and a report function`);
    }
    this.name_ = definition.name;
    this.step = definition.step;
    this.report = definition.report;
    this.clock = clock;
    this.batch = bounded(definition.batch, DEFAULT_BATCH, 1, 1_024, `worker '${definition.name}' batch`);
    this.idleDelayMs = bounded(definition.idleDelayMs, DEFAULT_IDLE_DELAY_MS, 10, 60_000, `worker '${definition.name}' idleDelayMs`);
    this.errorDelayMs = bounded(definition.errorDelayMs, DEFAULT_ERROR_DELAY_MS, 10, 60_000, `worker '${definition.name}' errorDelayMs`);
    this.maxErrorDelayMs = bounded(definition.maxErrorDelayMs, DEFAULT_MAX_ERROR_DELAY_MS, this.errorDelayMs, 600_000, `worker '${definition.name}' maxErrorDelayMs`);
  }

  get name(): string {
    return this.name_;
  }

  get state(): FactoryBackgroundWorkerState {
    return Object.freeze({
      name: this.name_,
      running: this.loop !== undefined,
      stopping: this.controller?.signal.aborted === true,
      worked: this.worked,
      idle: this.idle,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      saturated: this.saturated,
    });
  }

  /** The worker's own stop signal. Present only while it is running. */
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /**
   * Start the loop. Idempotent, and a no-op once the parent has already
   * aborted: a worker started during shutdown would take a lease nobody is
   * left to settle.
   */
  start(parent?: AbortSignal): void {
    if (this.loop) return;
    if (parent?.aborted) return;
    const controller = new AbortController();
    const stop = () => controller.abort(parent?.reason ?? new Error(`factory worker '${this.name_}' stopped`));
    parent?.addEventListener("abort", stop, { once: true });
    this.detach = parent ? () => parent.removeEventListener("abort", stop) : undefined;
    this.controller = controller;
    this.loop = this.run(controller.signal);
  }

  /**
   * One bounded pass, returned so a test drives the worker without a timer and
   * without a wall-clock assertion.
   *
   * Returns `idle` when the pass ended because there was no work, and `worked`
   * when it ended because the batch bound was reached — the caller then knows
   * there is more work waiting and that this worker yielded deliberately.
   */
  async runBatch(signal: AbortSignal): Promise<FactoryWorkerProgress> {
    for (let taken = 0; taken < this.batch; taken++) {
      if (signal.aborted) return "idle";
      const progress = await this.step(signal);
      if (progress === "idle") {
        this.idle++;
        return "idle";
      }
      this.worked++;
    }
    this.saturated++;
    return "worked";
  }

  /** Abort this worker and await the step already in flight. */
  async stop(): Promise<void> {
    this.controller?.abort(new Error(`factory worker '${this.name_}' stopped`));
    this.detach?.();
    this.detach = undefined;
    const loop = this.loop;
    this.loop = undefined;
    if (loop) await loop;
    this.controller = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let progress: FactoryWorkerProgress;
      try {
        progress = await this.runBatch(signal);
        this.consecutiveFailures = 0;
      } catch (error) {
        this.failures++;
        this.consecutiveFailures++;
        this.report(error);
        // Back off so a dependency that is down is retried, not hammered, and
        // so a permanently failing role cannot spin a core. The cap keeps the
        // role alive: it must still recover on its own once the dependency is.
        const delay = Math.min(this.maxErrorDelayMs, this.errorDelayMs * 2 ** Math.min(this.consecutiveFailures - 1, 20));
        await this.clock.wait(delay, signal);
        continue;
      }
      if (progress === "idle") await this.clock.wait(this.idleDelayMs, signal);
    }
  }
}

/**
 * The registered set for one composed application.
 *
 * Start order is registration order and stop order is its reverse, the same
 * LIFO rule `web/src/lib/server/shutdown.ts` applies to teardowns, so a worker
 * that produces work for a later one is always stopped after its consumer.
 */
export class FactoryBackgroundWorkers {
  private readonly workers: FactoryBackgroundWorker[] = [];
  private readonly byName = new Map<string, FactoryBackgroundWorker>();

  register(definition: FactoryBackgroundWorkerDefinition, clock?: FactoryWorkerClock): FactoryBackgroundWorker {
    if (this.byName.has(definition.name)) {
      throw new FactoryBackgroundWorkerError("factory_worker_duplicate", `worker '${definition.name}' is already registered`);
    }
    const worker = new FactoryBackgroundWorker(definition, clock);
    this.workers.push(worker);
    this.byName.set(worker.name, worker);
    return worker;
  }

  get(name: string): FactoryBackgroundWorker {
    const worker = this.byName.get(name);
    if (!worker) throw new FactoryBackgroundWorkerError("factory_worker_unknown", `worker '${name}' is not registered`);
    return worker;
  }

  names(): readonly string[] {
    return this.workers.map((worker) => worker.name);
  }

  states(): readonly FactoryBackgroundWorkerState[] {
    return this.workers.map((worker) => worker.state);
  }

  start(parent?: AbortSignal): void {
    for (const worker of this.workers) worker.start(parent);
  }

  /**
   * Stop every worker in reverse registration order and await each one.
   *
   * Every worker is stopped even when one throws; the first failure is
   * rethrown afterwards. A single stuck role must not leave the rest running,
   * which is how a shutdown leaks processes.
   */
  async stop(): Promise<void> {
    let first: unknown;
    for (let index = this.workers.length - 1; index >= 0; index--) {
      try {
        await this.workers[index]!.stop();
      } catch (error) {
        first ??= error;
      }
    }
    if (first !== undefined) throw first;
  }
}
