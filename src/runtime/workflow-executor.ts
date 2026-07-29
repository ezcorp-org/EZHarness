import type {
  AgentEvents,
  AgentResult,
  ModelOverride,
  WorkflowDefinition,
  WorkflowModelBinding,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun,
} from "../types";
import type { AgentExecutor } from "./executor";
import type { EventBus } from "./events";
import {
  resolveMapping,
  resolveOutputMapping,
  type RefContext,
} from "./workflow-refs";
import { evaluateCondition } from "./workflow-condition";
import { clampMaxIterations, clampRetries, stepKind } from "./workflow-validator";
import { effectiveModelOverride, resolveModelOverride } from "./workflow-model";
import { prepareStepOutput } from "./workflow-step-output";
import {
  beginNonInteractiveScope,
  type NonInteractiveScopeHandle,
} from "./tools/permissions";
import {
  createWorkflowToolRunner,
  type WorkflowToolRunner,
  type WorkflowToolRunnerFactory,
} from "./workflow-tool-runner";
import { toolCallsThisTurn } from "../extensions/tool-executor/limits";
import { getWorkflowByName } from "../db/queries/workflows";
import { getLatestWorkflowVersion } from "../db/queries/workflow-versions";
import {
  advanceWorkflowRunCursor,
  finalizeWorkflowRunRow,
  insertWorkflowRun,
  markWorkflowRunInBatch,
  upsertWorkflowStepRun,
  type TerminalWorkflowRunStatus,
} from "../db/queries/workflow-runs";
import { workflowDefinitionHash } from "./workflow-definition-hash";
import { logger } from "../logger";

const log = logger.child("workflow");

/** Sentinel thrown internally when a workflow is cancelled (external abort
 *  or a sibling-failure cancel cascaded onto a step's run) so the catch
 *  block terminalizes it as `cancelled` rather than `error`. */
class WorkflowAbortError extends Error {
  constructor() {
    super("workflow cancelled");
    this.name = "WorkflowAbortError";
  }
}

/**
 * A `tool` step needed interactive consent that a workflow structurally
 * cannot obtain (the PDP returned `prompt` for a sensitive capability,
 * and there is no conversation on which to render the approval card).
 *
 * Distinct from a plain failure: it terminalizes the run
 * `awaiting_approval`, not `error` — nothing went wrong, the graph is
 * simply blocked on a human. Never `success`.
 */
export class WorkflowApprovalRequiredError extends Error {
  constructor(
    readonly stepName: string,
    readonly capabilityKind: string,
  ) {
    super(
      `Step "${stepName}" requires interactive approval for capability ` +
        `${capabilityKind} and cannot run in a workflow`,
    );
    this.name = "WorkflowApprovalRequiredError";
  }
}

/**
 * A write the run's durable position depends on could not be made.
 *
 * Terminalizes the run `error` with the `cursor-write-failed` code rather
 * than letting it report success on top of bookkeeping we know is wrong:
 * a run whose recorded position is stale would, on resume, re-execute a
 * batch that already ran.
 */
