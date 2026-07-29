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
}
