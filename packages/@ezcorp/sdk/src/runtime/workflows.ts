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
// with the `workflow:start` / `workflow:step` / `workflow:complete` /
// `workflow:error` bus events (subscribe via `permissions.eventSubscriptions`)
// — `workflow:start` carries both the run id and the workflow name.

import { getChannel } from "./channel";

export interface WorkflowRunAccepted {
  v: 1;
  /** The fully-namespaced name the host resolved (`<extensionName>:<name>`). */
  workflow: string;
  /** Always `true` — the run was accepted and started. There is no run id
   *  here on purpose: the host would have to await the whole graph to learn
   *  it, so correlate on the `workflow:start` event instead. */
  started: true;
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
  ): Promise<WorkflowRunAccepted> {
    return getChannel().request<WorkflowRunAccepted>("ezcorp/workflows", {
      v: 1,
      workflow: name,
      input,
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
}