export class WorkflowCursorWriteError extends Error {
  constructor(
    readonly what: string,
    override readonly cause: unknown,
  ) {
    super(
      `Workflow run state could not be recorded (${what}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "WorkflowCursorWriteError";
  }
}

export interface WorkflowExecutorOptions {
  /**
   * Persist run history to `workflow_runs` / `workflow_step_runs`.
   * Defaults to **false**, mirroring `AgentExecutor`'s `persist` flag, so
   * unit tests and any harness without a wired DB keep working. The
   * server wires `{ persist: true }`.
   */
  persist?: boolean;
  /**
   * Build the `tool`-step dispatcher. Defaults to the real
   * `ToolExecutor`-backed runner; tests inject a fake. Called at most
   * once per workflow run, and only if the graph actually has a tool
   * step (a pure agent/transform/gate workflow never touches the
   * extension registry).
   */
  toolRunnerFactory?: WorkflowToolRunnerFactory;
  /**
   * Stand a result in for a step INSTEAD of dispatching it. Returning
   * `undefined` runs the step normally.
   *
   * Consulted at the very top of {@link WorkflowExecutor.runStep}, before
   * the loop branch and before the kind dispatch, which is the whole
   * point: it is KIND-AGNOSTIC. A dry run substitutes every kind it
   * cannot evaluate purely, so a step kind added later (C7's `workflow`,
   * which recursively contains tool steps) is substituted by default
   * rather than dispatched — the failure mode of a stale skip list, but
   * inverted to fail safe.
   *
   * The step's ref context comes with it, because the decision is not
   * always about the step alone: the dry-run harness has to RESOLVE a
   * gate's operands to know whether they are fabricated, and only the
   * holder of the substitution rule can judge that. It is the BASE
   * context — no `$loop` roots, since the hook is consulted above the
   * loop branch.
   *
   * The dry-run harness is the only caller. It is a BACKSTOP, not the
   * guarantee: that comes from the harness also passing a
   * `toolRunnerFactory` and an `AgentExecutor` that throw, so a step
   * reaching dispatch fails loudly instead of executing.
   */
  stepSubstitute?: (step: WorkflowStep, ctx: RefContext) => AgentResult | undefined;
}

/**
 * Build the id a workflow run passes wherever the host expects a
 * `conversationId`.
 *
 * A workflow has NO conversation, and both obvious shortcuts are unsafe:
 *
 *   • An EMPTY string fails OPEN. `shouldDeliverEvent`
 *     (sse-conversation-filter.ts) short-circuits on a missing/empty
 *     `conversationId` and returns `true` — i.e. every tool event of
 *     this run would be broadcast to every SSE subscriber, before the
 *     per-user check further down ever runs. It also makes the sec-H2
 *     ownership check in `routes/tool-permission.ts` a no-op, because
 *     `getPendingApprovalConversation` returns a falsy value.
 *
 *   • A BORROWED id (some unrelated real conversation) would be a lie
 *     that grants this run that conversation's project scope and leaks
 *     its events to that conversation's owner.
 *
 * So we mint a synthetic, self-describing, non-conversation id. It is
 * deliberately shaped so that every conversation-keyed lookup FAILS
 * CLOSED rather than open:
 *   - `getConversation()` returns null ⇒ the SSE filter's
 *     `isAuthorizedForConversation(..., "closed")` denies delivery, so
 *     tool events from a workflow reach nobody over the chat channel
 *     (the run's own `workflow:*` events, which ARE userId-scoped, are
 *     how the UI follows it);
 *   - `resolveExtensionScopeGrant` derives `projectId = null`, the
 *     strictest RBAC coordinate — only NULL-project grants cover it;
 *   - it can never collide with a real conversation id (real ids are
 *     bare UUIDs).
 *
 * Known, accepted cost: `tool_calls.conversation_id` is an FK to
 * `conversations`, so the per-call analytics row for a workflow tool step
 * is rejected and swallowed by `persistToolCall` (which never throws by
 * contract). The audit trail is not lost — the PDP's own audit row is
 * written independently of any conversation, and this subsystem's
 * `workflow_step_runs` records the step outcome.
 */
export function workflowScopeKey(workflowRunId: string): string {
  return `workflow-run:${workflowRunId}`;
}

export class WorkflowExecutor {
  private readonly persist: boolean;
  private readonly toolRunnerFactory: WorkflowToolRunnerFactory;
  private readonly stepSubstitute?: (step: WorkflowStep, ctx: RefContext) => AgentResult | undefined;

  constructor(
    private agentExecutor: AgentExecutor,
    private bus: EventBus<AgentEvents>,
    opts?: WorkflowExecutorOptions,
  ) {
    this.persist = opts?.persist ?? false;
    this.toolRunnerFactory =
      opts?.toolRunnerFactory ?? (() => createWorkflowToolRunner(this.bus));
    if (opts?.stepSubstitute) this.stepSubstitute = opts.stepSubstitute;
  }

  /**
   * Run one persistence write. Never throws and never blocks the run: a
   * DB glitch must not fail a workflow that otherwise succeeded (same
   * contract as `persistToolCall`). A single shared wrapper keeps that
   * decision — and its `catch` — in exactly one place.
   */
  private async persistWrite(what: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.persist) return;
    try {
      await fn();
    } catch (err) {
      log.warn("workflow run persistence failed", { what, error: String(err) });
    }
  }

  /**
   * Run one persistence write that the run's CORRECTNESS depends on.
   *
   * The strict twin of {@link persistWrite}, and deliberately kept
   * visibly distinct from it. That method's never-throw contract is right
   * for telemetry — a DB glitch must not fail a workflow that otherwise
   * succeeded — and catastrophic for a cursor: a silently-dropped cursor
   * write leaves the next resume pointing at a stale `batchIndex`, so it
   * re-executes a completed batch. Duplicate side effects are worse than
   * a failed run.
   *
   * Kept to the smallest possible number of call sites (the `in-batch`
   * marker, the boundary cursor advance, and later the suspend
   * transition) so the swallow-by-default contract cannot creep onto the
   * durability path — or the reverse.
   *
   * A no-op when `persist` is false, exactly like its twin, so a
   * DB-less harness is unaffected.
   */
  private async persistCritical(what: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.persist) return;
    try {
      await fn();
    } catch (err) {
      throw new WorkflowCursorWriteError(what, err);
    }
  }

  async runWorkflow(
    workflow: WorkflowDefinition,
    input: Record<string, unknown>,
    projectId?: string,
    userId?: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRun> {
    const workflowRun: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowName: workflow.name,
      projectId,
      status: "running",
      startedAt: Date.now(),
      steps: [],
    };

    // `userId` scopes workflow:* SSE delivery to the initiating user
    // (fail-closed filter — see sse-conversation-filter.ts). CLI runs
    // have no user and are observed via stdout/DB, not SSE.
    this.bus.emit("workflow:start", { workflowRun, userId });

    // Durable mirror. Written up-front (status `running`) so a crash
    // mid-run leaves a row the boot sweep can drain, rather than no
    // trace at all. The definition-id lookup is a name→row resolution;
    // a YAML workflow simply has no row, which is what the nullable FK
    // is for.
    await this.persistWrite("insert", async () => {
      const definition = await getWorkflowByName(workflow.name);
      // The version this run executes. Resolved at START, so an edit
      // landing mid-run cannot retroactively change what the run says it
      // ran. Null for a YAML/extension workflow, which has no definition
      // row to version.
      const version = definition
        ? await getLatestWorkflowVersion(definition.id)
        : undefined;
      await insertWorkflowRun({
        id: workflowRun.id,
        workflowName: workflow.name,
        workflowDefinitionId: definition?.id ?? null,
        projectId: projectId ?? null,
        userId: userId ?? null,
        input,
        startedAt: new Date(workflowRun.startedAt),
        definitionVersionId: version?.id ?? null,
        // Pins the graph this run was authorized against, and it is the
        // drift guard that actually fires: C4's resume compares this hash
        // UNCONDITIONALLY. (Reading the version id first, and this only
        // when that is null, is the intended precedence — see
        // `workflow-versions.ts` — but no code implements it yet.) Taken
        // from the version row's own `stepsHash` when there is one, so the
        // hash is a function of the version rather than a second,
        // independently-drifting answer to the same question; computed
        // from the live definition otherwise, which is the pre-C6
        // behaviour and the only option for a workflow with no row.
        definitionHash: version?.stepsHash ?? workflowDefinitionHash(workflow),
      });
    });

    const stepResults = new Map<string, AgentResult>();
    let prevResult: AgentResult | undefined;

    // ── Tool-step scope (security) ───────────────────────────────────
    //
    // The id every tool step of this run passes as `conversationId`, and
    // the key that marks the run non-interactive. Registering it means a
    // sensitive-capability PDP `prompt` is REFUSED synchronously instead
    // of parking a promise nobody can resolve — see
    // `createExtensionPermissionGate`. `gateAbort` fires on cancel so any
    // gate that did somehow open under this key is torn down with the run.
    const scopeKey = workflowScopeKey(workflowRun.id);
    const gateAbort = new AbortController();
    // ── Cancellation plumbing (durability) ───────────────────────────
    //
    // Only `agent` steps mint a real AgentRun; capture each such run id
    // from its `run:start` event and drop it on the matching terminal
    // event, so `cancelInFlight()` can cascade a cancel down every live
    // child. Scoped to this workflow's step agents + its own
    // subscribe/unsubscribe window so a shared bus's unrelated runs are
    // never touched. Transform / gate steps have no run to cancel.
    //
    // Computed BEFORE `beginNonInteractiveScope` on purpose: this line
    // dereferences `workflow.steps`, and a caller that hands us a
    // malformed definition (no `steps`) makes it throw. Registering the
    // scope first meant that throw escaped between the registration and
    // the try/finally that deregisters it — leaking the scope entry for
    // the life of the process, and leaving the `workflow_runs` row
    // stranded at `running`. Nothing between the registration below and
    // the `try` may throw.
    const stepAgents = new Set(
      (workflow.steps ?? []).map((s) => s.agent).filter((a): a is string => Boolean(a)),
    );
    const approvalScope = beginNonInteractiveScope(scopeKey, gateAbort.signal);
    // Built lazily: a workflow with no tool steps never touches the
    // extension registry or the PDP singleton.
    let toolRunner: WorkflowToolRunner | undefined;
    const getToolRunner = (): WorkflowToolRunner => {
      if (!toolRunner) {
        toolRunner = this.toolRunnerFactory();
        if (userId) toolRunner.setCurrentUserId(userId);
        // Pin the scope key as the executor's current conversation up
        // front. `handlePiInvoke` resolves a nested call's conversation
        // as `host.currentConversationId ?? \`cross-ext-${req.id}\``; if
        // this is left unset until the first dispatch, that fallback
        // mints a foreign key whose gate the scope registry would not
        // match — and the run would hang on it.
        toolRunner.setCurrentConversationId?.(scopeKey);
      }
      return toolRunner;
    };
    const toolCtx: ToolStepContext = {
      scopeKey,
      scope: approvalScope,
      getRunner: getToolRunner,
    };

