// ── Workflows — typed client for the ezcorp/workflows reverse RPC ──
//
// Lets an extension trigger a run of a workflow IT SHIPS. Ship the
// definition as a `*.workflow.yaml` file at the root of your extension
// directory; the host discovers it at boot and registers it as
// `<extensionName>:<name>`, alongside the host's own workflows.
//
// Declare every name you intend to trigger in
// `permissions.workflows.names` — the host clamps the install grant to that
// declaration AND re-checks the live manifest on every call, so a name you
// removed from the manifest stops working even if an old grant still lists
// it.
//
// You pass the BARE name (`"deploy"`). The host applies the
// `<extensionName>:` prefix itself, which is why you cannot reach the
// host's workflows or another extension's — the wire has no way to express
// those names.
//
// NON-BLOCKING by design: the host starts the run and returns immediately.
// A workflow with agent steps routinely runs longer than the host's 20s
// reverse-RPC budget, so awaiting it would fail every time. Follow progress
// by POLLING `runs()`, which lists your workflows' runs newest-first with
// their ids and statuses.
//
// Do NOT subscribe to the `workflow:start` / `workflow:step` /
// `workflow:complete` / `workflow:error` bus events: they can never be
// delivered to an extension. The host's event dispatcher drops any payload
// without a top-level string `conversationId`, and a workflow event's
// payload is `{ workflowRun, userId? }` — `WorkflowRun` has no such field.
// Because those four names ARE direct-carrier event types, the host
// ACCEPTS such a subscription at registration and it then never fires:
// registered, silent, forever. `runs()` is the only correlation path.
//
// ── runFor() — the OTHER verb, on the OTHER method (C3) ────────────────
//
// `runFor()` fires a workflow you do NOT ship, as the principal a human
// already consented to. It is a different reverse-RPC METHOD with a
// different ladder behind it, and it is opted into by
// `permissions.workflows.allowDelegated` rather than by `names`. See the
// method's own docs — in particular what its `jobRef` means, which is the
// opposite of what `run()`'s means.

import { getChannel } from "./channel";

/**
 * The reverse-RPC method `runFor` — and ONLY `runFor` — is sent on.
 *
 * A DISTINCT method from `ezcorp/workflows`, host-side and here. The two
 * differ at rung 0: `ezcorp/workflows` refuses an ownerless (cron /
 * webhook) fire before its ladder starts, and a delegated fire is
 * ownerless BY DEFINITION — the whole feature is that the owner comes off
 * a consent record instead of off the caller. Sending `op: "runFor"` to
 * `ezcorp/workflows` is not a slower path to the same place: the host
 * treats it as an unknown op (`WORKFLOWS_BAD_OP`), deliberately, so the
 * looser rung 0 is reachable only by a caller that asked for it by name.
 */
const DELEGATED_WORKFLOWS_METHOD = "ezcorp/workflows-delegated";

/** The `op` discriminator for a delegated fire. The host also reads this
 *  raw value for its kill switch, BEFORE any validation — see
 *  {@link Workflows.runFor}. */
const DELEGATED_OP = "runFor";

export interface WorkflowRunAccepted {
  v: 1;
  /** The fully-namespaced name the host resolved (`<extensionName>:<name>`). */
  workflow: string;
  /** Always `true` — the run was accepted and started. There is no run id
   *  here on purpose: the host would have to await the whole graph to learn
   *  it. Correlate with {@link Workflows.runs} instead. */
  started: true;
}

/** Options for {@link Workflows.run}. */
export interface WorkflowRunOptions {
  /**
   * YOUR correlation handle for this run — a saved job's id, a ticket
   * number, whatever identifies the thing that asked for the work.
   *
   * **This is how you find the run again.** `run()` returns no run id
   * (the host would have to await the whole graph to learn it), so
   * without a handle the only way to match a trigger to a
   * `workflow_runs` row is to guess by timestamp — which is wrong the
   * first time two runs start together. Pass one here and read it back
   * off {@link WorkflowRunSummary.jobRef} in {@link Workflows.runs}.
   *
   * The host stores it verbatim and NEVER resolves or interprets it: it
   * grants nothing, and a run's authorization was decided before this
   * value was read. Id-shaped only — letters, digits, `_ . : -`, first
   * character alphanumeric, at most 128 characters. Anything else is
   * REJECTED, never trimmed: a rewritten handle correlates to the wrong
   * thing.
   */
  jobRef?: string;
}

