/**
 * Phase 3 regression test for the "stuck chat" fix.
 *
 * Defect 3 was triaged as ENVIRONMENTAL: under external Postgres
 * (`DATABASE_URL` → drizzle-orm/bun-sql with the identity jsonb mapper)
 * `createDraft`'s `INSERT … RETURNING` of a populated jsonb `payload`
 * object could wedge at the driver layer — no row written, no error,
 * the `ezcorp/drafts.create` reverse-RPC never settling. The query
 * itself is correct (see the regression note on `createDraft`); the
 * DURABLE guardrail is Phase 1's bounded host reverse-RPC dispatch.
 *
 * This test proves that contract end-to-end through the REAL
 * `ToolExecutor` `ezcorp/drafts` route + the REAL drafts handler +
 * REAL call-provenance, with ONLY `createDraft` mocked to reproduce the
 * stall (never resolves). It asserts the stalled create becomes a fast,
 * visible `-32603` within the Phase-1 bound — NOT a 90s frozen chat,
 * and NOT the watchdog.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// Mock ONLY createDraft to reproduce the external-PG stall (a promise
// that never settles — exactly what the driver wedge looked like). The
// rest of the drafts handler + tool-executor route run for real.
mock.module("../db/queries/ez-drafts", () => ({
  createDraft: () => new Promise(() => {}), // never resolves — the stall
  consumeDraft: async () => undefined,
  discardDraftAndDir: async () => ({ ok: true }),
  getDraft: async () => undefined,
  getExtensionAuthorDraftDir: () => "/tmp/d",
  listActiveDraftsForUser: async () => [],
}));

import { ToolExecutor } from "../extensions/tool-executor";
import { HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS } from "../extensions/tool-executor";
import { registerCallProvenance } from "../extensions/call-provenance";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { ExtensionProcess } from "../extensions/subprocess";
import type { JsonRpcRequest, JsonRpcResponse } from "../extensions/types";
import type { ExtensionRegistry } from "../extensions/registry";

// ── setTimeout capture (host bound) ────────────────────────────────────

let originalSetTimeout: typeof setTimeout;
let originalClearTimeout: typeof clearTimeout;
let captured: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }>;
let nextId: number;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  captured = [];
  nextId = 1;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number) => {
    const id = nextId++;
    captured.push({ id, fn: () => fn(), ms: ms ?? 0, cleared: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => {
    const rec = captured.find((t) => t.id === h);
    if (rec) rec.cleared = true;
  }) as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function fireHostBound(): void {
  const rec = captured.find(
    (t) => !t.cleared && t.ms === HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
  );
  if (!rec) throw new Error("host bound timer not armed");
  rec.cleared = true;
  rec.fn();
}

const tick = () => new Promise<void>((r) => originalSetTimeout(r, 0));
async function waitFor(cond: () => boolean, label = "cond"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function makeStubProc(): {
  installedRequestHandler:
    | ((req: JsonRpcRequest) => Promise<JsonRpcResponse>)
    | null;
} & ExtensionProcess {
  const proc: {
    installedRequestHandler:
      | ((req: JsonRpcRequest) => Promise<JsonRpcResponse>)
      | null;
    setRequestHandler: (
      h: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
    ) => void;
    setNotificationHandler: (h: (n: unknown) => void) => void;
  } = {
    installedRequestHandler: null,
    setRequestHandler(h) {
      proc.installedRequestHandler = h;
    },
    setNotificationHandler() {},
  };
  return proc as unknown as typeof proc & ExtensionProcess;
}

// Registry granting `extension-author` the drafts capability for the
// `extension` kind — the real handler's allowlist + grant gates pass so
// it actually reaches the (stalled) createDraft.
function makeRegistry(): ExtensionRegistry {
  return {
    getGrantedPermissions: () => ({
      grantedAt: {},
      custom: { drafts: { kinds: ["extension"] } },
    }),
    getManifest: () => ({ schemaVersion: 2, name: "extension-author" }),
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

describe("Phase 3 regression: createDraft stall is bounded by Phase 1 (fast visible error, no 90s hang)", () => {
  test("a stalled createDraft → ezcorp/drafts.create replies -32603 within the host bound", async () => {
    const startedAt = Date.now();
    const executor = new ToolExecutor(
      makeRegistry(),
      createStubPermissionEngine(),
    );
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("extension-author", proc);
    const handler = proc.installedRequestHandler!;

    // Real host-issued provenance token (the subprocess echoes it back
    // on _meta.ezCallId — it cannot manufacture identity).
    const ezCallId = registerCallProvenance({
      onBehalfOf: "user-1",
      conversationId: "conv-1",
      runId: "run-1",
      parentCallId: null,
      actorExtensionId: "extension-author",
      kind: "tool",
      ownerless: false,
    });

    const respPromise = handler({
      jsonrpc: "2.0",
      id: 101,
      method: "ezcorp/drafts",
      params: {
        action: "create",
        kind: "extension",
        payload: { name: "demo", type: "tool", mode: "author" },
        _meta: { ezCallId },
      },
    });

    // The real handler runs: allowlist OK → grant OK → handleCreate →
    // createDraft (mocked: never resolves). It's now stuck exactly like
    // prod. The Phase-1 bound is the only thing that can settle it.
    await waitFor(
      () =>
        captured.some(
          (t) => !t.cleared && t.ms === HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
        ),
      "host bound armed",
    );
    fireHostBound();

    const resp = await respPromise;
    const elapsed = Date.now() - startedAt;

    // Fast, visible -32603 — NOT a hang, NOT the 90s watchdog.
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(
      /Host handler for "ezcorp\/drafts" timed out after \d+ms/,
    );
    expect("result" in resp).toBe(false);
    expect(elapsed).toBeLessThan(90_000);
    // The bound is comfortably below the 90s watchdog idle threshold.
    expect(HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS).toBeLessThan(90_000);
  });

  test("the bound only fires for a STALL — a fast (rejected-grant) drafts call is untouched", async () => {
    // Same route, but the grant gate fails fast (no custom.drafts.kinds)
    // → the real handler returns -32603 'not granted' immediately,
    // distinct from the timeout message. Proves the wrapper doesn't
    // alter the healthy/short rejection path.
    const executor = new ToolExecutor(
      {
        getGrantedPermissions: () => ({ grantedAt: {} }), // no custom.drafts
        getManifest: () => ({ schemaVersion: 2, name: "extension-author" }),
        getInstallPath: () => "/tmp/ext",
        getRegisteredTool: () => null,
      } as unknown as ExtensionRegistry,
      createStubPermissionEngine(),
    );
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("extension-author", proc);
    const handler = proc.installedRequestHandler!;

    const ezCallId = registerCallProvenance({
      onBehalfOf: "user-1",
      conversationId: "conv-1",
      runId: "run-1",
      parentCallId: null,
      actorExtensionId: "extension-author",
      kind: "tool",
      ownerless: false,
    });

    const resp = await handler({
      jsonrpc: "2.0",
      id: 102,
      method: "ezcorp/drafts",
      params: {
        action: "create",
        kind: "extension",
        payload: { name: "x" },
        _meta: { ezCallId },
      },
    });

    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/custom\.drafts\.kinds not granted/);
    expect(resp.error?.message).not.toMatch(/timed out after/);
  });
});
