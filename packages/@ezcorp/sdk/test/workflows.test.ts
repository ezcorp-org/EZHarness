// workflows.test.ts — 100% line coverage for runtime/workflows.ts
//
// `Workflows.run` is a thin, typed reverse-RPC over `ezcorp/workflows`.
// What matters is the WIRE SHAPE: the SDK sends the BARE workflow name and
// nothing else identity-bearing, because the host applies the
// `<extensionName>:` namespace prefix itself. If the SDK ever started
// sending a pre-namespaced name the host would reject it (`:` is banned in
// the wire name) — these tests pin that contract from the client side.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  Workflows,
  type DelegatedWorkflowRunAccepted,
  type WorkflowRunAccepted,
} from "../src/runtime/workflows";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

function spyRequest(result: unknown = { v: 1, workflow: "ext:deploy", started: true }) {
  const ch: HostChannel = getChannel();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation((async (method: string, params: unknown) => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    return result;
  }) as HostChannel["request"]);
  return { calls, spy };
}

describe("Workflows.run", () => {
  test("sends { v:1, workflow, input } over ezcorp/workflows", async () => {
    const { calls, spy } = spyRequest();

    await new Workflows().run("deploy", { ref: "main" });

    expect(calls[0]?.method).toBe("ezcorp/workflows");
    expect(calls[0]?.params).toEqual({
      v: 1,
      workflow: "deploy",
      input: { ref: "main" },
    });
    spy.mockRestore();
  });

  test("defaults input to an empty object", async () => {
    const { calls, spy } = spyRequest();

    await new Workflows().run("deploy");

    expect(calls[0]?.params).toEqual({ v: 1, workflow: "deploy", input: {} });
    spy.mockRestore();
  });

  test("sends the BARE name verbatim — the host owns the namespace prefix", async () => {
    const { calls, spy } = spyRequest();

    await new Workflows().run("deploy");

    expect(calls[0]?.params.workflow).toBe("deploy");
    expect(String(calls[0]?.params.workflow)).not.toContain(":");
    spy.mockRestore();
  });

  test("returns the host's acceptance envelope", async () => {
    const { spy } = spyRequest({ v: 1, workflow: "my-ext:deploy", started: true });

    const res: WorkflowRunAccepted = await new Workflows().run("deploy");

    expect(res).toEqual({ v: 1, workflow: "my-ext:deploy", started: true });
    spy.mockRestore();
  });

  test("propagates a host refusal to the caller (never swallowed)", async () => {
    // A denied trigger — ungranted name, quota exhausted, or an ownerless
    // background fire — must surface, not silently no-op.
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async () => {
      throw new Error("workflow-not-granted");
    }) as HostChannel["request"]);

    await expect(new Workflows().run("deploy")).rejects.toThrow("workflow-not-granted");
    spy.mockRestore();
  });
});

