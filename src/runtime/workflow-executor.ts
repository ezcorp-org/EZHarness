import type {
  AgentEvents,
  AgentResult,
  ApprovalStepOutput,
  ModelOverride,
  WorkflowCursor,
  WorkflowDefinition,
  WorkflowModelBinding,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepInputSink,
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
import { prepareResolvedInput, prepareStepOutput } from "./workflow-step-output";
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
  loadStepResults,
  markWorkflowRunInBatch,
  suspendWorkflowRun,
  upsertWorkflowStepRun,
  type TerminalWorkflowRunStatus,
} from "../db/queries/workflow-runs";
import {
  upsertWorkflowStepIteration,
  type WorkflowStepIterationUpsert,
} from "../db/queries/workflow-step-iterations";
import { workflowDefinitionHash } from "./workflow-definition-hash";
import {
  getWorkflowApproval,
  hasPendingApproval,
  parkWorkflowApproval,
} from "../db/queries/workflow-approvals";
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

/**
 * A step deliberately PARKED the run — it is alive, answerable, and will
 * be resumed. Never an error.
 *
 * Distinct from {@link WorkflowApprovalRequiredError} on purpose. That
 * one means a `tool` step hit a consent gate a workflow structurally
 * cannot satisfy: the run is parked AND dead, terminal at
 * `awaiting_approval`. This one means the graph asked for a human on
 * purpose and can continue once answered, so it terminalizes nothing —
 * it produces `suspended`, the only non-terminal, non-`running` state.
 *
 * Reusing `awaiting_approval` for this would retroactively make every
 * historical row of that status look resumable.
 */
