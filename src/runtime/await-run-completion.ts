/**
 * Block until an agent/chat run reaches a terminal state, for the
 * synchronous "run-to-completion" convenience (`GET /api/runs/[id]?wait=1`).
 *
 * Removes the SSE↔runId correlation burden from external harnesses: post a
 * message, then await this. Subscribes to the run-lifecycle bus events AND
 * checks the run's current state first, so a run that already finished
 * before the caller waits resolves immediately (no missed-event race).
 */
import type { EventBus } from "./events";
import type { AgentEvents, AgentRun, AgentStatus } from "../types";

export type RunOutcome = "complete" | "error" | "cancel";

const TERMINAL_STATUS: Partial<Record<AgentStatus, RunOutcome>> = {
  success: "complete",
  error: "error",
  cancelled: "cancel",
};

export type RunCompletion =
  | { kind: "done"; run: AgentRun; outcome: RunOutcome; error?: string }
  | { kind: "timeout" }
  | { kind: "notfound" }
  | { kind: "aborted" };

/** AgentResult.error is `string | { code, message }`; normalise to text. */
function asErrorString(e: string | { code: string; message: string } | undefined): string | undefined {
  if (e == null) return undefined;
  return typeof e === "string" ? e : e.message;
}

export interface AwaitRunCompletionOpts {
  bus: EventBus<AgentEvents>;
  /** Resolve the current run row (terminal-state short-circuit). */
  getRun: (id: string) => AgentRun | undefined | Promise<AgentRun | undefined>;
  runId: string;
  timeoutMs: number;
  /**
   * Caller-disconnect signal (e.g. the SvelteKit `request.signal`). When it
   * aborts — or is already aborted on entry — the wait resolves `aborted`
   * immediately and runs the SAME teardown as timeout/done (unsubscribe bus
   * listeners + clear the timer), so a dropped client never pins listeners or
   * an `activeWaits` slot for the full timeout. Optional: omit it and the
   * wait behaves exactly as before.
   */
  signal?: AbortSignal;
}

export function awaitRunCompletion(opts: AwaitRunCompletionOpts): Promise<RunCompletion> {
  const { bus, getRun, runId, timeoutMs, signal } = opts;

  return new Promise<RunCompletion>((resolve) => {
    let settled = false;
    const unsubs: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const finish = (val: RunCompletion): void => {
      if (settled) return;
      settled = true;
      for (const u of unsubs) u();
      if (timer) clearTimeout(timer);
      // Detach the abort listener so it's cleaned up alongside the bus subs
      // (it would otherwise leak on the resolved-normally path).
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve(val);
    };

    // Fail fast: a client that already disconnected before we subscribe gets
    // immediate teardown — no listeners registered, no slot held.
    if (signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    if (signal) {
      onAbort = () => finish({ kind: "aborted" });
      signal.addEventListener("abort", onAbort);
    }

    // Subscribe BEFORE the current-state check so a completion firing in the
    // gap between subscribe and getRun is not missed.
    unsubs.push(
      bus.on("run:complete", (d: AgentEvents["run:complete"]) => {
        if (d.run.id === runId) finish({ kind: "done", run: d.run, outcome: "complete", error: asErrorString(d.run.result?.error) });
      }),
      bus.on("run:error", (d: AgentEvents["run:error"]) => {
        if (d.run.id === runId) finish({ kind: "done", run: d.run, outcome: "error", error: d.error ?? asErrorString(d.run.result?.error) });
      }),
      bus.on("run:cancel", (d: AgentEvents["run:cancel"]) => {
        if (d.run.id === runId) finish({ kind: "done", run: d.run, outcome: "cancel" });
      }),
    );

    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);

    Promise.resolve(getRun(runId))
      .then((run) => {
        if (settled) return;
        if (!run) {
          finish({ kind: "notfound" });
          return;
        }
        const outcome = TERMINAL_STATUS[run.status];
        if (outcome) finish({ kind: "done", run, outcome, error: asErrorString(run.result?.error) });
      })
      .catch(() => {
        // getRun failure is non-fatal: fall back to waiting for the event /
        // timeout rather than resolving incorrectly.
      });
  });
}
