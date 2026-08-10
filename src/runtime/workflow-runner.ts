/**
 * WorkflowRunner — the daemon that resumes parked workflow runs.
 *
 * Modelled on `ScheduleDaemon` (`src/extensions/schedule-daemon.ts`), whose
 * locked invariants are stated at its `:4-37`. The shapes that matter are
 * deliberately the same, so anyone who has read one has read both.
 *
 * Locked invariants:
 *
 *   - **Claim by CAS, never `FOR UPDATE SKIP LOCKED`.** PGlite does not
 *     honor that identically, and this must behave the same on both
 *     drivers — the multi-instance / external-Postgres topology is the
 *     entire reason a lease exists. Winning the CAS *is* the
 *     `suspended → running` transition, so there is no window in which two
 *     workers both believe they own a run. The SQL lives in
 *     {@link claimWorkflowRun}; this file owns only the policy.
 *
 *   - **It only ever claims `status='suspended'`.** This is the structural
 *     guard against double-executing a synchronous run: a run driven by an
 *     HTTP request is `running` from insert to terminal, so it is never
 *     claimable. Nothing about the two paths needs to coordinate.
 *
 *   - **Single writer per host.** PID lockfile at
 *     `.ezcorp/workflow-runner.pid`, with PID-reuse handled by the shared
 *     primitive's identity token. Distributed scheduling is out of scope;
 *     the lease is what makes a *second host* safe, not the lockfile.
 *
 *   - **The lease detects a dead process, not a slow step.** 60s, renewed
 *     every 20s by a heartbeat that is per *daemon*, not per run. A
 *     30-minute agent step keeps its claim for as long as this process is
 *     alive. Sizing the lease to step duration would make every long step
 *     look like a crash.
 *
 *   - **Graceful shutdown releases claims** rather than waiting out the
 *     lease, so a rolling restart does not stall every parked run for a
 *     full lease period. Only runs still at a `boundary` are released —
 *     `in-batch` means side effects may be mid-flight, and the recovery
 *     sweep owns that judgement.
 *
 *   - **A claim it could not use is handed back at once**, on the same
 *     terms. A resume that comes back `suspended` — most often a run
 *     parked on an unanswered approval, which `resumeWorkflow` refuses
 *     TRANSIENTLY without writing anything — leaves the row `running`
 *     under this instance's claim, and `answerApproval` refuses a run
 *     that is not `suspended`. Holding it would lock the human out of
 *     the very decision this daemon is waiting on.
 *
 * ## Why resume goes through the runtime registry
 *
 * The live `WorkflowExecutor` and the merged workflow cache are built in
 * the web layer, which `src/` may not import. `workflow/runtime-registry.ts`
 * is the sanctioned seam, and `getWorkflows()` there is a THUNK because the
 * cache array is replaced on every workflow CRUD write. A daemon holding a
 * snapshot would resume against a stale definition list.
 *
 * When nothing is registered (backend-only boot, CLI, pre-web-init) the
 * daemon ticks to a no-op instead of crashing — the same fail-safe posture
 * the registry's other consumers take.
 */
import { logger } from "../logger";
import {
  claimWorkflowRun,
  listClaimableWorkflowRuns,
  releaseWorkflowRunClaims,
  renewWorkflowRunLeases,
  WORKFLOW_LEASE_MS,
  WORKFLOW_LEASE_RENEW_MS,
} from "../db/queries/workflow-runs";
import { getWorkflowRunRow } from "../db/queries/workflow-runs";
import { resumeClaimedRun } from "./workflow-executor";
import { getWorkflowRuntime, type WorkflowRuntime } from "./workflow/runtime-registry";
import { acquireLockfile, releaseLockfile, selfToken } from "../startup/process-lockfile";

const log = logger.child("workflow.runner");