    const inFlightRunIds = new Set<string>();
    const drop = (id: string): void => {
      inFlightRunIds.delete(id);
    };
    const unsubs: Array<() => void> = [
      this.bus.on("run:start", ({ run, runId }) => {
        if (stepAgents.has(run.agentName)) inFlightRunIds.add(runId);
      }),
      this.bus.on("run:complete", ({ run }) => drop(run.id)),
      this.bus.on("run:error", ({ run }) => drop(run.id)),
      this.bus.on("run:cancel", ({ run }) => drop(run.id)),
    ];
    const cancelInFlight = (): void => {
      for (const id of [...inFlightRunIds]) this.agentExecutor.cancelRun(id);
    };

    let externallyAborted = signal?.aborted ?? false;
    const onAbort = (): void => {
      externallyAborted = true;
      cancelInFlight();
    };
    if (signal && !signal.aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (externallyAborted) throw new WorkflowAbortError();

      const batches = this.resolveExecutionOrder(workflow.steps);
      // Durable position, maintained alongside the in-memory state so a
      // crash leaves a row that says where to pick up.
      const completedSteps: string[] = [];

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex]!;
        if (externallyAborted) throw new WorkflowAbortError();

        // Flushed BEFORE the batch dispatches — `batch.map` below runs
        // each step's body synchronously up to its first await, so any
        // write issued after it would race the side effects it is meant
        // to describe. While this stands, a crash is not resumable.
        await this.persistCritical("in-batch", () =>
          markWorkflowRunInBatch(workflowRun.id),
        );

