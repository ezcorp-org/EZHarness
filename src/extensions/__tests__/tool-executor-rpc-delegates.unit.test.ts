// Focused coverage for the reverse-RPC delegate bodies in
// `tool-executor/rpc-handlers.ts` (and the provenance resolvers they call)
// that no other in-coverage suite drives to completion. The downstream
// per-capability handlers are mock.module'd so we exercise ONLY the executor
// delegate wiring (grant/provenance resolution → ctx build → delegate call →
// post-success emit) deterministically, with no DB. Their own branches are
// covered by their dedicated *-handler tests.
//
// Covers: handlePiLlmComplete / handlePiSchedule success returns,
// handlePiGithubProjects ctx build, handlePiFinalizeToolCall (→ the shared
// resolveHandlerScope resolver), handlePiStorage's actorExtensionId tripwire
// (→ resolveStorageProvenance), handlePiAppendMessage's run:turn_saved emit,
// and handlePiDrafts's best-effort emit try/catch (a throwing bus.emit).

import {
  test,
  expect,
  describe,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";

// Snapshot the real modules before mocking so afterAll can re-register them.
const REAL_LLM = { ...(await import("../llm-handler")) };
const REAL_SCHEDULE = { ...(await import("../schedule-handler")) };
const REAL_GH = { ...(await import("../github-projects-handler")) };
const REAL_FINALIZE = { ...(await import("../finalize-tool-call-handler")) };
const REAL_STORAGE = { ...(await import("../storage-handler")) };
const REAL_APPEND = { ...(await import("../append-message-handler")) };
const REAL_DRAFTS = { ...(await import("../drafts-handler")) };

const okResponse = (id: number | string) => ({ jsonrpc: "2.0", id, result: { ok: true } });

mock.module("../llm-handler", () => ({
  handlePiLlmComplete: async (req: { id: number | string }) => okResponse(req.id),
}));
mock.module("../schedule-handler", () => ({
  handlePiSchedule: async (req: { id: number | string }) => okResponse(req.id),
}));
mock.module("../github-projects-handler", () => ({
  handleGithubProjectsRpc: async (_verb: string, req: { id: number | string }) => okResponse(req.id),
}));
mock.module("../finalize-tool-call-handler", () => ({
  handleFinalizeToolCallRpc: async (_e: string, req: { id: number | string }) => okResponse(req.id),
}));
mock.module("../storage-handler", () => ({
  handleStorageRpc: async (_e: string, req: { id: number | string }) => okResponse(req.id),
}));
mock.module("../append-message-handler", () => ({
  handleAppendMessageRpc: async (_e: string, req: { id: number | string }) => ({
    jsonrpc: "2.0",
    id: req.id,
    result: { messageId: "m-1" },
  }),
}));
mock.module("../drafts-handler", () => ({
  handleDraftsRpc: async (_name: string, req: { id: number | string }) => ({
    jsonrpc: "2.0",
    id: req.id,
    result: { ok: true, extensionId: "ext-installed", name: "weather" },
  }),
}));

const { ToolExecutor } = await import("../tool-executor");
const { EventBus } = await import("../../runtime/events");
const { registerCallProvenance, releaseCallProvenance, _resetCallProvenanceForTests } =
  await import("../call-provenance");
const { _resetToolCallsCounterForTests } = await import("../tool-executor");
const { createStubPermissionEngine } = await import(
  "../../__tests__/helpers/permission-engine-stub"
);

import type { ExtensionRegistry } from "../registry";
import type { JsonRpcResponse } from "../types";
import type { AgentEvents } from "../../types";

function registry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getManifest: () => ({ schemaVersion: 2, name: "ext" }),
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

function tokenFor(actorExtensionId: string): string {
  return registerCallProvenance({
    onBehalfOf: "user-1",
    conversationId: "conv-1",
    runId: null,
    parentCallId: null,
    actorExtensionId,
    kind: "tool",
    ownerless: false,
  });
}

type ExecLike = InstanceType<typeof ToolExecutor>;

describe("reverse-RPC delegate bodies (downstream handlers mocked)", () => {
  beforeEach(() => {
    _resetCallProvenanceForTests();
    _resetToolCallsCounterForTests();
  });

  test("handlePiLlmComplete resolves grant + token then delegates", async () => {
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"));
    const tok = tokenFor("ext-1");
    try {
      const resp = (await exec.handlePiLlmComplete("ext-1", {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/llm-complete",
        params: { _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.result).toEqual({ ok: true });
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiSchedule resolves grant + token then delegates", async () => {
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"));
    const tok = tokenFor("ext-1");
    try {
      const resp = (await exec.handlePiSchedule("ext-1", {
        jsonrpc: "2.0",
        id: 2,
        method: "ezcorp/schedule",
        params: { action: "fire-now", _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.result).toEqual({ ok: true });
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiGithubProjects builds the verb ctx then delegates", async () => {
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"));
    const tok = tokenFor("ext-1");
    try {
      const resp = (await exec.handlePiGithubProjects("ext-1", {
        jsonrpc: "2.0",
        id: 3,
        method: "ezcorp/github-projects.listBoards",
        params: { _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.result).toEqual({ ok: true });
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiFinalizeToolCall resolves the handler scope then delegates", async () => {
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"));
    const tok = tokenFor("ext-1");
    try {
      const resp = (await exec.handlePiFinalizeToolCall("ext-1", {
        jsonrpc: "2.0",
        id: 4,
        method: "ezcorp/finalize-tool-call",
        params: { _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.result).toEqual({ ok: true });
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiStorage logs the actorExtensionId tripwire on a mismatched token", async () => {
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"));
    // Token minted for a DIFFERENT actor than the resolving extension → the
    // resolveStorageProvenance tripwire warns (defense-in-depth) but proceeds.
    const tok = tokenFor("some-other-ext");
    try {
      const resp = (await exec.handlePiStorage("ext-1", {
        jsonrpc: "2.0",
        id: 5,
        method: "ezcorp/storage",
        params: { _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect(resp.result).toEqual({ ok: true });
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiAppendMessage emits run:turn_saved after a successful append", async () => {
    const bus = new EventBus<AgentEvents>();
    const saved: Array<{ messageId: string }> = [];
    bus.on("run:turn_saved", (d) => saved.push(d as { messageId: string }));
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"), {
      bus,
    });
    const tok = tokenFor("ext-1");
    try {
      const resp = (await exec.handlePiAppendMessage("ext-1", {
        jsonrpc: "2.0",
        id: 6,
        method: "ezcorp/append-message",
        params: { content: "hi", _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      expect((resp.result as { messageId: string }).messageId).toBe("m-1");
      expect(saved.length).toBe(1);
      expect(saved[0]?.messageId).toBe("m-1");
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("handlePiDrafts swallows a throwing bus.emit on the best-effort install nudge", async () => {
    // A bus whose emit THROWS drives the handler's belt-and-braces try/catch
    // (EventBus.emit itself guards listener throws, so a real bus never
    // exercises this arm). `on` is a no-op so constructor wiring is inert.
    let warned = false;
    const throwingBus = {
      on: () => {},
      emit: () => {
        throw new Error("emit boom");
      },
    } as unknown as InstanceType<typeof EventBus<AgentEvents>>;
    const exec: ExecLike = new ToolExecutor(registry(), createStubPermissionEngine("allow-all"), {
      bus: throwingBus,
    });
    const tok = tokenFor("ext-1");
    try {
      const resp = (await exec.handlePiDrafts("ext-1", {
        jsonrpc: "2.0",
        id: 7,
        method: "ezcorp/drafts",
        params: { action: "install", draftId: "d-1", _meta: { ezCallId: tok } },
      })) as JsonRpcResponse;
      // The install response is returned UNCHANGED — the emit throw is swallowed.
      expect(resp.error).toBeUndefined();
      expect((resp.result as { ok: boolean }).ok).toBe(true);
      warned = true;
    } finally {
      releaseCallProvenance(tok);
    }
    expect(warned).toBe(true);
  });
});

afterAll(() => {
  mock.module("../llm-handler", () => REAL_LLM);
  mock.module("../schedule-handler", () => REAL_SCHEDULE);
  mock.module("../github-projects-handler", () => REAL_GH);
  mock.module("../finalize-tool-call-handler", () => REAL_FINALIZE);
  mock.module("../storage-handler", () => REAL_STORAGE);
  mock.module("../append-message-handler", () => REAL_APPEND);
  mock.module("../drafts-handler", () => REAL_DRAFTS);
  restoreModuleMocks();
});