export interface WorkflowRunnerOptions {
  /** Wake interval (ms). Default 5s. Tests pass smaller or drive `tick()`. */
  wakeIntervalMs?: number;
  /** Max concurrent resumes per project. Default 5. */
  maxConcurrentPerProject?: number;
  /** Max concurrent resumes host-wide. Default 20. */
  maxConcurrentHost?: number;
  /** Now-injection for clock-driven tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Lease duration (ms). Default {@link WORKFLOW_LEASE_MS}. */
  leaseMs?: number;
  /**
   * Heartbeat interval (ms). Default {@link WORKFLOW_LEASE_RENEW_MS} — a
   * third of the lease, so two consecutive misses are survivable.
   *
   * Injectable for the same reason `wakeIntervalMs` is: with it fixed at
   * 20s no test could ever drive the renewal callback, and an error path
   * nothing can reach is an error path nobody has checked.
   */
  leaseRenewMs?: number;
  /** Disable the PID lockfile (test-only). */
  skipLockfile?: boolean;
  /** Override the lockfile path for tests. */
  lockfilePath?: string;
  /**
   * Identity written to `claimed_by`. Defaults to `<pid>:<identity token>`
   * — the token is what distinguishes this process from a later one that
   * reused its PID, which is the difference between "my claim" and "a dead
   * process's claim" when renewing a lease.
   */
  instanceId?: string;
  /** Override the runtime lookup (tests stub the executor + cache). */
  runtime?: () => WorkflowRuntime | null;
}

const DEFAULT_WAKE_MS = 5_000;
const DEFAULT_MAX_PER_PROJECT = 5;
const DEFAULT_MAX_HOST = 20;
const DEFAULT_LOCKFILE_PATH = ".ezcorp/workflow-runner.pid";

/**
 * Cap-bucket key for a run with no project, so the per-project cap still
 * applies to the NULL-project population rather than exempting it.
 *
 * Spelled with a character a real key cannot contain rather than a plain
 * string: project ids are UUIDs, so `"<none>"` could never collide today,
 * but a sentinel that is only safe because of a convention elsewhere is
 * one rename away from silently sharing a bucket with a real project.
 */
const NO_PROJECT = "\u0000no-project";

export class WorkflowRunner {
  private readonly wakeIntervalMs: number;
  private readonly maxConcurrentPerProject: number;
  private readonly maxConcurrentHost: number;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly leaseRenewMs: number;
  private readonly skipLockfile: boolean;
  private readonly lockfilePath: string;
  private readonly readRuntime: () => WorkflowRuntime | null;

  /** `claimed_by` for this instance. */
  readonly instanceId: string;

  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lockfileOwned = false;
  /** projectId (or {@link NO_PROJECT}) → resumes in flight. */
  private readonly inFlight = new Map<string, number>();
  private inFlightHost = 0;
  /** Resumes started and not yet settled. Awaited only by {@link drain}. */
  private readonly active = new Set<Promise<void>>();

  constructor(options?: WorkflowRunnerOptions) {
    this.wakeIntervalMs = options?.wakeIntervalMs ?? DEFAULT_WAKE_MS;
    this.maxConcurrentPerProject = options?.maxConcurrentPerProject ?? DEFAULT_MAX_PER_PROJECT;
    this.maxConcurrentHost = options?.maxConcurrentHost ?? DEFAULT_MAX_HOST;
    this.now = options?.now ?? (() => new Date());
    this.leaseMs = options?.leaseMs ?? WORKFLOW_LEASE_MS;
    this.leaseRenewMs = options?.leaseRenewMs ?? WORKFLOW_LEASE_RENEW_MS;
    this.skipLockfile = options?.skipLockfile ?? false;
    this.lockfilePath = options?.lockfilePath ?? DEFAULT_LOCKFILE_PATH;
    this.instanceId = options?.instanceId ?? `${process.pid}:${selfToken()}`;
    this.readRuntime = options?.runtime ?? getWorkflowRuntime;
  }