        // Run every step in the batch concurrently. The FIRST failure
        // records `batchError` and immediately cancels the still-running
        // siblings. Each step promise swallows its own rejection so
        // `Promise.all` waits for the whole batch to unwind before we
        // surface the first error.
        let batchError: Error | undefined;
        const fail = (err: unknown): void => {
          if (batchError) return;
          batchError = err instanceof Error ? err : new Error(String(err));
          cancelInFlight();
        };

        const promises = batch.map(async (step) => {
          const stepRun: WorkflowStepRun = {
            stepName: step.name,
            runId: "",
            status: "running",
          };
          workflowRun.steps.push(stepRun);
          // Mirror the step row. Split from the SSE emit below on
          // purpose: the DB must record EVERY status transition
          // (including the terminal one), while the `workflow:step` event
          // sequence is a published contract — the terminal step status
          // already reaches clients on the run object carried by
          // `workflow:complete` / `workflow:error`, so adding frames here
          // would change the stream for no gain.
          // The step's result, once it has one. Carried out-of-band from
          // `stepRun` (which is a published SSE payload) because this is
          // a DURABILITY value, not something clients render — and a
          // result large enough to need capping has no business on the
          // event stream.
          let stepOutput: AgentResult | undefined;
          const persistStep = (): void => {
            void this.persistWrite("step", () =>
              upsertWorkflowStepRun({
                workflowRunId: workflowRun.id,
                stepName: stepRun.stepName,
                runId: stepRun.runId,
                status: stepRun.status,
                ...(stepRun.iterations !== undefined ? { iterations: stepRun.iterations } : {}),
                // Known only after the agent attempt, so the "running"
                // write leaves them NULL and the terminal write fills them.
                provider: stepRun.provider,
                model: stepRun.model,
                // Resume fodder: `$steps.<name>` for every later step.
                // NULL until the step succeeds, and NULL forever for one
                // that failed — a resume reads that as "no value" and
                // fails closed rather than guessing.
                ...(stepOutput !== undefined
                  ? { output: prepareStepOutput(stepOutput) }
                  : {}),
              }),
            );
          };
          const syncStep = (): void => {
            this.bus.emit("workflow:step", { workflowRun, step: stepRun, userId });
            persistStep();
          };
          syncStep();

          try {
            const result = await this.runStep(
              step,
              input,
              stepResults,
              // ── INVARIANT: `$prev` is per-BATCH, not per-step ──────
              //
              // `prevResult` is captured HERE, synchronously. Nothing
              // above this point awaits — `syncStep()` only emits and
              // fires `void this.persistWrite(...)` — so every step
              // promise in this batch is constructed before any of them
              // suspends, and all of them therefore see the SAME
              // `prevResult`: the last declared step of the PREVIOUS
              // batch.
              //
              // Resume depends on that. The cursor stores only
              // `prevStepName` and rebuilds `$prev` from it, which is
              // faithful precisely because the value is per-batch and
              // positional.
              //
              // Do NOT make `prevResult` lazy, and do NOT `await`
              // `persistStep()` / `syncStep()`. Either turns `$prev`
              // into a per-step value: steps later in a batch would
              // start seeing their siblings' results, silently changing
              // the semantics of every existing workflow with no error
              // anywhere. Pinned by "cursor.prevStepName names the step
              // whose result IS $prev" in
              // `workflow-run-persistence.test.ts`.
              prevResult,
              stepRun,
              projectId,
              userId,
              () => externallyAborted,
              syncStep,
              toolCtx,
              // Step binding ?? definition binding ?? none. Resolved to
              // concrete values later (it may hold refs), against the same
              // ref context the step's `input` uses.
              effectiveModelOverride(step, workflow),
            );
            stepResults.set(step.name, result);
            stepRun.status = "success";
            stepOutput = result;
            persistStep();
            return result;
          } catch (err) {
            // Only agent steps mirror their AgentRun's terminal status onto
            // the step run; a gate/transform/loop/ref-resolution failure
            // throws with the step still "running" — and a looped agent step
            // stamps each successful iteration's "success" onto the step run,
            // so a later loop failure (until-exhaustion, iter≥2 strict-ref)
            // would leave a stale "success" on a failed step. This catch only
            // runs when the step failed: overwrite any non-failure status —
            // `cancelled` when the run is being aborted, `error` otherwise.
            // (Kept on one line so the line-coverage gate sees it hit by
            // either branch.)
            const aborting = externallyAborted || err instanceof WorkflowAbortError;
            if (stepRun.status === "running" || stepRun.status === "success") stepRun.status = aborting ? "cancelled" : "error";
            // A step blocked on human consent is not an error — it never
            // ran. Stamp the distinct state so the persisted history says
            // "this is the step to approve", not "this step failed".
            if (err instanceof WorkflowApprovalRequiredError) stepRun.status = "awaiting_approval";
            persistStep();
            fail(err);
            return undefined;
          }
        });