/**
 * Everything {@link Workflows.runFor} may say. Two fields, and the two
 * that are MISSING are the point of the type.
 *
 * **There is no owner / user / principal field, and there will not be
 * one.** The owner comes off the `workflow_delegations` row the host
 * looks up with your `jobRef`, keyed on the extension id the REGISTRY
 * resolved for you — never off the wire. That is what makes "run this as
 * somebody else" not merely *denied* but INEXPRESSIBLE: there is no field
 * to put a principal in, so a forged or guessed ref matches zero rows
 * instead of matching a row you talked your way into. A denial is a
 * control that can be got wrong; an absent field cannot.
 *
 * **There is no workflow-name field either.** The name is on the
 * delegation row too. A name on the wire would be a second, weaker source
 * of truth for the exact thing the host's ladder authorizes — it would
 * have to be reconciled against the row on every fire, and a reconciliation
 * is another denial that can be got wrong. Deleting the field deletes the
 * question.
 *
 * Both absences are pinned by tests that read this file's source text
 * (`src/extensions/__tests__/workflows-sdk-runfor-shape.test.ts`), because
 * no runtime behaviour can observe a field that was never added.
 */
export interface WorkflowRunForParams {
  /**
   * The delegation's job ref — YOUR handle for the saved job, the one a
   * human named when they consented.
   *
   * **On this method the `jobRef` is NOT the inert correlation handle it
   * is on {@link WorkflowRunOptions.jobRef}, and confusing the two is the
   * one mistake this SDK cannot stop you making.** On `run()` the host's
   * comment is that **ON THIS OP THE HANDLE GRANTS NOTHING** — every rung
   * has already decided whether you may start the workflow and nothing
   * branches on the handle. On `runFor()` the host's comment at the other
   * site is that **here the `jobRef` selects the authority.** It still
   * grants nothing by itself — it names a row that a human wrote, and
   * every rung below re-asks that row's questions against live state —
   * but it decides WHICH row, and therefore which principal, which
   * workflow, and which project.
   *
   * Same shape as everywhere else: id-shaped only — letters, digits,
   * `_ . : -`, first character alphanumeric, at most 128 characters.
   * REJECTED, never trimmed. Required: there is no "default job".
   */
  jobRef: string;
  /**
   * Top-level workflow input (`$input.<field>` in the definition).
   * Defaults to `{}`. A plain JSON object; the host caps the serialized
   * size at 16KB, the same ceiling `run()` gets, from the same check.
   *
   * This is untrusted payload as far as the run is concerned — it is what
   * the delegation's owner's principal will carry into every agent step's
   * prompt — so keep it to the parameters of the job, not to anything you
   * want the run to trust.
   */
  input?: Record<string, unknown>;
}

/**
 * Which principal a delegated run executed as.
 *
 * `"user"` — a person's own delegation: the run is attributed to them,
 * appears in their run history, and streams `workflow:*` events to their
 * session. `"service"` — a service account: durable and unattended, with
 * no session to stream to, so the run trace and the audit row are how it
 * is observed instead. A service account can only reach `system`-visible
 * workflows; a user delegation reaches everything that user can run.
 *
 * You do not choose this — the human did, at consent time. It is echoed
 * back so a job console can show which one fired. Pinned against the
 * host's `DELEGATION_OWNER_COLUMN` by a test, so a third principal kind
 * cannot land host-side while this union still claims there are two.
 */
export type DelegatedRunAs = "user" | "service";

