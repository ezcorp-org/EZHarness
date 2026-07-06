// rbac.test.ts — 100% coverage for runtime/rbac.ts
//
// `Rbac` is a typed client over the `ezcorp/rbac-check` reverse RPC. We
// spy `getChannel().request` (mirroring search.test.ts / memory.test.ts)
// to assert the wire shape and to feed synthetic results / errors. The
// notable branches: `granted: true` → true, everything else (false,
// malformed, missing) → false fail-closed, and transport errors
// (unknown scope -32602, unresolved provenance, ownerless fire)
// propagate as-is — a deny is a value, an authoring bug is a throw.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Rbac } from "../src/runtime/rbac";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: Record<string, unknown>;
}

function stubRequest(impl: (call: RequestCall) => Promise<unknown>): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation((async (method: string, params: unknown) => {
    const call: RequestCall = { method, params: (params ?? {}) as Record<string, unknown> };
    calls.push(call);
    return impl(call);
  }) as HostChannel["request"]);
  return { calls };
}

describe("Rbac.check", () => {
  test("sends { scope } on ezcorp/rbac-check and resolves true for granted:true", async () => {
    const { calls } = stubRequest(async () => ({ granted: true }));
    const granted = await new Rbac().check("write-tickets");
    expect(calls[0]?.method).toBe("ezcorp/rbac-check");
    expect(calls[0]?.params).toEqual({ scope: "write-tickets" });
    expect(granted).toBe(true);
  });

  test("granted:false resolves false (deny is a value, not an error)", async () => {
    stubRequest(async () => ({ granted: false }));
    expect(await new Rbac().check("approve-runs")).toBe(false);
  });

  test("core verbs go over the same wire shape", async () => {
    const { calls } = stubRequest(async () => ({ granted: true }));
    await new Rbac().check("use");
    expect(calls[0]?.params).toEqual({ scope: "use" });
  });

  test("fail-closed on malformed host replies: only literal true grants", async () => {
    for (const reply of [
      {}, // missing `granted`
      { granted: "true" }, // truthy string is NOT a grant
      { granted: 1 },
      null,
      undefined,
    ]) {
      stubRequest(async () => reply);
      expect(await new Rbac().check("use")).toBe(false);
      __resetChannelForTests();
    }
  });

  test("unknown-scope JsonRpcError (-32602) propagates as-is, naming valid scopes", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(
        -32602,
        "Unknown RBAC scope 'nope' for extension 'github-projects' — valid scopes: use, configure, secrets, approve-runs, manage, write-tickets",
      );
    });
    const err = await new Rbac().check("nope").catch((e) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect((err as JsonRpcError).code).toBe(-32602);
    expect((err as JsonRpcError).message).toContain("valid scopes");
  });

  test("non-JsonRpcError transport failures propagate verbatim", async () => {
    stubRequest(async () => {
      throw new Error("channel down");
    });
    await expect(new Rbac().check("use")).rejects.toThrow(/channel down/);
  });
});