        const results = await Promise.all(promises);

        if (externallyAborted) throw new WorkflowAbortError();
        if (batchError) throw batchError;

        // Last SUCCESSFUL result in this batch feeds `$prev` of the next.
        prevResult = results[results.length - 1];

        // ── Boundary ────────────────────────────────────────────────
        //
        // `results` is `Promise.all` over `batch.map`, so it is in BATCH
        // ORDER, and any failure threw above — which means
        // `results[results.length - 1]` is always the result of
        // `batch[batch.length - 1]`. That equivalence is what lets the
        // cursor record `$prev` as a step NAME and have a resumed run
        // reproduce today's order-fragility exactly, instead of
        // computing a different `$prev` than the same run straight
        // through. Pinned by "cursor.prevStepName names the step whose
        // result IS $prev" in `workflow-run-persistence.test.ts`, so a
        // refactor that makes `prevResult` lazy fails loudly.
        for (const step of batch) completedSteps.push(step.name);
        await this.persistCritical("cursor", () =>
          advanceWorkflowRunCursor(workflowRun.id, {
            batchIndex: batchIndex + 1,
            completedSteps: [...completedSteps],
            prevStepName: batch[batch.length - 1]?.name ?? null,
          }),
        );
      }

      workflowRun.status = "success";
      workflowRun.finishedAt = Date.now();
      workflowRun.result = prevResult ?? { success: true, output: null };
      this.bus.emit("workflow:complete", { workflowRun, userId });
    } catch (err) {
      cancelInFlight();
      gateAbort.abort();
      if (externallyAborted || err instanceof WorkflowAbortError) {
        workflowRun.status = "cancelled";
        workflowRun.finishedAt = Date.now();
        workflowRun.result = {
          success: false,
          output: null,
          error: { code: "cancelled", message: "workflow cancelled" },
        };
        this.bus.emit("workflow:error", {
          workflowRun,
          error: "workflow cancelled",
          userId,
        });
      } else if (err instanceof WorkflowApprovalRequiredError) {
        // Not an error: every automatable step ran, and the graph then
        // reached one that needs a human. Reported as its own terminal
        // state so nothing downstream can mistake it for `success`.
        //
        // `output` carries the LAST SUCCESSFUL result, which is what makes a
        // parked run actionable: the human who completes it out-of-band
        // needs the handoff payload the graph built (a draft id, a verify
        // report, whatever the final transform assembled). With `null` there
        // the payload died with the run and the operator had only an error
        // message to work from. `success` stays false and the
        // `awaiting_approval` error code is unchanged, so nothing that
        // branches on either is affected.
        workflowRun.status = "awaiting_approval";
        workflowRun.finishedAt = Date.now();
        workflowRun.result = {
          success: false,
          output: prevResult?.output ?? null,
          error: { code: "awaiting_approval", message: err.message },
        };
        this.bus.emit("workflow:error", { workflowRun, error: err.message, userId });
      } else if (err instanceof WorkflowCursorWriteError) {
        // The run may well have executed correctly up to here, but its
        // recorded position is not trustworthy — and a run whose
        // bookkeeping is wrong must not report success, or a later resume
        // would re-execute a batch that already ran. Coded distinctly so
        // an operator can tell a durability failure from a workflow one.
        workflowRun.status = "error";
        workflowRun.finishedAt = Date.now();
        workflowRun.result = {
          success: false,
          output: null,
          error: { code: "cursor-write-failed", message: err.message },
        };
        this.bus.emit("workflow:error", { workflowRun, error: err.message, userId });
      } else {
        const error = err instanceof Error ? err.message : String(err);
        workflowRun.status = "error";
        workflowRun.finishedAt = Date.now();
        workflowRun.result = { success: false, output: null, error };
        this.bus.emit("workflow:error", { workflowRun, error, userId });
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      for (const unsub of unsubs) unsub();
      // Deregister the non-interactive scope and reject anything still
      // parked under it — nothing may outlive the run that owned it.
      approvalScope.end();
      // The per-turn tool-call counter (`limits.ts`) is keyed by the id we
      // pass as `conversationId`, and its bus-driven reset only fires for
      // real chat runs. A workflow's key is unique per run, so without
      // this the Map would grow by one dead entry per run forever.
      toolCallsThisTurn.delete(scopeKey);
      await this.persistWrite("finalize", () =>
        finalizeWorkflowRunRow(
          workflowRun.id,
          workflowRun.status as TerminalWorkflowRunStatus,
          workflowRun.result,
        ),
      );
    }

    return workflowRun;
  }

  /**
   * Dispatch one step by kind, delegating to the loop runner when the step
   * declares one. Throws (terminal for the batch) on any failure.
   */
  private async runStep(
    step: WorkflowStep,
    input: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
    emitStep: () => void,
    toolCtx: ToolStepContext,
    modelBinding: WorkflowModelBinding | undefined,
  ): Promise<AgentResult> {
    const baseCtx: RefContext = { input, stepResults, prevResult };

    // Checked FIRST — above the loop branch and above the kind dispatch —
    // so a substituted step can reach no dispatcher at all, whatever its
    // kind and whether or not it declares a loop. See
    // `WorkflowExecutorOptions.stepSubstitute`.
    const substituted = this.stepSubstitute?.(step, baseCtx);
    if (substituted !== undefined) return substituted;

    if (step.loop) {
      return this.runLoop(
        step,
        input,
        stepResults,
        prevResult,
        stepRun,
        projectId,
        userId,
        isAborted,
        emitStep,
        modelBinding,
      );
    }

    const kind = stepKind(step);

    if (kind === "transform") {
      return runTransform(step, baseCtx);
    }
    if (kind === "gate") {
      return runGate(step, baseCtx);
    }
    if (kind === "tool") {
      return runToolStep(step, baseCtx, toolCtx);
    }
    return this.runAgentStep(
      step,
      input,
      stepResults,
      prevResult,
      stepRun,
      projectId,
      userId,
      isAborted,
      modelBinding,
    );
  }

  /**
   * Run one `agent` step with its retry budget. Resolves the step's input
   * once (a strict-ref failure is terminal — never retried), then runs the
   * agent up to `1 + clampRetries(step.retries)` times, returning the first
   * successful result. A *cancelled* run is never retried. Throws a
   * descriptive error when the budget is exhausted or the run was cancelled.
   */
  private async runAgentStep(
    step: WorkflowStep,
    input: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
    modelBinding: WorkflowModelBinding | undefined,
  ): Promise<AgentResult> {
    const refCtx: RefContext = { input, stepResults, prevResult };
    const resolvedInput = resolveMapping(step.input ?? {}, refCtx);
    // Same ref context as the input, resolved ONCE before the retry loop:
    // a retry re-runs the agent, it does not re-pick the model.
    const modelOverride = resolveModelOverride(modelBinding, refCtx, step.name);

    const maxAttempts = 1 + clampRetries(step.retries);
    let lastError = `Step "${step.name}" failed: unknown error`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isAborted()) throw new WorkflowAbortError();

      const { result, cancelled } = await this.runAgentAttempt(
        step,
        resolvedInput,
        stepRun,
        projectId,
        userId,
        modelOverride,
      );
      if (result.success) return result;

      lastError = `Step "${step.name}" failed: ${errorText(result)}`;
      if (cancelled || isAborted()) throw new WorkflowAbortError();
    }

    throw new Error(lastError);
  }

  /** Run a single agent invocation, copying its id/status — and the model
   *  binding it RESOLVED to — onto the step run. */
  private async runAgentAttempt(
    step: WorkflowStep,
    resolvedInput: Record<string, unknown>,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    modelOverride: ModelOverride | undefined,
  ): Promise<{ result: AgentResult; cancelled: boolean }> {
    const agentRun = await this.agentExecutor.runAgent(
      step.agent as string,
      resolvedInput,
      projectId,
      userId,
      modelOverride,
    );
    stepRun.runId = agentRun.id;
    stepRun.status = agentRun.status;
    // What actually served the call, not what was asked for — the run
    // reports it after `resolveModel` collapsed override / agent binding /
    // router pick into one answer. Stays undefined for an agent that never
    // called an LLM.
    stepRun.provider = agentRun.provider;
    stepRun.model = agentRun.model;
    const result = agentRun.result ?? {
      success: false,
      output: null,
      error: "No result",
    };
    return { result, cancelled: agentRun.status === "cancelled" };
  }

  /**
   * Run a looped `agent` / `transform` step: repeat up to
   * `clampMaxIterations(loop.maxIterations)` times, evaluating `until`
   * AFTER each iteration. `until` satisfied ⇒ success. Budget exhausted
   * with `until` unmet obeys `onExhausted` (default `"fail"` throws). No
   * `until` ⇒ a fixed-count loop that always succeeds. Abort is checked
   * between iterations.
   */
  private async runLoop(
    step: WorkflowStep,
    input: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
    emitStep: () => void,
    modelBinding: WorkflowModelBinding | undefined,
  ): Promise<AgentResult> {
    const loop = step.loop!;
    const maxIterations = clampMaxIterations(loop.maxIterations);
    const kind = stepKind(step);
    let last: AgentResult | undefined;
    let result: AgentResult = { success: true, output: null };

    for (let i = 1; i <= maxIterations; i++) {
      if (isAborted()) throw new WorkflowAbortError();

      const loopCtx = { iteration: i, last };
      if (kind === "transform") {
        result = runTransform(step, { input, stepResults, prevResult, loop: loopCtx });
      } else {
        const refCtx: RefContext = { input, stepResults, prevResult, loop: loopCtx };
        const resolvedInput = resolveMapping(step.input ?? {}, refCtx);
        // Re-resolved per iteration, with the same context as the input —
        // so a binding written against `$loop.*` escalates with the loop
        // (cheap first pass, stronger model on the retry) instead of being
        // frozen at iteration 1.
        const attempt = await this.runAgentAttempt(
          step,
          resolvedInput,
          stepRun,
          projectId,
          userId,
          resolveModelOverride(modelBinding, refCtx, step.name),
        );
        if (!attempt.result.success) {
          if (attempt.cancelled || isAborted()) throw new WorkflowAbortError();
          throw new Error(`Step "${step.name}" failed: ${errorText(attempt.result)}`);
        }
        result = attempt.result;
      }

      stepRun.iterations = i;
      emitStep();
      last = result;

      if (loop.until) {
        const untilCtx: RefContext = {
          input,
          stepResults,
          prevResult,
          result,
          iteration: i,
        };
        if (evaluateCondition(loop.until, untilCtx).passed) return result;
      }
    }

    // Budget exhausted.
    if (!loop.until) return result; // fixed-count loop always passes
    if ((loop.onExhausted ?? "fail") === "pass") return result;
    throw new Error(
      `Step "${step.name}" exhausted ${maxIterations} iterations without meeting its until-condition`,
    );
  }

  resolveExecutionOrder(steps: WorkflowStep[]): WorkflowStep[][] {
    const hasDeps = steps.some((s) => s.dependsOn && s.dependsOn.length > 0);

    if (!hasDeps) {
      // No dependsOn anywhere — run sequentially.
      return steps.map((s) => [s]);
    }

    // Topological sort into parallel batches.
    const resolved = new Set<string>();
    const batches: WorkflowStep[][] = [];

    while (resolved.size < steps.length) {
      const batch: WorkflowStep[] = [];

      for (const step of steps) {
        if (resolved.has(step.name)) continue;
        const deps = step.dependsOn ?? [];
        if (deps.every((d) => resolved.has(d))) {
          batch.push(step);
        }
      }

      if (batch.length === 0) {
        const unresolved = steps
          .filter((s) => !resolved.has(s.name))
          .map((s) => s.name);
        throw new Error(
          `Circular dependency detected among steps: ${unresolved.join(", ")}`,
        );
      }

      batches.push(batch);
      for (const step of batch) resolved.add(step.name);
    }

    return batches;
  }

  /**
   * Resolve a step's input mapping. Thin wrapper over the shared
   * {@link resolveMapping}, retained on the executor as the historical
   * public surface (unit-tested directly).
   */
  resolveStepInput(
    mapping: Record<string, string>,
    workflowInput: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult?: AgentResult,
  ): Record<string, unknown> {
    return resolveMapping(mapping, { input: workflowInput, stepResults, prevResult });
  }
}

