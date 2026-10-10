import type { Runner } from "@ezcorp/extension-contract";

/** C02: a cancelled sandbox gets ten seconds of cleanup before it is killed. */
export const FACTORY_SANDBOX_ABORT_GRACE_MS = 10_000;
export const FACTORY_SANDBOX_POLL_INTERVAL_MS = 250;

/**
 * C02.14: after cancellation the supervisor aborts, allows ten seconds of
 * cleanup, then kills the whole sandbox process group and confirms no process
 * remains. The three phases are separated here so each one is observable.
 */
export interface FactorySandboxControl {
  /**
   * Signal the sandbox to stop and clean up, without waiting for it. Returns
   * whether a cleanup signal was really delivered: a runtime that cannot
   * signal gets no cleanup window rather than a silent one.
   */
  abort(workerId: string): Promise<boolean>;
  /** Terminate the whole sandbox process group unconditionally. */
  terminate(workerId: string): Promise<void>;
  /** A physical observation: does any process of this sandbox still run? */
  present(workerId: string): Promise<boolean>;
}

export type FactorySandboxStopDisposition = "cleaned" | "terminated";

export interface FactorySandboxStopOutcome {
  readonly disposition: FactorySandboxStopDisposition;
  /** Cleanup observations made before the kill. Zero when nothing could be signalled. */
  readonly cleanupPolls: number;
  /** True only after the runtime confirmed no process of this sandbox remains. */
  readonly processGroupAbsent: boolean;
}

export interface FactorySandboxStopOptions {
  /** The contract's cleanup budget. Exhausting it kills the sandbox. */
  readonly graceMs: number;
  /** How often cleanup is observed inside the budget. */
  readonly pollIntervalMs: number;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export class FactorySandboxStopError extends Error {
  constructor(readonly code: "sandbox_stop_invalid" | "sandbox_stop_unconfirmed") { super(code); this.name = "FactorySandboxStopError"; }
}

function positiveMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new FactorySandboxStopError("sandbox_stop_invalid");
  return value;
}

/**
 * Aborts, allows at most `graceMs` of cleanup, then kills and confirms absence.
 *
 * The grace is a budget spent by observations under the injected clock, never a
 * fixed sleep: a guest that exits on the first observation is never made to
 * wait, and a guest that ignores the signal is killed as soon as the budget is
 * gone. The poll cap bounds the loop even when the clock does not advance.
 */
export async function stopFactorySandbox(control: FactorySandboxControl, workerId: string, options: FactorySandboxStopOptions): Promise<FactorySandboxStopOutcome> {
  const graceMs = positiveMs(options.graceMs);
  const pollIntervalMs = positiveMs(options.pollIntervalMs);
  if (!workerId) throw new FactorySandboxStopError("sandbox_stop_invalid");
  const signalled = await control.abort(workerId);
  let cleanupPolls = 0;
  if (signalled) {
    const deadline = options.now() + graceMs;
    const maxPolls = Math.ceil(graceMs / pollIntervalMs);
    for (let poll = 0; ; poll += 1) {
      cleanupPolls += 1;
      if (!await control.present(workerId)) return Object.freeze({ disposition: "cleaned" as const, cleanupPolls, processGroupAbsent: true });
      const remaining = deadline - options.now();
      if (remaining <= 0 || poll >= maxPolls) break;
      await options.wait(Math.min(pollIntervalMs, remaining));
    }
  }
  await control.terminate(workerId);
  // `processGroupAbsent` is a fact, not an intention: it is written only after
  // the runtime says the sandbox is gone.
  if (await control.present(workerId)) throw new FactorySandboxStopError("sandbox_stop_unconfirmed");
  return Object.freeze({ disposition: "terminated" as const, cleanupPolls, processGroupAbsent: true });
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * The shared v4 runner as a sandbox control. `abort` is the runner's optional
 * cleanup signal; a runner without one makes no call at all and goes straight
 * to the kill phase, which is the pre-C02.14 sequence rather than a silent
 * success or an extra observation.
 */
export function factoryRunnerSandboxControl(runner: Runner): FactorySandboxControl {
  return Object.freeze({
    async abort(workerId: string) { if (!runner.abort) return false; await runner.abort(workerId); return true; },
    async terminate(workerId: string) { await runner.cancel(workerId); },
    // Absence is a terminal runtime observation. `unknown` is not absence: an
    // inspect that cannot find the worker proves nothing about its processes.
    async present(workerId: string) { return !TERMINAL_STATES.has((await runner.inspect(workerId)).state); },
  });
}