// ── runFor (C3) — the delegated fire ─────────────────────────────────
//
// Two things matter from the client side and neither is observable from
// the host: WHICH METHOD the frame goes to, and WHAT IS NOT IN IT.
//
// The method, because `op: "runFor"` is admitted only on
// `ezcorp/workflows-delegated`; sending it to `ezcorp/workflows` is not a
// slower route to the same place, it is `WORKFLOWS_BAD_OP`.
//
// The absent fields, because the whole security argument of the feature is
// that "run this as somebody else" has no representation on the wire. A
// host-side test cannot see an SDK that started volunteering an owner
// field — the host would simply ignore it while the SDK's users learned to
// pass it. These tests are the client-side half of that pin; the
// source-text half lives in
// `src/extensions/__tests__/workflows-sdk-runfor-shape.test.ts`.
describe("Workflows.runFor", () => {
  const ACCEPTED = { v: 1, workflow: "org-nightly", runAs: "user", started: true };

  test("sends { v:1, op:'runFor', jobRef, input } over ezcorp/workflows-delegated", async () => {
    const { calls, spy } = spyRequest(ACCEPTED);

    await new Workflows().runFor({ jobRef: "job-1", input: { ref: "main" } });

    expect(calls[0]?.method).toBe("ezcorp/workflows-delegated");
    expect(calls[0]?.params).toEqual({
      v: 1,
      op: "runFor",
      jobRef: "job-1",
      input: { ref: "main" },
    });
    spy.mockRestore();
  });

  test("NEVER goes to ezcorp/workflows — that method answers this op with WORKFLOWS_BAD_OP", async () => {
    const { calls, spy } = spyRequest(ACCEPTED);

    await new Workflows().runFor({ jobRef: "job-1" });

    expect(calls[0]?.method).not.toBe("ezcorp/workflows");
    spy.mockRestore();
  });

  test("the frame carries NO owner/user/principal key and NO workflow key", async () => {
    // `Object.keys`, not `toEqual`: a key present-and-undefined would pass
    // an equality check (JSON erases it over the subprocess channel) while
    // an in-process caller saw it. The key list is what catches a field
    // that was added and then only sometimes populated.
    const { calls, spy } = spyRequest(ACCEPTED);

    await new Workflows().runFor({ jobRef: "job-1" });

    expect(Object.keys(calls[0]!.params).sort()).toEqual(["input", "jobRef", "op", "v"]);
    for (const forbidden of ["user", "userId", "owner", "ownerId", "runAs", "workflow"]) {
      expect(forbidden in calls[0]!.params).toBe(false);
    }
    spy.mockRestore();
  });

  test("defaults input to an empty object rather than omitting it", async () => {
    const { calls, spy } = spyRequest(ACCEPTED);

    await new Workflows().runFor({ jobRef: "job-1" });

    expect(calls[0]?.params.input).toEqual({});
    spy.mockRestore();
  });

  test("sends the jobRef VERBATIM — a rewritten handle selects the wrong authority", async () => {
    // The host rejects a malformed ref rather than trimming it, precisely
    // so that a ref never quietly becomes a different, valid one. An SDK
    // that normalised on the way out would defeat that.
    const { calls, spy } = spyRequest(ACCEPTED);

    await new Workflows().runFor({ jobRef: "Nightly.Report:2026-08" });

    expect(calls[0]?.params.jobRef).toBe("Nightly.Report:2026-08");
    spy.mockRestore();
  });

  test("returns the host's envelope, runAs intact", async () => {
    const { spy } = spyRequest({
      v: 1,
      workflow: "org-nightly",
      runAs: "service",
      started: true,
    });

    const res: DelegatedWorkflowRunAccepted = await new Workflows().runFor({ jobRef: "j" });

    expect(res).toEqual({ v: 1, workflow: "org-nightly", runAs: "service", started: true });
    spy.mockRestore();
  });

  test("propagates a host refusal with its structured reason (never swallowed)", async () => {
    // The reason is the whole remedy path: `DELEGATION_DISABLED_ROW` means
    // "tell the user why it stopped", `DELEGATION_DISABLED` means "an
    // operator turned the feature off, try the next tick". An SDK that
    // flattened these to a boolean failure would make them the same event.
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async () => {
      throw new JsonRpcError(-32001, "delegated workflow runs are disabled", {
        reason: "DELEGATION_DISABLED",
      });
    }) as HostChannel["request"]);

    const err = await new Workflows()
      .runFor({ jobRef: "job-1" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JsonRpcError);
    expect((err as JsonRpcError).code).toBe(-32001);
    expect((err as JsonRpcError).data).toEqual({ reason: "DELEGATION_DISABLED" });
    spy.mockRestore();
  });
});

describe("Workflows.pendingApprovals", () => {
  const RELAY = {
    stop: true,
    directive: "RELAY THIS TO THE USER VERBATIM…",
    text: "RELAY THIS TO THE USER VERBATIM…\n\nWorkflow **ext:deploy**…",
    items: ["a.ts"],
  };

  test("sends { v:1, op:'approvals' } and nothing else — the read names no workflow", async () => {
    // Deliberately no `workflow` field: the read is scoped host-side to
    // the extension's GRANTED names, so a name on the wire could only
    // ever narrow it or be ignored, and either would be a second opinion
    // about what this extension owns.
    const { calls, spy } = spyRequest({ v: 1, approvals: [] });

    await new Workflows().pendingApprovals();

    expect(calls[0]?.method).toBe("ezcorp/workflows");
    expect(calls[0]?.params).toEqual({ v: 1, op: "approvals" });
    spy.mockRestore();
  });

  test("returns the host's envelope with the relay intact", async () => {
    const { spy } = spyRequest({
      v: 1,
      approvals: [
        {
          approvalId: "ap-1",
          workflowRunId: "run-1",
          workflowName: "my-ext:deploy",
          stepName: "gate",
          choices: ["approve", "reject"],
          requireItemConsent: true,
          itemIds: ["a.ts"],
          expiresAt: null,
          relay: RELAY,
        },
      ],
    });

    const res = await new Workflows().pendingApprovals();

    expect(res.approvals).toHaveLength(1);
    // The relay is the point of the read — an LLM cannot be handed the
    // items without the instruction not to decide on the user's behalf.
    expect(res.approvals[0]?.relay.directive).toContain("VERBATIM");
    expect(res.approvals[0]?.relay.items).toEqual(["a.ts"]);
    spy.mockRestore();
  });

  test("propagates a host refusal (never swallowed into an empty list)", async () => {
    // An empty list means "nothing is waiting on you", which is the exact
    // opposite of "we could not ask".
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async () => {
      throw new Error("Extension not wired to this conversation");
    }) as HostChannel["request"]);

    await expect(new Workflows().pendingApprovals()).rejects.toThrow("not wired");
    spy.mockRestore();
  });
});