/** Per-run wiring a `tool` step needs. Built once in `runWorkflow`. */
interface ToolStepContext {
  /** The synthetic `conversationId` every tool call of this run uses —
   *  see {@link workflowScopeKey}. */
  scopeKey: string;
  /** This run's non-interactive scope; `takeDenial()` reports a
   *  capability whose gate was refused. */
  scope: NonInteractiveScopeHandle;
  /** Lazily-built tool dispatcher (already bound to the acting user). */
  getRunner: () => WorkflowToolRunner;
}

/**
 * Run a `tool` step: resolve its `input` with the SAME ref language every
 * other kind uses ({@link resolveMapping} — there is deliberately no
 * second grammar), then dispatch through the host's one tool path so the
 * call is authorized, audited and provenance-tracked exactly like a
 * chat-driven one.
 *
 * The security-critical branch is the `catch`: when the PDP returns
 * `prompt` for a sensitive capability, `createExtensionPermissionGate`
 * rejects SYNCHRONOUSLY (this run's scope is registered non-interactive),
 * so we never await a gate nobody can answer. We turn that refusal into
 * {@link WorkflowApprovalRequiredError}, which terminalizes the run
 * `awaiting_approval` instead of hanging it forever.
 *
 * Result shape mirrors the other kinds — `{ success, output }` — so
 * `$prev` / `$steps` refs work against a tool step unchanged. `output` is
 * the tool's text content joined with newlines (the same projection
 * `ToolExecutor.createToolsContext` hands to code-based agents), THEN
 * {@link parseToolOutput}-ed so a JSON-returning tool is addressable by
 * path. Without that a tool step could only ever be terminal — see the
 * function's own doc.
 */