export class WorkflowSuspendedError extends Error {
  constructor(
    readonly stepName: string,
    readonly reason: string,
  ) {
    super(`Workflow suspended at step "${stepName}": ${reason}`);
    this.name = "WorkflowSuspendedError";
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
/**
 * What one agent invocation produced.
 *
 * The `attempt*` fields are THIS invocation's own facts, deliberately
 * separate from the running totals `runAgentAttempt` folds onto the step
 * run: a child iteration row needs the per-pass numbers, and deriving
 * them by diffing the total before and after would give the same answer
 * today and break silently the moment anything else writes to it.
 */
interface AgentAttemptOutcome {
  result: AgentResult;
  cancelled: boolean;
  attemptRunId: string;
  attemptProvider?: string;
  attemptModel?: string;
  attemptInputTokens?: number;
  attemptOutputTokens?: number;
  attemptStatus: WorkflowRunStatus;
}

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

  /**
   * Record one loop iteration's child row. Telemetry, so it rides
   * {@link persistWrite}'s never-throw contract — a trace row must never
   * be able to fail a run that otherwise succeeded.
   *
   * `attempt: 0` because `runLoop` has no retry budget of its own: the
   * loop IS the repetition, and a retried agent step reaches
   * {@link runAgentAttempt} through the other path. The column exists so
   * a future retrying loop has somewhere to put a second try without
   * colliding on the arbiter.
   *
   * Fire-and-forget for the same reason the parent step write is: an
   * awaited telemetry write inside the loop would add a DB round-trip to
   * every iteration of every looped step.
   */
  private persistIteration(
    workflowRunId: string,
    stepName: string,
    row: Omit<WorkflowStepIterationUpsert, "workflowRunId" | "stepName" | "attempt">,
  ): void {
    void this.persistWrite("iteration", async () => {
      const written = await upsertWorkflowStepIteration({
        ...row,
        workflowRunId,
        stepName,
        attempt: 0,
      });
      // The parent row is written fire-and-forget, so "not visible yet" is
      // reachable rather than impossible. Logged rather than swallowed: a
      // hole in a trace should be findable.
      if (!written) {
        log.warn("workflow iteration row skipped — parent step row not visible", {
          workflowRunId,
          stepName,
          iteration: row.iteration,
        });
      }
    });
  }

  async runWorkflow(
    workflow: WorkflowDefinition,
    input: Record<string, unknown>,
    projectId?: string,
    userId?: string,
    signal?: AbortSignal,
    /**
     * Optional caller-supplied run id.
     *
     * Added as a trailing OPTIONS BAG rather than a sixth positional so the
     * documented positional signature every existing caller uses — the run
     * route, the CLI, the extension trigger path — stays exactly as it was.
     *
     * The async run route is the only user: it must name the run in a 202
     * before the run finishes, and reading the id off the `workflow:start`
     * frame instead would be a race against a response it has no ordering
     * guarantee about. Absent ⇒ minted here, as always.
     */
    opts?: { runId?: string },
  ): Promise<WorkflowRun> {
    const workflowRun: WorkflowRun = {
      id: opts?.runId ?? crypto.randomUUID(),
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
      // The fingerprint of the graph THIS RUN WAS HANDED — not of the row
      // that happens to own the name.
      const ranHash = workflowDefinitionHash(workflow);
      // ── Only claim a version whose content is what we ran ────────────
      //
      // The lookup above is by NAME, and a name does not identify a graph:
      //   • extension and YAML entries win the name race in the cache
      //     (`buildWorkflowCache` concatenates them first), so a YAML
      //     workflow shadowing a DB row would otherwise record the DB
      //     row's version — a snapshot of steps this run never executed;
      //   • `updateWorkflow` and `ensureWorkflowVersion` are two writes,
      //     so a failure between them leaves the row's content ahead of
      //     its newest version, and every later run would be stamped with
      //     a stale one — permanently, and silently.
      // Both are the same error: recording a version we did not run.
      // Comparing content closes both, and NULL already means exactly
      // "cannot name the snapshot this run executed" (a pre-versioning run
      // or a workflow with no row). If a trace ever needs to name the
      // snapshot for a run of a stale cache entry, resolve it BY
      // `stepsHash` — do not widen this claim back to "latest".
      const ranVersion = version?.stepsHash === ranHash ? version : undefined;
      await insertWorkflowRun({
        id: workflowRun.id,
        workflowName: workflow.name,
        // The row that owns this NAME, which is a resolution fact and
        // deliberately not gated on content: a run that raced a save still
        // belongs to the definition it was launched from, and nothing
        // reads this as a claim about which steps ran.
        workflowDefinitionId: definition?.id ?? null,
        projectId: projectId ?? null,
        userId: userId ?? null,
        input,
        startedAt: new Date(workflowRun.startedAt),
        definitionVersionId: ranVersion?.id ?? null,
        // Pins the graph this run was authorized against, and it is the
        // drift guard that actually fires: C4's resume compares this hash
        // UNCONDITIONALLY. (Reading the version id first, and this only
        // when that is null, is the intended precedence — see
        // `workflow-versions.ts` — but no code implements it yet.)
        //
        // Always the hash of what RAN. When there is a matching version
        // this is byte-identical to its `stepsHash`, so the hash is still
        // a function of the version rather than a second,
        // independently-drifting answer; when there is not, writing the
        // version's hash would have parked the run against a graph it
        // never executed and made resume refuse a run that had not
        // drifted.
        definitionHash: ranHash,
      });
    });

    return this.executeFrom({
      workflow,
      input,
      workflowRun,
      projectId,
      userId,
      signal,
      // A fresh run starts at batch 0 with nothing completed and no
      // `$prev` — the same shape a resume supplies from its cursor.
      cursor: { batchIndex: 0, completedSteps: [], prevStepName: null },
      stepResults: new Map(),
    });
  }