  /**
   * Acquire the lockfile, install the wake loop and the lease heartbeat.
   *
   * Returns false — without starting — when a live sibling holds the
   * lockfile. Two daemons on one host would both be inside the host-wide
   * cap and neither would know about the other's in-flight count.
   *
   * There is deliberately no crash-recovery step here: a run left
   * `running` by a dead process is the recovery sweep's business
   * (`terminalizeOrphanedWorkflowRuns`), which reads `run_phase` to decide
   * whether continuing is even safe. Duplicating that judgement in a
   * second component is how two mechanisms start disagreeing.
   */
  async start(): Promise<boolean> {
    if (this.timer) return true;

    if (!this.skipLockfile) {
      const acquired = await acquireLockfile(this.lockfilePath);
      if (!acquired) {
        log.warn("workflow-runner refused to start (sibling alive)", {
          lockfile: this.lockfilePath,
        });
        return false;
      }
      this.lockfileOwned = true;
    }

    // Anything that fails AFTER the lockfile is taken must give it back.
    // Otherwise a partially-started daemon leaves a lockfile stamped with a
    // live PID — this process — and no sibling can ever start, while this
    // one is not running either. The caller drops its handle on a throw, so
    // nothing else will come along to release it.
    try {
      this.timer = setInterval(() => {
        void this.tick().catch((err) => log.warn("tick-failed", { error: String(err) }));
      }, this.wakeIntervalMs);
      unref(this.timer);

      this.heartbeat = setInterval(() => {
        void this.renewLeases().catch((err) =>
          log.warn("lease-renew-failed", { error: String(err) }),
        );
      }, this.leaseRenewMs);
      unref(this.heartbeat);
    } catch (err) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (this.lockfileOwned) {
        await releaseLockfile(this.lockfilePath).catch(() => {});
        this.lockfileOwned = false;
      }
      throw err;
    }

