// workflows.test.ts — 100% line coverage for runtime/workflows.ts
//
// `Workflows.run` is a thin, typed reverse-RPC over `ezcorp/workflows`.
// What matters is the WIRE SHAPE: the SDK sends the BARE workflow name and
// nothing else identity-bearing, because the host applies the
// `<extensionName>:` namespace prefix itself. If the SDK ever started
// sending a pre-namespaced name the host would reject it (`:` is banned in
// the wire name) — these tests pin that contract from the client side.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Workflows, type WorkflowRunAccepted } from "../src/runtime/workflows";
import {
  __resetChannelForTests,
  getChannel,
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