  /**
   * Continue a parked run from its recorded cursor.
   *
   * Callers holding a `workflow_runs` row should build the second argument
   * with {@link resumeArgsFromRow} rather than by hand — see its comment
   * for why.
   *
   * The caller supplies the definition (the executor has no registry of
   * its own), which is also what makes drift detectable: the run recorded
   * a hash of the graph it was authorized against, and a definition that
   * no longer matches FAILS CLOSED rather than resuming into a different
   * set of batches than the operator parked.
   *
   * Emits **no** `workflow:start`. That event PREPENDS a run to the
   * client store, so re-emitting it would render one parked job as two.
   * A resumed run emits only `workflow:step` and its terminal event.
   *
   * Returns the run, or a run-shaped `error` result when it refuses —
   * never throws for an expected refusal, so a daemon driving many
   * resumes is not written around exceptions.
   */
  async resumeWorkflow(
    workflow: WorkflowDefinition,
    row: {
      id: string;
      workflowName: string;
      status: string;
      input: Record<string, unknown> | null;
      cursor: WorkflowCursor | null;
      definitionHash: string | null;
      projectId?: string | null;
      userId?: string | null;
      startedAt: Date;
    },
    signal?: AbortSignal,
  ): Promise<WorkflowRun> {
    const workflowRun: WorkflowRun = {
      id: row.id,
      workflowName: row.workflowName,
      projectId: row.projectId ?? undefined,
      status: "running",
      startedAt: row.startedAt.getTime(),
      steps: [],
    };
    const userId = row.userId ?? undefined;

    // ── Two kinds of refusal, and conflating them destroys runs ────────
    //
    // `refuseTerminal` is for a run that is genuinely DEAD — its
    // definition changed under it, a completed step's output is gone, it
    // was never suspended. Recording that is mandatory and goes through
    // the STRICT path: a fail-closed decision written by a swallowable
    // call is not fail-closed, because the row would stay `suspended`
    // and the next tick would resume it anyway, forever.
    //
    // `refuseTransient` is for "not now, and that is fine" — the run is
    // HEALTHY and waiting. It writes NOTHING, because the row is already
    // exactly right, and it emits no `workflow:error`, because that
    // event would replace a live run with an error card in the client
    // store.
    //
    // The distinction is not cosmetic. Terminalizing a transient refusal
    // turns a *blocked* bypass into permanent denial of service on the
    // run being protected: an attacker who cannot get past the consent
    // gate could instead destroy every approval-parked run, one direct
    // call each — strictly worse than the attack the check exists to
    // stop.
    const refuseTerminal = async (code: string, message: string): Promise<WorkflowRun> => {
      workflowRun.status = "error";
      workflowRun.finishedAt = Date.now();
      workflowRun.result = { success: false, output: null, error: { code, message } };
      await this.persistCritical("resume-refusal", () =>
        finalizeWorkflowRunRow(workflowRun.id, "error", workflowRun.result),
      );
      this.bus.emit("workflow:error", { workflowRun, error: message, userId });
      return workflowRun;
    };

    const refuseTransient = (code: string, message: string): WorkflowRun => {
      workflowRun.status = "suspended";
      workflowRun.result = { success: false, output: null, error: { code, message } };
      // No `finishedAt`, no DB write, no event. The run is untouched —
      // which is the entire point.
      return workflowRun;
    };

    if (row.status !== "suspended") {
      return refuseTerminal(
        "not-resumable",
        `Workflow run ${row.id} is ${row.status}, not suspended`,
      );
    }

    // ── The consent boundary, enforced here rather than by convention ──
    //
    // This method is EXPORTED, so without this check any caller could
    // resume a run parked at an approval and step straight over the
    // consent gate — and spy-counting the known answer surfaces would
    // prove nothing about that caller. The chokepoint would be a
    // convention that merely looks like a boundary, which is worse than
    // an acknowledged convention because it invites trust it has not
    // earned.
    //
    // `answerApproval` records the answer BEFORE it resumes, so by the
    // time it reaches here nothing is pending and this is transparent to
    // the sanctioned path. Every other path is refused, whoever it is.
    if (await hasPendingApproval(row.id)) {
      return refuseTransient(
        "approval-pending",
        `Workflow run ${row.id} is parked on an unanswered approval; ` +
          `it can only be resumed by answering that approval`,
      );
    }

    // Drift. Until definitions are versioned this hash is the only guard,
    // and it names what it compared so the refusal is actionable rather
    // than a bare "changed".
    const currentHash = workflowDefinitionHash(workflow);
    if (row.definitionHash !== null && row.definitionHash !== currentHash) {
      return refuseTerminal(
        "definition-changed",
        `Workflow "${row.workflowName}" changed while run ${row.id} was suspended ` +
          `(parked against ${row.definitionHash.slice(0, 12)}, now ${currentHash.slice(0, 12)}); ` +
          `its recorded position no longer identifies the same steps, so it cannot be resumed`,
      );
    }

    // Rehydrate `$steps`. Fails closed on a completed step whose output
    // never landed or was truncated — resuming without it would run the
    // rest of the graph against a different `$steps` than the first half
    // saw, which is a silent wrong answer rather than a loud failure.
    const loaded = await loadStepResults(row.id);
    if (!loaded.ok) {
      return refuseTerminal("step-output-unavailable", `Cannot resume run ${row.id}: ${loaded.reason}`);
    }

    return this.executeFrom({
      workflow,
      input: row.input ?? {},
      workflowRun,
      projectId: row.projectId ?? undefined,
      userId,
      signal,
      cursor: row.cursor ?? { batchIndex: 0, completedSteps: [], prevStepName: null },
      stepResults: loaded.stepResults,
    });
  }