/** What {@link Workflows.runFor} resolves to. */
export interface DelegatedWorkflowRunAccepted {
  v: 1;
  /** The workflow the DELEGATION named — read off the row, echoed back so
   *  you can log what actually fired without having stored it yourself. */
  workflow: string;
  /** The principal the run executes as. See {@link DelegatedRunAs}. */
  runAs: DelegatedRunAs;
  /** Always `true`. No run id, for the same reason {@link
   *  WorkflowRunAccepted} carries none: the host would have to await the
   *  whole graph to learn it. Correlate with {@link Workflows.runs}. */
  started: true;
}

/** One run, as `runs()` reports it. */
export interface WorkflowRunSummary {
  /** The `workflow_runs` row id — what the trace UI and the run-control
   *  routes key on. */
  workflowRunId: string;
  /** Fully-namespaced (`<extensionName>:<name>`). */
  workflowName: string;
  /** `running` | `success` | `error` | `cancelled` | `awaiting_approval`
   *  | `suspended`. */
  status: string;
  projectId: string | null;
  /** ISO timestamps. `finishedAt` is null while the run is live. */
  startedAt: string;
  finishedAt: string | null;
  /** Why a suspended run parked, when it recorded one. */
  suspendedReason: string | null;
  /** Whether the run can be resumed. A run parked on an approval becomes
   *  resumable once somebody answers the gate. */
  resumable: boolean;
  /** The handle YOU passed as {@link WorkflowRunOptions.jobRef} when you
   *  started this run, or `null` for a run started without one (or by
   *  some other surface entirely — the REST route, the CLI). This is the
   *  join key between your own records and the host's run history. */
  jobRef: string | null;
}

export interface WorkflowRunList {
  v: 1;
  /** Newest first. */
  runs: WorkflowRunSummary[];
}

/** Filters for {@link Workflows.runs}. */
export interface WorkflowRunsQuery {
  /** BARE workflow name. Omit for every workflow you are granted. */
  workflow?: string;
  /** One of the six run statuses. Anything else is rejected, not ignored. */
  status?: string;
  /** 1..50. Defaults to 20. */
  limit?: number;
}

/** One parked decision, as `pendingApprovals()` reports it. */
export interface PendingWorkflowApproval {
  /** Pass this to the answer surface — it is what identifies the decision. */
  approvalId: string;
  workflowRunId: string;
  /** Fully-namespaced (`<extensionName>:<name>`). */
  workflowName: string;
  stepName: string;
  /** The answers the definition allows. Anything else is rejected, never
   *  coerced. */
  choices: string[];
  /** When true, an answer must NAME the items it acts on. */
  requireItemConsent: boolean;
  itemIds: string[];
  /** ISO deadline, or null when the step declared no `timeoutMs`. */
  expiresAt: string | null;
  /**
   * The message to put in front of the user, VERBATIM.
   *
   * `text` already leads with the stop-and-relay directive, and `directive`
   * is non-null exactly when `stop` is. Do not paraphrase it, do not
   * summarise the items, and do not answer on the user's behalf — the
   * whole point of this field is that you cannot render the decision
   * without also rendering the instruction not to make it for them.
   */
  relay: { stop: boolean; directive: string | null; text: string; items: string[] };
}

export interface PendingWorkflowApprovals {
  v: 1;
  approvals: PendingWorkflowApproval[];
}

export class Workflows {
  /**
   * Trigger a run of one of this extension's shipped workflows.
   *
   * @param name  BARE workflow name, as declared in your `*.workflow.yaml`
   *              and in `permissions.workflows.names`.
   * @param input Top-level workflow input (`$input.<field>` in the
   *              definition). Must be a plain JSON object; the host caps the
   *              serialized size at 16KB.
   *
   * Rejects with the host's JSON-RPC error when the trigger is refused —
   * ungranted / undeclared name, quota exhausted, not wired to the calling
   * conversation, or (for a cron / webhook fire) no acting user to attribute
   * the run to. Background fires are refused deliberately: a run with no
   * owner is both unattributed and invisible.
   */
  async run(
    name: string,
    input: Record<string, unknown> = {},
    opts: WorkflowRunOptions = {},
  ): Promise<WorkflowRunAccepted> {
    return getChannel().request<WorkflowRunAccepted>("ezcorp/workflows", {
      v: 1,
      workflow: name,
      input,
      // Omitted rather than sent as `undefined`: the host distinguishes
      // "absent" (no handle) from a present-but-invalid value, which it
      // rejects outright instead of silently dropping.
      ...(opts.jobRef !== undefined ? { jobRef: opts.jobRef } : {}),
    });
  }

