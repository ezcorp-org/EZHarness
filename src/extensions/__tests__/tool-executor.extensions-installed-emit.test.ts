/**
 * agent-install-ux-polish Phase 2 (D3/D6) — integration coverage for
 * the user-scoped `extensions:installed` bus emit in
 * `ToolExecutor.handlePiDrafts`.
 *
 * Contract under test (spec Phase 2 integration bullet):
 *   - a successful `ezcorp/drafts` `install` action emits EXACTLY ONE
 *     `extensions:installed` carrying `{ userId, extensionId, name }`
 *     where `userId` is the token-resolved installing user (NEVER the
 *     wire),
 *   - a non-`install` action (e.g. `create`) emits NOTHING,
 *   - an `install` that the handler rejects (AuthorInstallError →
 *     JSON-RPC error response) emits NOTHING,
 *   - D6: a throwing bus.emit does NOT fail or change the install
 *     response (best-effort — swallowed + logged).
 *
 * `handleDraftsRpc` is mock.module'd so we drive the handler's
 * response shape deterministically and assert ONLY the executor's
 * post-success emit wiring (the handler's own branches are covered in
 * drafts-handler.test.ts). Provenance is registered for real so the
 * userId comes from the host-issued token exactly as in production.
 */
import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";

// ── Controllable drafts-handler ────────────────────────────────────
let draftsResponse: unknown;
let lastHandlerArgs: { name: string; reqMethod: string; userId: string } | null =
  null;
mock.module("../drafts-handler", () => ({
  handleDraftsRpc: async (
    name: string,
    req: { method: string },
    ctx: { userId: string },
  ) => {
    lastHandlerArgs = { name, reqMethod: req.method, userId: ctx.userId };
    return draftsResponse;
  },
}));

const { ToolExecutor } = await import("../tool-executor");
const { EventBus } = await import("../../runtime/events");
const { registerCallProvenance, _resetCallProvenanceForTests } = await import(
  "../call-provenance"
);
const { createStubPermissionEngine } = await import(
  "../../__tests__/helpers/permission-engine-stub"
);

import type { ExtensionRegistry } from "../registry";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import type { AgentEvents } from "../../types";

function makeRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getManifest: () => ({ schemaVersion: 2, name: "extension-author" }),
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

interface Captured {
  events: Array<{ userId: string; extensionId: string; name: string }>;
}

function setup(opts: { throwingBus?: boolean } = {}): {
  executor: InstanceType<typeof ToolExecutor>;
  bus: InstanceType<typeof EventBus<AgentEvents>>;
  captured: Captured;
} {
  const bus = new EventBus<AgentEvents>();
  const captured: Captured = { events: [] };
  bus.on("extensions:installed", (d) => {
    captured.events.push(d);
    if (opts.throwingBus) throw new Error("listener boom (D6 best-effort)");
  });
  const executor = new ToolExecutor(makeRegistry(), createStubPermissionEngine(), {
    bus,
  });
  return { executor, bus, captured };
}

/** Drive `handlePiDrafts` (the executor seam that owns the emit) with a
 *  real provenance token, mirroring the private-internal cast pattern
 *  the other tool-executor tests use. */
async function callDrafts(
  executor: InstanceType<typeof ToolExecutor>,
  action: string,
  onBehalfOf: string,
): Promise<JsonRpcResponse> {
  const ezCallId = registerCallProvenance({
    onBehalfOf,
    conversationId: "conv-1",
    runId: "run-1",
    parentCallId: null,
    actorExtensionId: "ext-author",
    kind: "tool",
    ownerless: false,
  });
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/drafts",
    params: { action, draftId: "d-1", _meta: { ezCallId } },
  };
  return (
    executor as unknown as {
      handlePiDrafts: (e: string, r: JsonRpcRequest) => Promise<JsonRpcResponse>;
    }
  ).handlePiDrafts("ext-author", req);
}

describe("ToolExecutor.handlePiDrafts — extensions:installed emit (Phase 2)", () => {
  beforeEach(() => _resetCallProvenanceForTests());
  afterEach(() => {
    draftsResponse = undefined;
    lastHandlerArgs = null;
  });

  test("successful install emits exactly one event with the token-resolved userId", async () => {
    const { executor, captured } = setup();
    draftsResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, extensionId: "ext-installed", name: "weather" },
    };

    const resp = await callDrafts(executor, "install", "user-installer");

    expect(resp.error).toBeUndefined();
    expect(captured.events).toEqual([
      { userId: "user-installer", extensionId: "ext-installed", name: "weather" },
    ]);
    // userId came from the provenance token, not the wire.
    expect(lastHandlerArgs?.userId).toBe("user-installer");
  });

  test("non-install action (create) emits NOTHING", async () => {
    const { executor, captured } = setup();
    draftsResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { draftId: "d-1", openUrl: "/extensions/author?prefill=d-1" },
    };

    await callDrafts(executor, "create", "user-installer");
    expect(captured.events).toEqual([]);
  });

  test("install that the handler REJECTS (error response) emits NOTHING", async () => {
    const { executor, captured } = setup();
    draftsResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "VERIFY_FAILED: smoke-test failed" },
    };

    const resp = await callDrafts(executor, "install", "user-installer");
    expect(resp.error?.code).toBe(-32603);
    expect(captured.events).toEqual([]);
  });

  test("install whose result.ok is false emits NOTHING (no false-positive nudge)", async () => {
    const { executor, captured } = setup();
    draftsResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: false, extensionId: "", name: "" },
    };

    await callDrafts(executor, "install", "user-installer");
    expect(captured.events).toEqual([]);
  });

  test("D6: a throwing bus listener does NOT fail or alter the install response", async () => {
    const { executor, captured } = setup({ throwingBus: true });
    draftsResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, extensionId: "ext-installed", name: "weather" },
    };

    const resp = await callDrafts(executor, "install", "user-installer");

    // The install response is returned UNCHANGED — the emit is
    // best-effort and the throw is swallowed (EventBus.emit itself
    // also guards listener throws; the handler's try/catch is the
    // belt-and-braces D6 layer).
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      ok: true,
      extensionId: "ext-installed",
      name: "weather",
    });
    // The listener still observed the event before throwing.
    expect(captured.events.length).toBe(1);
  });

  test("missing bus → install still succeeds, no crash", async () => {
    const executor = new ToolExecutor(
      makeRegistry(),
      createStubPermissionEngine(),
      // no bus option
    );
    draftsResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, extensionId: "ext-installed", name: "weather" },
    };
    const resp = await (
      executor as unknown as {
        handlePiDrafts: (
          e: string,
          r: JsonRpcRequest,
        ) => Promise<JsonRpcResponse>;
      }
    ).handlePiDrafts("ext-author", {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/drafts",
      params: {
        action: "install",
        draftId: "d-1",
        _meta: {
          ezCallId: registerCallProvenance({
            onBehalfOf: "user-installer",
            conversationId: "conv-1",
            runId: null,
            parentCallId: null,
            actorExtensionId: "ext-author",
            kind: "tool",
            ownerless: false,
          }),
        },
      },
    });
    expect(resp.error).toBeUndefined();
  });
});

afterAll(() => restoreModuleMocks());