  /**
   * Execute a workflow from a cursor position — the shared body of a
   * fresh run and a resumed one.
   *
   * Extracted so `resumeWorkflow` cannot drift from `runWorkflow`: the
   * scope registration, cancellation plumbing, batch dispatch, terminal
   * handling and teardown are all one copy. A resumed run differs only in
   * what it is handed (a non-zero cursor and a rehydrated `stepResults`)
   * and in what its caller emitted beforehand — notably NOT
   * `workflow:start`, which would prepend a second card for one job.
   */
  private async executeFrom(ctx: {
    workflow: WorkflowDefinition;
    input: Record<string, unknown>;
    workflowRun: WorkflowRun;
    projectId?: string;
    userId?: string;
    signal?: AbortSignal;
    cursor: WorkflowCursor;
    stepResults: Map<string, AgentResult>;
  }): Promise<WorkflowRun> {
    const { workflow, input, workflowRun, projectId, userId, signal } = ctx;
    const stepResults = ctx.stepResults;
    // `$prev` for the batch we are about to run. On a fresh run there is
    // none; on a resume it is rebuilt from the recorded step NAME, which
    // is what reproduces the documented order-fragility exactly rather
    // than inventing a graph-deterministic answer the original run never
    // saw.
    let prevResult = ctx.cursor.prevStepName
      ? stepResults.get(ctx.cursor.prevStepName)
      : undefined;

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

    // ── Durable position, readable from the catch ────────────────────
    //
    // Declared outside the `try` because a suspend has to record where it
    // parked, and the parking point is only known inside the loop.
    //
    // `completedSteps` is appended by each step AS IT SUCCEEDS rather
    // than in a batch at the boundary. That matters for a partial batch:
    // when a step parks the run, its siblings that already finished must
    // already be in this list, or resume would re-run them. The order is
    // therefore completion order, which is also the more honest record.
    const completedSteps: string[] = [...ctx.cursor.completedSteps];
    const alreadyDone = new Set(ctx.cursor.completedSteps);
    let suspended = false;
    let currentBatchIndex = ctx.cursor.batchIndex;

    try {
      if (externallyAborted) throw new WorkflowAbortError();

      const batches = this.resolveExecutionOrder(workflow.steps);

      for (let batchIndex = ctx.cursor.batchIndex; batchIndex < batches.length; batchIndex++) {
        currentBatchIndex = batchIndex;
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
          // ── Partial-batch resume ────────────────────────────────────
          //
          // A run can park PART WAY THROUGH a batch: an `approval` step
          // reached via `dependsOn` sits alongside siblings, and those
          // siblings may already have succeeded before it asked for a
          // human. Re-running them on resume would duplicate their side
          // effects — the very thing this recovery model exists to
          // prevent — so a step already recorded as complete is served
          // from its persisted output instead of re-executed.
          //
          // Returning the rehydrated result (rather than skipping the
          // slot) keeps `results` in batch order, which is what makes
          // `results[results.length - 1]` still the last declared step
          // and keeps `$prev` faithful.
          //
          // On a fresh run `alreadyDone` is empty and this is dead
          // weight; if suspension only ever happened between batches it
          // would likewise never fire. It is here because it is correct
          // under BOTH readings, and the cost of being wrong is silent
          // duplicate execution.
          const restored = alreadyDone.has(step.name)
            ? stepResults.get(step.name)
            : undefined;
          if (restored) return restored;

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
          // Off-payload for the SAME reason `stepOutput` is: this holds
          // the RAW resolved mapping, credentials and all, and
          // `workflow:step` is published to every subscribed client.
          // Redacted and capped by `prepareResolvedInput` below, which is
          // the only path it takes out of this closure.
          const inputSink: WorkflowStepInputSink = {};
          // Wall-clock for the whole step INCLUDING retries and loop
          // iterations — started before dispatch and read in both the
          // success path and the catch, so a step that failed still
          // reports how long it took to fail.
          const startedAt = Date.now();
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
                attempt: stepRun.attempt,
                // Undefined all the way to SQL NULL when nothing reported
                // usage. A 0 here would be a claim, and every aggregate
                // that sums this column would believe it.
                inputTokens: stepRun.inputTokens,
                outputTokens: stepRun.outputTokens,
                durationMs: stepRun.durationMs,
                errorCode: stepRun.errorCode,
                // Resume fodder: `$steps.<name>` for every later step.
                // NULL until the step succeeds, and NULL forever for one
                // that failed — a resume reads that as "no value" and
                // fails closed rather than guessing.
                ...(stepOutput !== undefined
                  ? { output: prepareStepOutput(stepOutput) }
                  : {}),
                ...(inputSink.resolvedInput !== undefined
                  ? { resolvedInput: prepareResolvedInput(inputSink.resolvedInput) }
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
              workflowRun.id,
              inputSink,
            );
            stepResults.set(step.name, result);
            stepRun.status = "success";
            stepRun.durationMs = Date.now() - startedAt;
            stepOutput = result;
            // Recorded the instant it succeeds, not at the boundary: a
            // sibling that parks the run later in this same batch must
            // not cause this step to be re-executed on resume.
            //
            // ── PAIRED WITH `loadStepResults` — do not break either half ──
            //
            // This push happens BEFORE `persistStep()` below, and that
            // call is `void this.persistWrite(...)` — fire-and-forget,
            // never-throwing. So the window is real: a step can be
            // recorded complete here while its `output` write is still in
            // flight or silently dropped.
            //
            // That is SAFE only because `loadStepResults`
            // (`db/queries/workflow-runs.ts`) REFUSES to rehydrate a
            // `success` step whose output is missing, rather than
            // returning an empty map. Make that loader lenient and this
            // ordering silently becomes a correctness bug: the resumed
            // half of the run would see a different `$steps` than the
            // first half, with no error anywhere.
            //
            // Pinned by "a step recorded complete with no persisted
            // output refuses resume, never rehydrates empty".
            if (!alreadyDone.has(step.name)) {
              alreadyDone.add(step.name);
              completedSteps.push(step.name);
            }
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
            stepRun.durationMs = Date.now() - startedAt;
            // The typed reason, not the message. Derived from the
            // exception CLASS so it stays stable enough to GROUP BY: a
            // message carries the step name and the provider's wording
            // and is different on every row.
            stepRun.errorCode = aborting ? "cancelled" : "step-failed";
            // A step blocked on human consent is not an error — it never
            // ran. Stamp the distinct state so the persisted history says
            // "this is the step to approve", not "this step failed".
            if (err instanceof WorkflowApprovalRequiredError) { stepRun.status = "awaiting_approval"; stepRun.errorCode = "approval-required"; }
            // A deliberate park is likewise not a failure: the step is
            // waiting, and on resume this same row is updated in place.
            if (err instanceof WorkflowSuspendedError) { stepRun.status = "suspended"; stepRun.errorCode = "suspended"; }
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
        // `completedSteps` is already current — each step appended
        // itself on success — so the boundary only has to publish it.
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
      } else if (err instanceof WorkflowSuspendedError) {
        // NOT terminal. The run is alive and answerable; the row records
        // where to pick up and nothing finalizes it.
        //
        // The cursor keeps this batch's index, so resume RE-ENTERS the
        // batch the parked step belongs to — siblings that already
        // finished are restored from their persisted output rather than
        // re-run. `prevStepName` is carried through UNCHANGED: it is the
        // `$prev` this batch already saw, and recomputing it would give
        // the resumed half of the run a different `$prev` than the first
        // half.
        //
        // Written through the STRICT path, because a swallowed suspend
        // leaves the row at `running` while this process walks away —
        // and the recovery sweep would then classify it by `run_phase`
        // instead of parking it. If the write fails we fall through to a
        // loud `cursor-write-failed` rather than returning a `suspended`
        // object no row agrees with.
        try {
          await this.persistCritical("suspend", () =>
            suspendWorkflowRun(workflowRun.id, {
              reason: err.reason,
              cursor: {
                batchIndex: currentBatchIndex,
                completedSteps: [...completedSteps],
                prevStepName: ctx.cursor.prevStepName,
              },
            }),
          );
          suspended = true;
          workflowRun.status = "suspended";
          workflowRun.result = {
            success: false,
            output: prevResult?.output ?? null,
            error: { code: "suspended", message: err.message },
          };
          // Deliberately NOT `finishedAt` — the run has not finished.
          this.bus.emit("workflow:error", { workflowRun, error: err.message, userId });
        } catch (writeErr) {
          const message =
            writeErr instanceof Error ? writeErr.message : String(writeErr);
          workflowRun.status = "error";
          workflowRun.finishedAt = Date.now();
          workflowRun.result = {
            success: false,
            output: null,
            error: { code: "cursor-write-failed", message },
          };
          this.bus.emit("workflow:error", { workflowRun, error: message, userId });
        }
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
      // Everything above is UNCONDITIONAL — a suspended run releases its
      // scope, its listeners and its per-turn budget exactly like a
      // terminal one, because this process is walking away from the run
      // either way and nothing may outlive it.
      //
      // Only the finalize is conditional. `TerminalWorkflowRunStatus`
      // correctly excludes `suspended`, and the row was already moved to
      // `suspended` through the strict path; calling the finalizer here
      // would try to terminalize a run that is still alive.
      //
      // Accepted consequence of the unconditional teardown: the per-turn
      // tool-call budget resets across a suspend. It is a runaway-loop
      // guard, not an accounting ledger — persisting it would make a
      // long-parked run un-resumable for a reason no operator could
      // diagnose.
      if (!suspended) {
        await this.persistWrite("finalize", () =>
          finalizeWorkflowRunRow(
            workflowRun.id,
            workflowRun.status as TerminalWorkflowRunStatus,
            workflowRun.result,
          ),
        );
      }
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
    /** This run's id — an `approval` step keys its parked row on it. */
    workflowRunId: string,
    /** Off-payload sink for the resolved input — see
     *  {@link WorkflowStepInputSink} for why it is not on `stepRun`. */
    inputSink: WorkflowStepInputSink,
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
        inputSink,
        workflowRunId,
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
      return runToolStep(step, baseCtx, toolCtx, inputSink);
    }
    if (kind === "approval") {
      return runApprovalStep(step, baseCtx, workflowRunId, this.persist);
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
      inputSink,
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
    inputSink: WorkflowStepInputSink,
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
        inputSink,
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
    inputSink: WorkflowStepInputSink,
  ): Promise<AgentAttemptOutcome> {
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
    // The exact mapping this invocation was handed. Last-write for a
    // looped step, so the trace shows the iteration that actually ended
    // it; per-iteration inputs are not stored, because a hot loop would
    // multiply the largest payload in the row by the loop ceiling.
    inputSink.resolvedInput = resolvedInput;
    // Counted HERE rather than in the two callers, so a retry loop
    // (`runAgentStep`) and a `loop` (`runLoop`) are measured the same way
    // without either having to know about the other.
    stepRun.attempt = (stepRun.attempt ?? 0) + 1;
    // ACCUMULATED, unlike provider/model above. A step that retried three
    // times was billed three times; overwriting would report only the
    // last one. The `if` is what keeps "nothing reported" distinct from
    // "reported zero" — see `AgentRun.inputTokens`.
    if (agentRun.inputTokens !== undefined && agentRun.outputTokens !== undefined) {
      stepRun.inputTokens = (stepRun.inputTokens ?? 0) + agentRun.inputTokens;
      stepRun.outputTokens = (stepRun.outputTokens ?? 0) + agentRun.outputTokens;
    }
    const result = agentRun.result ?? {
      success: false,
      output: null,
      error: "No result",
    };
    // The per-ATTEMPT facts are returned as well as folded onto `stepRun`,
    // because the child iteration rows need this invocation's own numbers
    // and `stepRun` only ever holds the running total. Diffing the total
    // before and after would produce the same answer today and silently
    // break the day anything else touches it.
    return {
      result,
      cancelled: agentRun.status === "cancelled",
      attemptRunId: agentRun.id,
      attemptProvider: agentRun.provider,
      attemptModel: agentRun.model,
      attemptInputTokens: agentRun.inputTokens,
      attemptOutputTokens: agentRun.outputTokens,
      attemptStatus: agentRun.status,
    };
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
    inputSink: WorkflowStepInputSink,
    workflowRunId: string,
  ): Promise<AgentResult> {
    const loop = step.loop!;
    const maxIterations = clampMaxIterations(loop.maxIterations);
    const kind = stepKind(step);
    let last: AgentResult | undefined;
    let result: AgentResult = { success: true, output: null };

    for (let i = 1; i <= maxIterations; i++) {
      if (isAborted()) throw new WorkflowAbortError();

      const loopCtx = { iteration: i, last };
      const iterationStartedAt = Date.now();
      if (kind === "transform") {
        result = runTransform(step, { input, stepResults, prevResult, loop: loopCtx });
        // A transform loop mints no AgentRun, so its row carries timing
        // and status alone — which is still the difference between "this
        // loop ran three times" and "this is which pass was slow".
        this.persistIteration(workflowRunId, step.name, {
          iteration: i,
          status: "success",
          durationMs: Date.now() - iterationStartedAt,
        });
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
          inputSink,
        );
        // Written BEFORE the failure check, so a loop that dies on
        // iteration 3 still records that iterations 1 and 2 happened and
        // what the failing one cost. Recording only successes would erase
        // exactly the pass an operator opened the trace to find.
        this.persistIteration(workflowRunId, step.name, {
          iteration: i,
          status: attempt.result.success ? "success" : attempt.attemptStatus,
          runId: attempt.attemptRunId,
          provider: attempt.attemptProvider,
          model: attempt.attemptModel,
          inputTokens: attempt.attemptInputTokens,
          outputTokens: attempt.attemptOutputTokens,
          durationMs: Date.now() - iterationStartedAt,
          errorCode: attempt.result.success ? undefined : "step-failed",
        });
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
  inputSink: WorkflowStepInputSink,
): Promise<AgentResult> {
  const resolvedInput = resolveMapping(step.input ?? {}, refCtx);
  // Recorded from the SAME value that is about to be dispatched, not
  // re-resolved for the trace — a second `resolveMapping` could disagree
  // with the first and the row would describe a call that never happened.
  inputSink.resolvedInput = resolvedInput;

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
    // A deliberate park is not a dispatch failure and must reach the
    // run's catch INTACT — wrapping it in a generic Error would
    // terminalize a run that is merely waiting for a human.
    if (err instanceof WorkflowSuspendedError) throw err;
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

/**
 * Run an `approval` step: park the run for a human, or — on the resume
 * that follows their answer — return that answer as the step's result.
 *
 * Both directions live here on purpose. The step is re-entered on resume
 * (`cursor.batchIndex` still points at its batch), so "has this been
 * answered yet?" is the only question that distinguishes the two passes,
 * and answering it in one place is what keeps them from disagreeing.
 *
 * The park is a DELIBERATE one at a step boundary, which is the case the
 * `run_phase` model already handles cleanly: nothing has been dispatched,
 * so there is no half-applied side effect to worry about.
 *
 * `itemIds` is resolved HERE, at suspend time, from what the run actually
 * produced — not at definition time from what its author hoped for. That
 * is what makes the consent guard check the answer against reality.
 */
async function runApprovalStep(
  step: WorkflowStep,
  refCtx: RefContext,
  workflowRunId: string,
  persist: boolean,
): Promise<AgentResult> {
  // Without persistence there is no row to park in and nothing could ever
  // answer it, so a workflow that reaches an approval in a DB-less
  // harness would hang forever. Fail loudly instead.
  if (!persist) {
    throw new Error(
      `Step "${step.name}" is an approval step, which requires run persistence ` +
        `(the parked approval has nowhere to be recorded without it)`,
    );
  }

  const existing = await getWorkflowApproval(workflowRunId, step.name);
  if (existing?.status === "answered") {
    // The shape is FIXED — every field always present — because
    // `workflow-refs` resolves strictly and a downstream
    // `$steps.<gate>.output.form` must not throw just because this
    // particular answer carried no form.
    const output: ApprovalStepOutput = {
      choice: existing.answerChoice ?? "",
      form: existing.answerForm ?? {},
      itemIds: existing.answeredItemIds ?? [],
      answeredBy: existing.answeredBy,
      answeredAt: (existing.updatedAt ?? new Date()).toISOString(),
    };
    return { success: true, output };
  }
  if (existing?.status === "cancelled") {
    throw new Error(`Step "${step.name}" approval was cancelled`);
  }

  // Not answered — park. `expired` re-parks deliberately: the timeout
  // sweep decides what an expiry MEANS via `onTimeout`, and if the run
  // got here with an expired row the sweep has not applied its policy
  // yet, so re-asking is the conservative reading.
  const itemIds = resolveApprovalItemIds(step, refCtx);
  await parkWorkflowApproval({
    workflowRunId,
    stepName: step.name,
    prompt: step.prompt ?? "",
    choices: step.choices ?? [],
    rbacScope: step.rbacScope ?? null,
    formSchema: step.formSchema ?? null,
    requireItemConsent: step.requireItemConsent ?? false,
    itemIds,
    expiresAt:
      step.timeoutMs !== undefined ? new Date(Date.now() + step.timeoutMs) : null,
  });
  throw new WorkflowSuspendedError(step.name, "approval");
}

/**
 * Resolve the step's `itemsRef` into the ids requiring consent.
 *
 * Tolerant by design, and only in one direction: a ref that resolves to
 * nothing yields an EMPTY set, which the guard reads as a clean gate that
 * may be answered ids-free. That is the correct failure mode — the
 * alternative, treating an unresolvable ref as "everything", would
 * manufacture consent requirements the run cannot satisfy and park the
 * workflow permanently.
 *
 * Accepts an array of strings, or of objects carrying an `id`, since
 * both shapes fall out of real steps.
 */
function resolveApprovalItemIds(step: WorkflowStep, refCtx: RefContext): string[] {
  if (!step.itemsRef) return [];
  let resolved: unknown;
  try {
    resolved = resolveMapping({ items: step.itemsRef }, refCtx).items;
  } catch {
    // A strict-ref miss means the producing step did not run or produced
    // nothing addressable. Empty, per the doc above.
    return [];
  }
  if (!Array.isArray(resolved)) return [];
  return resolved
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : undefined,
    )
    .filter((id): id is string => id !== undefined);
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

/**
 * The exact second argument {@link WorkflowExecutor.resumeWorkflow} wants,
 * projected from a `workflow_runs` row.
 *
 * Exists because there are two resume callers — `answerApproval` and the
 * `WorkflowRunner` daemon — and this projection was being written out by
 * hand at each. That is a shape whose owner is the executor, so a column
 * the resume path starts depending on (C6's `definition_version_id` is the
 * next one) would otherwise have to be remembered at every call site, and
 * missing one is silent: the run resumes with that field `undefined`
 * rather than failing. One projection, one place to update.
 *
 * Typed off the parameter itself, so widening `resumeWorkflow` makes the
 * MAPPER the compile error instead of leaving callers quietly short.
 */
export function resumeArgsFromRow(row: {
  id: string;
  workflowName: string;
  status: string;
  input: Record<string, unknown> | null;
  cursor: WorkflowCursor | null;
  definitionHash: string | null;
  projectId?: string | null;
  userId?: string | null;
  startedAt: Date;
}): Parameters<WorkflowExecutor["resumeWorkflow"]>[1] {
  return {
    id: row.id,
    workflowName: row.workflowName,
    status: row.status,
    input: row.input,
    cursor: row.cursor,
    definitionHash: row.definitionHash,
    projectId: row.projectId,
    userId: row.userId,
    startedAt: row.startedAt,
  };
}