async function runToolStep(
  step: WorkflowStep,
  refCtx: RefContext,
  toolCtx: ToolStepContext,
): Promise<AgentResult> {
  const resolvedInput = resolveMapping(step.input ?? {}, refCtx);

  let result: Awaited<ReturnType<WorkflowToolRunner["executeToolCall"]>>;
  try {
    // `scope.run` makes this run's non-interactive scope AMBIENT for the
    // whole dispatch subtree, so a gate opened against ANY conversation
    // id — not just this run's scope key — is refused rather than
    // awaited. Key matching alone let a nested call that resolved a
    // foreign id park a promise the workflow then awaited forever.
    result = await toolCtx.scope.run(() =>
      toolCtx
        .getRunner()
        .executeToolCall(step.tool as string, resolvedInput, toolCtx.scopeKey, null),
    );
  } catch (err) {
    // `takeDenial()` is non-empty ONLY when a gate was refused for want
    // of a human during this dispatch, which pins the failure to the
    // capability that needed consent rather than a generic "denied".
    const capabilityKind = toolCtx.scope.takeDenial();
    if (capabilityKind !== undefined) {
      throw new WorkflowApprovalRequiredError(step.name, capabilityKind);
    }
    throw new Error(
      `Step "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = result.content.map((c) => c.text).join("\n");
  if (result.isError) {
    // The RAW text on the failure path: an error message is for a human to
    // read, and re-shaping it would only make the loud-failure message worse.
    throw new Error(`Step "${step.name}" failed: ${text}`);
  }
  return { success: true, output: parseToolOutput(text) };
}

/**
 * Project a tool's text result into the value later steps address.
 *
 * Extension tools overwhelmingly return `JSON.stringify(...)` of a result
 * object — `create_extension` returns `{draftId, openUrl, name, type}`,
 * `validate_extension` returns `{ok, pass, steps}`. Leaving that as an
 * opaque string makes a tool step permanently TERMINAL: there is no way to
 * thread `draftId` into the next step's `input`, and a `gate` can only do
 * substring `contains` on the blob instead of asserting `pass === true`.
 * Every real multi-tool chain needs this.
 *
 * Conservative on purpose — only a JSON **object or array** is parsed:
 *
 *   - A bare `42` or `"true"` would otherwise change TYPE (string → number
 *     / boolean) and silently break an existing `eq`/`contains` condition.
 *   - Anything that is not JSON at all (a prose tool result, a multi-part
 *     content join) is returned verbatim, so every pre-existing tool step
 *     keeps its exact string output.
 *
 * The cheap first-character check short-circuits before `JSON.parse` so a
 * large prose result is not run through the parser just to throw.
 */
export function parseToolOutput(text: string): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Text that merely LOOKS like JSON (a truncated blob, a `{` in prose)
    // stays a string — never a silent empty object.
    return text;
  }
}

/** Resolve a `transform` step's declarative output mapping into an
 *  `AgentResult`-shaped value. Pure — no LLM, no I/O, no clock. */
function runTransform(step: WorkflowStep, ctx: RefContext): AgentResult {
  const output = resolveOutputMapping(step.output ?? {}, ctx);
  return { success: true, output };
}

/** Evaluate a `gate` step's condition; throw with a descriptive message on
 *  failure (fail-fast like a failed agent step). */
function runGate(step: WorkflowStep, ctx: RefContext): AgentResult {
  const res = evaluateCondition(step.condition!, ctx);
  if (!res.passed) {
    throw new Error(`Gate "${step.name}" failed: ${res.reason}`);
  }
  return { success: true, output: { passed: true } };
}

/** Extract a human-readable error string from an unsuccessful result. */
function errorText(result: AgentResult): string {
  if (typeof result.error === "string") return result.error;
  if (result.error) return result.error.message;
  return "unknown error";
}