  /**
   * Fire a workflow you do NOT ship, as the principal a human already
   * consented to (C3).
   *
   * ## What you send, and what you cannot
   *
   * A `jobRef` and an `input`. That is the whole wire — see
   * {@link WorkflowRunForParams} for why the owner and the workflow name
   * are absent rather than validated. Everything that decides what runs
   * and as whom comes off the `workflow_delegations` row the host looks
   * up with that ref, keyed on the extension id the registry resolved for
   * you.
   *
   * ## What you must hold
   *
   * `permissions.workflows.allowDelegated: true` — a SEPARATE opt-in from
   * `names`, and the one shape in which an empty `names` list is legal.
   * The host authorizes it against its own capability kind
   * (`ezcorp:workflows:run-delegated`), which is KIND-ONLY with no value:
   * job refs are minted after install by a human consent action, so an
   * install-time grant could not enumerate them. The per-job bound is the
   * delegation record, which is revocable independently of your grant.
   * Holding the bit authorizes no job by itself.
   *
   * ## Non-blocking, and NOT correlatable through `runs()`
   *
   * Returns the moment the run starts, with no run id, for the same
   * reason {@link run} does. **Unlike `run()`, there is no polling path
   * back to it:** {@link runs} lists runs of the workflows you are
   * GRANTED by name, for the user who is asking, and a delegated fire is
   * by definition neither (a delegated-only grant lists no names, and a
   * cron fire has no asking user — that read refuses with `-32106`). So
   * treat `runFor()` as fire-and-forget: the delegated run is observable
   * on the host's run trace and in the audit trail, not from in here.
   * Record what you fired against your own `jobRef` at the moment you
   * fire it.
   *
   * ## How it fails, and which failures you should act on
   *
   * Rejects with the host's `JsonRpcError`; branch on `err.data.reason`
   * rather than the message. The ones an extension can do something
   * about:
   *
   * - `DELEGATION_NOT_GRANTED` — you do not hold `allowDelegated`. A
   *   permanent, install-shaped problem: stop retrying, tell the user.
   * - `WORKFLOWS_NOT_GRANTED` — the SAME author mistake in its most
   *   likely shape, one rung earlier. `allowDelegated` is what makes an
   *   empty `names` list legal at all, so a delegated-only extension that
   *   drops the bit does not merely lose the delegated tier, its grant
   *   stops being structurally usable and never reaches the rung that
   *   would have said `DELEGATION_NOT_GRANTED`. Handle both, or you will
   *   not recognise the failure you are most likely to cause.
   * - `DELEGATION_BAD_REF` — the ref is not id-shaped. Your bug.
   * - `DELEGATION_NOT_FOUND` — no live delegation for (you, this ref).
   *   Revoked, never created, or the ref is wrong. Permanent until a
   *   human consents again.
   * - `DELEGATION_DISABLED_ROW` — the row is switched off, and the
   *   MESSAGE is the reason the host recorded. It is the only thing the
   *   user will ever read about why their job stopped: surface it
   *   verbatim, do not summarise it.
   * - `DELEGATION_CONSENT_STALE` — the workflow changed since the human
   *   consented. The run was **parked, not executed** (`data.workflowRunId`
   *   names it); the way out is a fresh consent, not a retry.
   * - `DELEGATION_QUOTA_EXCEEDED` / `WORKFLOWS_QUOTA_EXCEEDED` — the
   *   job's daily cap / your hourly cap. Try again later; do not fan out.
   * - `DELEGATION_DISABLED` — an operator has set
   *   `EZCORP_DISABLE_DELEGATED_WORKFLOWS=1`, C3's own kill switch. It is
   *   refused before ANY database work, so nothing was looked up, nothing
   *   was started, and the delegation itself is untouched — it is an
   *   instance-wide, operator-controlled, TRANSIENT refusal, not a
   *   statement about this job. Surface it and let the next tick try; do
   *   not disable or delete anything of your own in response, and do not
   *   fall back to {@link run} (a workflow you do not ship is not yours
   *   to trigger — that call would be refused too, and for a different
   *   reason). Note it is scoped to this verb alone: `run`, `runs` and
   *   `pendingApprovals` keep working while it is set.
   */
  async runFor(params: WorkflowRunForParams): Promise<DelegatedWorkflowRunAccepted> {
    return getChannel().request<DelegatedWorkflowRunAccepted>(DELEGATED_WORKFLOWS_METHOD, {
      v: 1,
      op: DELEGATED_OP,
      jobRef: params.jobRef,
      // Always present, defaulted here rather than omitted — the host
      // treats an absent `input` as `{}` anyway, and sending it makes the
      // frame identical in shape to `run()`'s, which is one less thing
      // for a reader comparing the two ops to have to explain.
      input: params.input ?? {},
    });
  }