    return true;
  }

  /**
   * Stop ticking, hand back every claim, release the lockfile.
   *
   * Async because releasing claims is a DB write that callers must be able
   * to await — `stop()` returning before the release landed would let the
   * process exit with runs still marked as held by an instance that no
   * longer exists, which is precisely the stall this release exists to
   * avoid.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    try {
      const released = await releaseWorkflowRunClaims(this.instanceId);
      if (released > 0) log.info("released claims on shutdown", { released });
    } catch (err) {
      // Never block shutdown on it: the lease expiry is the backstop, so
      // the cost of failing here is a delay, not a lost run.
      log.warn("release-claims-on-stop-failed", { error: String(err) });
    }

    if (this.lockfileOwned) {
      await releaseLockfile(this.lockfilePath).catch(() => {});
      this.lockfileOwned = false;
    }
  }

  /**
   * One pass: claim what capacity allows and START resuming it.
   *
   * Resumes are launched CONCURRENTLY and deliberately not awaited here.
   * Awaiting each in turn would make the two caps inert — in-flight could
   * never exceed one — and, far worse, would serialize every parked run
   * behind the slowest: one resume whose agent step takes 30 minutes would
   * block every other approval answered in that window. The caps are what
   * bound the concurrency instead, and they are only meaningful because the
   * work overlaps.
   *
   * Returns what this pass CLAIMED and STARTED, not what finished — a
   * resume outlives the tick that began it. Tests await {@link drain}.
   *
   * Public so tests can drive it without waiting out a wake interval.
   */
  async tick(): Promise<{ claimed: number; started: number }> {
    const runtime = this.readRuntime();
    // No registered runtime ⇒ nothing can be resumed, so claiming would
    // only park rows under a lease this process cannot honor.
    if (!runtime) return { claimed: 0, started: 0 };

    const capacity = this.maxConcurrentHost - this.inFlightHost;
    if (capacity <= 0) return { claimed: 0, started: 0 };

    const now = this.now();
    const candidates = await listClaimableWorkflowRuns(now, capacity);

    let claimed = 0;
    let started = 0;
    for (const candidate of candidates) {
      const key = candidate.projectId ?? NO_PROJECT;
      if (this.inFlightHost >= this.maxConcurrentHost) break;
      if ((this.inFlight.get(key) ?? 0) >= this.maxConcurrentPerProject) continue;

      // The CAS decides. A lost race is the normal outcome of two
      // instances reading the same candidate list, not an error.
      const won = await claimWorkflowRun({
        workflowRunId: candidate.id,
        claimedBy: this.instanceId,
        now,
        leaseMs: this.leaseMs,
      });
      if (!won) continue;
      claimed++;
      started++;

      this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
      this.inFlightHost++;
      const task = this.resume(runtime, candidate.id)
        .catch((err) => {
          // Contained here so one bad resume can neither become an
          // unhandled rejection nor stop the daemon claiming anything
          // else. The run stays `running` under lease; the recovery sweep
          // is what decides its fate.
          log.warn("resume-failed", { runId: candidate.id, error: String(err) });
        })
        .finally(() => {
          // Decremented on EVERY path. A leak here does not fail a run —
          // it silently lowers the cap until the process restarts, which
          // is the kind of degradation nobody notices.
          const left = (this.inFlight.get(key) ?? 1) - 1;
          if (left <= 0) this.inFlight.delete(key);
          else this.inFlight.set(key, left);
          this.inFlightHost--;
          this.active.delete(task);
        });
      this.active.add(task);
    }
    return { claimed, started };
  }

  /**
   * Await every resume currently in flight.
   *
   * The test seam for a daemon whose `tick` is deliberately non-blocking.
   * Not used in production: shutdown releases boundary claims and lets the
   * lease cover the rest rather than holding the process open for a
   * possibly-very-long agent step.
   */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active]);
    }
  }

  /**
   * Resume one claimed run.
   *
   * Re-reads the row rather than trusting the candidate projection: the
   * claim happened after the list was built, and the resume needs the
   * cursor, input and `definition_hash` as of now. It also cannot resume a
   * workflow whose definition has since been deleted — that is reported and
   * left `running` under lease so the recovery sweep terminalizes it, which
   * keeps the "who decides a run's fate" answer in one component.
   */
  private async resume(runtime: WorkflowRuntime, runId: string): Promise<void> {
    const row = await getWorkflowRunRow(runId);
    if (!row) {
      log.warn("claimed run vanished before resume", { runId });
      return;
    }
    const workflow = runtime.getWorkflows().find((w) => w.name === row.workflowName);
    if (!workflow) {
      log.warn("claimed run has no definition; leaving for the recovery sweep", {
        runId,
        workflowName: row.workflowName,
      });
      return;
    }

    // `resumeWorkflow` returns a run-shaped `error` for every expected
    // refusal (drift, a pending approval, unavailable step output) rather
    // than throwing, so this is not written around exceptions. A throw
    // here is a genuine bug and propagates to `tick`'s caller.
    //
    // The shared sequence re-reads the row under the claim, names this
    // instance as `resumedBy` — without which the executor's status guard
    // cannot tell this resume from one aimed at a run another process is
    // driving, and refused TERMINALLY every run this daemon ever claimed —
    // and hands the claim back if the run comes back parked. Every resume
    // path in the codebase runs this same sequence; see
    // {@link resumeClaimedRun} for what each step is protecting.
    const run = await resumeClaimedRun(runtime.workflowExecutor, workflow, runId, this.instanceId);
    log.info("resumed a parked run", { runId, status: run.status });
  }

  /** Push this instance's live claims forward by one lease. */
  private async renewLeases(): Promise<number> {
    return renewWorkflowRunLeases(this.instanceId, this.now(), this.leaseMs);
  }
}

/** `.unref()` when the runtime provides it, so a daemon timer never holds
 *  the process open. Guarded because the browser/edge timer shape has no
 *  such method. */
function unref(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
}