describe("Workflows.runs", () => {
  const RUN = {
    workflowRunId: "run-1",
    workflowName: "my-ext:deploy",
    status: "awaiting_approval",
    projectId: "p-1",
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: null,
    suspendedReason: "approval",
    resumable: false,
  };

  test("sends { v:1, op:'runs' } with NO filters when called bare", async () => {
    const { calls, spy } = spyRequest({ v: 1, runs: [] });

    await new Workflows().runs();

    expect(calls[0]?.method).toBe("ezcorp/workflows");
    // `Object.keys`, not `toEqual`: `toEqual` treats `{workflow: undefined}`
    // as equal to `{}`, so it would NOT catch a refactor that started
    // sending the key set to undefined. The key list does.
    expect(Object.keys(calls[0]!.params).sort()).toEqual(["op", "v"]);
    expect(calls[0]?.params).toEqual({ v: 1, op: "runs" });
    spy.mockRestore();
  });

  test("an empty query object OMITS every filter key, rather than sending undefined", async () => {
    // An unset filter must be ABSENT. The host branches on
    // `params.<field> !== undefined` to tell "no filter" from a
    // present-but-invalid value it rejects, so a key that is present and
    // undefined is relying on JSON serialization to erase it — true over
    // the subprocess channel, not true for an in-process caller.
    const { calls, spy } = spyRequest({ v: 1, runs: [] });

    await new Workflows().runs({});

    expect(Object.keys(calls[0]!.params).sort()).toEqual(["op", "v"]);
    expect("workflow" in calls[0]!.params).toBe(false);
    expect("status" in calls[0]!.params).toBe(false);
    expect("limit" in calls[0]!.params).toBe(false);
    spy.mockRestore();
  });

  test("forwards each filter only when the caller set it", async () => {
    const { calls, spy } = spyRequest({ v: 1, runs: [] });

    await new Workflows().runs({ workflow: "deploy", status: "error", limit: 5 });

    expect(calls[0]?.params).toEqual({
      v: 1,
      op: "runs",
      workflow: "deploy",
      status: "error",
      limit: 5,
    });
    spy.mockRestore();
  });

  test.each([
    ["workflow", { workflow: "deploy" }],
    ["status", { status: "success" }],
    ["limit", { limit: 1 }],
  ])("forwarding %s alone leaves the other keys absent", async (key, query) => {
    const { calls, spy } = spyRequest({ v: 1, runs: [] });

    await new Workflows().runs(query);

    expect(Object.keys(calls[0]!.params).sort()).toEqual(["op", "v", key].sort());
    spy.mockRestore();
  });

  test("sends the BARE name verbatim — the host owns the namespace prefix", async () => {
    const { calls, spy } = spyRequest({ v: 1, runs: [] });

    await new Workflows().runs({ workflow: "deploy" });

    expect(calls[0]?.params.workflow).toBe("deploy");
    expect(String(calls[0]?.params.workflow)).not.toContain(":");
    spy.mockRestore();
  });

  test("returns the host's envelope, run ids intact", async () => {
    // The run id is the entire point: `run()` does not return one and the
    // `workflow:*` events cannot reach an extension, so this is the only
    // way a trigger is ever correlated with its run.
    const { spy } = spyRequest({ v: 1, runs: [RUN] });

    const res = await new Workflows().runs();

    expect(res.v).toBe(1);
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]?.workflowRunId).toBe("run-1");
    expect(res.runs[0]?.status).toBe("awaiting_approval");
    expect(res.runs[0]?.finishedAt).toBeNull();
    expect(res.runs[0]?.suspendedReason).toBe("approval");
    spy.mockRestore();
  });

  test("propagates a host refusal (never swallowed into an empty list)", async () => {
    // An empty list means "nothing ran", which is the exact opposite of
    // "we could not look" — and an extension polling for completion would
    // read the difference as a run that vanished.
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation((async () => {
      throw new Error("'limit' must be an integer 1..50");
    }) as HostChannel["request"]);

    await expect(new Workflows().runs({ limit: 999 })).rejects.toThrow("must be an integer");
    spy.mockRestore();
  });
});