  /**
   * The decisions YOUR workflows are currently waiting on, for the user
   * who is asking.
   *
   * This is how a chat-driven workflow gets its question in front of a
   * human. `run()` returns the moment the run STARTS — the approval step
   * is usually minutes away, behind the agent steps that work out what the
   * user is even being asked — so the run's own tool result cannot carry
   * it. Call this from a status/check tool and put `relay.text` in your
   * result verbatim.
   *
   * Scoped twice, host-side: to the acting user (you never see another
   * user's parked decisions, and the prompt routinely names what is about
   * to be done and to what) and to workflows you are granted to run.
   *
   * Does NOT consume your hourly run quota — a status read must never be
   * able to exhaust the budget for the thing it is reporting on. It does
   * share the instantaneous rate limit.
   *
   * Answering is a separate, deliberate act: the user does it from the
   * approvals inbox or the pending-decisions tray. An extension cannot
   * answer on their behalf, which is the same rule every other surface
   * clears.
   */
  async pendingApprovals(): Promise<PendingWorkflowApprovals> {
    return getChannel().request<PendingWorkflowApprovals>("ezcorp/workflows", {
      v: 1,
      op: "approvals",
    });
  }

  /**
   * The runs of YOUR workflows, newest first, for the user who is asking.
   *
   * **This is how you correlate a trigger with its run.** `run()` returns
   * the moment the run STARTS and carries no run id, and the `workflow:*`
   * bus events cannot reach an extension at all (see the header note), so
   * without this there is no way to learn whether the work you started
   * succeeded, failed, or parked on an approval. Poll it.
   *
   * Scoped twice, host-side: to the acting user (you never see runs you
   * did not start on their behalf, and an unowned run is admin-only) and
   * to workflows you are granted to run — so the wire cannot name the
   * host's identically-named workflow, nor another extension's.
   *
   * Rows carry no `input` and no `result`: both are unbounded, and
   * `input` is the untrusted payload surface the run trace redacts. Open
   * the run in the trace UI when you need them.
   *
   * Does NOT consume your hourly run quota — a status poll must never be
   * able to exhaust the budget for the thing it is reporting on. It does
   * share the instantaneous rate limit.
   */
  async runs(query: WorkflowRunsQuery = {}): Promise<WorkflowRunList> {
    return getChannel().request<WorkflowRunList>("ezcorp/workflows", {
      v: 1,
      op: "runs",
      // Omitted rather than sent as `undefined`: the host distinguishes
      // "absent" (every granted name / the default page size) from a
      // present-but-invalid value, which it rejects.
      ...(query.workflow !== undefined ? { workflow: query.workflow } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  }
}
