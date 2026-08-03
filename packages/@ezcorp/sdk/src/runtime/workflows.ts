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

import { getChannel } from "./channel";

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
