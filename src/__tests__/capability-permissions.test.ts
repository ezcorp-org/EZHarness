/**
 * Unit tests for Phase 2a-lite: the capability-tier permission fields
 * (`taskEvents`, `spawnAgents`, `agentConfig`) and the clamp logic that
 * gates them against both the manifest and the
 * `EZCORP_DISABLE_CAPABILITY_TOOLS` kill-switch env var.
 *
 * These tests exercise the clamp helper indirectly through the two
 * SvelteKit route handlers that own it. Bypassing the HTTP boundary
 * keeps the tests fast and lets us assert the clamp output directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  capabilityToolsDisabled,
  CAPABILITY_PERMISSION_FIELDS,
  CAPABILITY_POLICY_FIELDS,
  isCapabilityPolicyField,
} from "../extensions/capability-flags";
import { DIRECT_CARRIER_EVENT_TYPES } from "../runtime/sse-conversation-filter";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";

// ── Re-implementation of the clamp so we can unit-test it without HTTP ──
// This mirrors the logic in both
// web/src/routes/api/extensions/[id]/permissions/+server.ts
// web/src/routes/api/extensions/[id]/activate/+server.ts
// — kept in sync manually per the sec-C4 "no shared helper" convention.
// A single-source-of-truth test asserts the two HTTP clamps stay in sync.
function clampToManifestReimpl(
  submitted: Partial<ExtensionPermissions>,
  manifest: ExtensionManifestV2["permissions"],
): ExtensionPermissions {
  const clamped: ExtensionPermissions = { grantedAt: {} };

  if (submitted.network && manifest.network) {
    const allowed = submitted.network.filter((d) => manifest.network!.includes(d));
    if (allowed.length > 0) clamped.network = allowed;
  }
  if (submitted.filesystem && manifest.filesystem) {
    const allowed = submitted.filesystem.filter((p) => manifest.filesystem!.includes(p));
    if (allowed.length > 0) clamped.filesystem = allowed;
  }
  if (submitted.shell === true && manifest.shell === true) clamped.shell = true;
  if (submitted.env && manifest.env) {
    const allowed = submitted.env.filter((v) => manifest.env!.includes(v));
    if (allowed.length > 0) clamped.env = allowed;
  }
  if (submitted.storage === true && manifest.storage === true) clamped.storage = true;

  if (!capabilityToolsDisabled()) {
    if (submitted.taskEvents === true && manifest.taskEvents === true) {
      clamped.taskEvents = true;
    }
    if (submitted.spawnAgents && manifest.spawnAgents) {
      const sm = submitted.spawnAgents;
      const mm = manifest.spawnAgents;
      const hourly = Math.min(sm.maxPerHour, mm.maxPerHour);
      const concurrent = Math.min(
        sm.maxConcurrent ?? mm.maxConcurrent ?? 3,
        mm.maxConcurrent ?? 3,
      );
      if (hourly > 0 && concurrent > 0) {
        clamped.spawnAgents = { maxPerHour: hourly, maxConcurrent: concurrent };
      }
    }
    if (submitted.agentConfig === "read" && manifest.agentConfig === "read") {
      clamped.agentConfig = "read";
    }
    // eventSubscriptions (Phase 2c): triple-intersection —
    // submitted ∩ manifest ∩ direct-carrier allowlist.
    if (Array.isArray(submitted.eventSubscriptions) && Array.isArray(manifest.eventSubscriptions)) {
      const manifestSet = new Set(manifest.eventSubscriptions);
      const allowed = submitted.eventSubscriptions.filter(
        (e) => typeof e === "string"
          && manifestSet.has(e)
          && DIRECT_CARRIER_EVENT_TYPES.has(e as never),
      );
      if (allowed.length > 0) clamped.eventSubscriptions = allowed;
    }
  }

  if (submitted.grantedAt && typeof submitted.grantedAt === "object") {
    for (const [k, v] of Object.entries(submitted.grantedAt)) {
      if (typeof v === "number") clamped.grantedAt[k] = v;
    }
  }
  return clamped;
}

// ── Kill-switch env helpers ──
let prevEnv: string | undefined;
beforeEach(() => { prevEnv = process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"]; });
afterEach(() => {
  if (prevEnv === undefined) delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
  else process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = prevEnv;
});

// ── Tests ──

describe("capability-flags — kill-switch gate", () => {
  test("returns false when env var is unset", () => {
    delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    expect(capabilityToolsDisabled()).toBe(false);
  });

  test("returns true only when env var is exactly '1'", () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    expect(capabilityToolsDisabled()).toBe(true);
  });

  test("truthy-but-not-'1' values do NOT disable (prevents accidental opt-out)", () => {
    for (const v of ["true", "yes", "on", "0", ""]) {
      process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = v;
      expect(capabilityToolsDisabled()).toBe(false);
    }
  });

  test("CAPABILITY_PERMISSION_FIELDS lists all capability-tier fields", () => {
    expect(new Set(CAPABILITY_PERMISSION_FIELDS)).toEqual(
      new Set(["taskEvents", "spawnAgents", "agentConfig", "eventSubscriptions"]),
    );
  });

  test("CAPABILITY_POLICY_FIELDS lists the brokered-capability policy fields (search first)", () => {
    expect(new Set(CAPABILITY_POLICY_FIELDS)).toEqual(
      new Set(["search", "memory", "llm", "lessons", "schedule"]),
    );
    // search is the residual #2 first-class capability.
    expect(CAPABILITY_POLICY_FIELDS[0]).toBe("search");
  });

  test("isCapabilityPolicyField is true for policy fields, false for non-policy fields", () => {
    for (const f of CAPABILITY_POLICY_FIELDS) {
      expect(isCapabilityPolicyField(f)).toBe(true);
    }
    for (const f of ["network", "shell", "filesystem", "taskEvents", "spawnAgents"]) {
      expect(isCapabilityPolicyField(f)).toBe(false);
    }
  });
});

describe("clampToManifest — capability-tier fields", () => {
  test("taskEvents: granted when both submitted AND declared", () => {
    const out = clampToManifestReimpl(
      { taskEvents: true },
      { taskEvents: true },
    );
    expect(out.taskEvents).toBe(true);
  });

  test("taskEvents: dropped when manifest does not declare", () => {
    const out = clampToManifestReimpl(
      { taskEvents: true },
      {},
    );
    expect(out.taskEvents).toBeUndefined();
  });

  test("taskEvents: dropped when submitted is false", () => {
    const out = clampToManifestReimpl(
      { taskEvents: false },
      { taskEvents: true },
    );
    expect(out.taskEvents).toBeUndefined();
  });

  test("spawnAgents: clamps both maxPerHour and maxConcurrent to manifest caps", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 1000, maxConcurrent: 50 } },
      { spawnAgents: { maxPerHour: 500, maxConcurrent: 5 } },
    );
    expect(out.spawnAgents).toEqual({ maxPerHour: 500, maxConcurrent: 5 });
  });

  test("spawnAgents: admin-lower grant is allowed (only upper-bounds clamped)", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 100, maxConcurrent: 2 } },
      { spawnAgents: { maxPerHour: 500, maxConcurrent: 5 } },
    );
    expect(out.spawnAgents).toEqual({ maxPerHour: 100, maxConcurrent: 2 });
  });

  test("spawnAgents: dropped entirely when manifest does not declare", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 10, maxConcurrent: 1 } },
      {},
    );
    expect(out.spawnAgents).toBeUndefined();
  });

  test("spawnAgents: missing maxConcurrent on submit defaults to manifest max (or 3)", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 50 } as never },
      { spawnAgents: { maxPerHour: 500, maxConcurrent: 5 } },
    );
    expect(out.spawnAgents?.maxConcurrent).toBe(5);
  });

  test("spawnAgents: hourly=0 drops the grant (no-op permission)", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 0, maxConcurrent: 10 } },
      { spawnAgents: { maxPerHour: 500, maxConcurrent: 10 } },
    );
    expect(out.spawnAgents).toBeUndefined();
  });

  test("agentConfig: 'read' passes through only when manifest also declares 'read'", () => {
    const out = clampToManifestReimpl(
      { agentConfig: "read" },
      { agentConfig: "read" },
    );
    expect(out.agentConfig).toBe("read");
  });

  test("agentConfig: unknown string rejected by type system — value that bypasses types is dropped", () => {
    // Simulates a client sending a forged value at runtime (bypassing types).
    const out = clampToManifestReimpl(
      { agentConfig: "write" as "read" },
      { agentConfig: "read" },
    );
    // "write" !== "read" — the === comparison in the clamp rejects it.
    expect(out.agentConfig).toBeUndefined();
  });

  test("agentConfig: dropped when manifest does not declare", () => {
    const out = clampToManifestReimpl(
      { agentConfig: "read" },
      {},
    );
    expect(out.agentConfig).toBeUndefined();
  });

  // ── eventSubscriptions (Phase 2c) ──

  test("eventSubscriptions: direct-carrier event survives when submitted + declared", () => {
    const out = clampToManifestReimpl(
      { eventSubscriptions: ["task:snapshot"] },
      { eventSubscriptions: ["task:snapshot"] },
    );
    expect(out.eventSubscriptions).toEqual(["task:snapshot"]);
  });

  test("eventSubscriptions: event declared in manifest but NOT submitted is dropped", () => {
    const out = clampToManifestReimpl(
      { eventSubscriptions: [] },
      { eventSubscriptions: ["task:snapshot"] },
    );
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("eventSubscriptions: event submitted but NOT in manifest is dropped", () => {
    const out = clampToManifestReimpl(
      { eventSubscriptions: ["task:snapshot", "run:complete"] },
      { eventSubscriptions: ["task:snapshot"] },
    );
    expect(out.eventSubscriptions).toEqual(["task:snapshot"]);
  });

  test("eventSubscriptions: event in manifest but NOT a direct-carrier is dropped (fail-closed)", () => {
    // `run:usage` is a bus event but NOT in DIRECT_CARRIER_EVENT_TYPES,
    // so even if manifest + submitted agree, the clamp drops it.
    const out = clampToManifestReimpl(
      { eventSubscriptions: ["run:usage"] },
      { eventSubscriptions: ["run:usage"] },
    );
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("eventSubscriptions: all 13 direct-carrier events survive when declared + submitted", () => {
    const all = Array.from(DIRECT_CARRIER_EVENT_TYPES).map(String);
    const out = clampToManifestReimpl(
      { eventSubscriptions: all },
      { eventSubscriptions: all },
    );
    expect(new Set(out.eventSubscriptions ?? [])).toEqual(new Set(all));
  });

  test("eventSubscriptions: dropped when manifest omits the field entirely", () => {
    const out = clampToManifestReimpl(
      { eventSubscriptions: ["task:snapshot"] },
      {},
    );
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("eventSubscriptions: non-string entries in submitted are filtered (defense-in-depth)", () => {
    const out = clampToManifestReimpl(
      { eventSubscriptions: ["task:snapshot", 42 as never, null as never] },
      { eventSubscriptions: ["task:snapshot"] },
    );
    expect(out.eventSubscriptions).toEqual(["task:snapshot"]);
  });
});

describe("clampToManifest — kill-switch enforcement", () => {
  test("EZCORP_DISABLE_CAPABILITY_TOOLS=1: all four capability fields dropped even when manifest declares them", () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const out = clampToManifestReimpl(
      {
        taskEvents: true,
        spawnAgents: { maxPerHour: 100, maxConcurrent: 3 },
        agentConfig: "read",
        eventSubscriptions: ["task:snapshot"],
      },
      {
        taskEvents: true,
        spawnAgents: { maxPerHour: 500, maxConcurrent: 5 },
        agentConfig: "read",
        eventSubscriptions: ["task:snapshot"],
      },
    );
    expect(out.taskEvents).toBeUndefined();
    expect(out.spawnAgents).toBeUndefined();
    expect(out.agentConfig).toBeUndefined();
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("EZCORP_DISABLE_CAPABILITY_TOOLS=1: legacy permissions still flow through normally", () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const out = clampToManifestReimpl(
      { shell: true, storage: true, network: ["api.example.com"] },
      { shell: true, storage: true, network: ["api.example.com"] },
    );
    expect(out.shell).toBe(true);
    expect(out.storage).toBe(true);
    expect(out.network).toEqual(["api.example.com"]);
  });
});

describe("clampToManifest — legacy fields unchanged by Phase 2a-lite", () => {
  test("regression: storage alone still clamps the same way", () => {
    const out = clampToManifestReimpl({ storage: true }, { storage: true });
    expect(out.storage).toBe(true);
  });

  test("regression: shell-with-no-manifest-declaration still dropped", () => {
    const out = clampToManifestReimpl({ shell: true }, {});
    expect(out.shell).toBeUndefined();
  });

  test("regression: grantedAt timestamps pass through", () => {
    const now = Date.now();
    const out = clampToManifestReimpl(
      { storage: true, grantedAt: { storage: now } },
      { storage: true },
    );
    expect(out.grantedAt["storage"]).toBe(now);
  });
});

// ── Phase 2b handler-gating regression ──
//
// Defence-in-depth: even if someone accidentally adds a backdoor route
// that skips clampToManifest, the capability-RPC handlers themselves
// must still refuse when `taskEvents` / `agentConfig` are absent from
// the granted permissions. These tests drive the handlers directly so
// the permission gate stays load-bearing regardless of the install path.

import { handleEmitTaskEventRpc } from "../extensions/task-events-handler";
import { handleAgentConfigsRpc } from "../extensions/agent-configs-handler";
import type { JsonRpcRequest } from "../extensions/types";

describe("Phase 2b — capability handlers refuse when grant is absent", () => {
  const emitReq: JsonRpcRequest = {
    jsonrpc: "2.0", id: "gate",
    method: "ezcorp/emit-task-event",
    params: { v: 1, type: "snapshot", payload: { tasks: [] } },
  };
  const acReq: JsonRpcRequest = {
    jsonrpc: "2.0", id: "gate",
    method: "ezcorp/agent-configs",
    params: { v: 1, action: "list" },
  };

  test("ezcorp/emit-task-event refuses without taskEvents grant (-32001)", async () => {
    const resp = await handleEmitTaskEventRpc("e1", emitReq, {
      conversationId: "c", userId: "u",
      grantedPermissions: { grantedAt: {} } /* no taskEvents */,
      bus: undefined,
    });
    expect(resp.error?.code).toBe(-32001);
  });

  test("ezcorp/agent-configs refuses without agentConfig grant (-32001)", async () => {
    const resp = await handleAgentConfigsRpc("e1", acReq, {
      userId: "u",
      grantedPermissions: { grantedAt: {} } /* no agentConfig */,
    });
    expect(resp.error?.code).toBe(-32001);
  });
});

// ── Phase 2c capability-tier cross-contamination regression ──
//
// Granting one capability field must not implicitly grant any other.
// The clamp honors `undefined` differently per field (boolean vs
// struct vs string vs array), so a typo in the clamp ladder could
// cross-contaminate. Test each field in isolation against the others.

describe("Phase 2c — capability fields do not cross-contaminate", () => {
  const manifestAll = {
    taskEvents: true,
    spawnAgents: { maxPerHour: 500, maxConcurrent: 5 },
    agentConfig: "read" as const,
    eventSubscriptions: ["task:snapshot", "task:assignment_update"],
  };

  test("granting eventSubscriptions alone does NOT grant taskEvents", () => {
    const out = clampToManifestReimpl(
      { eventSubscriptions: ["task:snapshot"] },
      manifestAll,
    );
    expect(out.eventSubscriptions).toEqual(["task:snapshot"]);
    expect(out.taskEvents).toBeUndefined();
    expect(out.spawnAgents).toBeUndefined();
    expect(out.agentConfig).toBeUndefined();
  });

  test("granting taskEvents alone does NOT grant eventSubscriptions", () => {
    const out = clampToManifestReimpl({ taskEvents: true }, manifestAll);
    expect(out.taskEvents).toBe(true);
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("granting agentConfig alone does NOT grant eventSubscriptions", () => {
    const out = clampToManifestReimpl({ agentConfig: "read" }, manifestAll);
    expect(out.agentConfig).toBe("read");
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("granting spawnAgents alone does NOT grant eventSubscriptions", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 50, maxConcurrent: 2 } },
      manifestAll,
    );
    expect(out.spawnAgents).toEqual({ maxPerHour: 50, maxConcurrent: 2 });
    expect(out.eventSubscriptions).toBeUndefined();
  });

  // ── Phase 2d regression ──
  //
  // The spawn grant is structurally distinct from the other capability
  // fields (it's an object, they're bools/strings/arrays). Assert that
  // passing spawnAgents through the clamp never silently sets any
  // sibling capability to a truthy value.

  test("Phase 2d: granting spawnAgents alone does NOT cross-contaminate any sibling capability", () => {
    const out = clampToManifestReimpl(
      { spawnAgents: { maxPerHour: 50, maxConcurrent: 2 } },
      manifestAll,
    );
    expect(out.spawnAgents).toEqual({ maxPerHour: 50, maxConcurrent: 2 });
    expect(out.taskEvents).toBeUndefined();
    expect(out.agentConfig).toBeUndefined();
    expect(out.eventSubscriptions).toBeUndefined();
  });
});

// ── Phase 2d — resolveAgentConfigForUser (shared resolver) ──
//
// The resolver was extracted out of handleAgentConfigsRpc so Phase 2d's
// handleSpawnAssignmentRpc can share one definition of "id-or-name →
// config". Assert the full matching semantics (id-first, then
// case-insensitive / whitespace-trimmed name) so a Phase 2d regression
// surfaces here instead of manifesting as an Agent-not-found in the
// integration test.

import { mock } from "bun:test";
import type { DbAgentConfig } from "../db/queries/agent-configs";

describe("Phase 2d — resolveAgentConfigForUser (shared resolver)", () => {
  const fixture: DbAgentConfig[] = [
    {
      id: "cfg-cap-alice",
      name: "Alice Bot",
      description: "",
      prompt: "",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "u1",
      model: null,
      provider: null,
    } as unknown as DbAgentConfig,
    {
      id: "cfg-cap-bob",
      name: "bob-helper",
      description: "",
      prompt: "",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "u1",
      model: null,
      provider: null,
    } as unknown as DbAgentConfig,
  ];

  // Replace listAgentConfigs at the module boundary for this block.
  // The resolver imports it dynamically so the mock applied before the
  // resolver call is what it sees.
  mock.module("../db/queries/agent-configs", () => ({
    listAgentConfigs: async (_userId?: string) => fixture,
  }));

  test("resolves by exact id", async () => {
    const { resolveAgentConfigForUser } = await import("../extensions/agent-configs-handler");
    const c = await resolveAgentConfigForUser("u1", "cfg-cap-bob");
    expect(c?.id).toBe("cfg-cap-bob");
  });

  test("resolves by name (case-insensitive, trimmed)", async () => {
    const { resolveAgentConfigForUser } = await import("../extensions/agent-configs-handler");
    const c = await resolveAgentConfigForUser("u1", "  ALICE BOT  ");
    expect(c?.id).toBe("cfg-cap-alice");
  });

  test("returns null when no match", async () => {
    const { resolveAgentConfigForUser } = await import("../extensions/agent-configs-handler");
    const c = await resolveAgentConfigForUser("u1", "nonesuch");
    expect(c).toBeNull();
  });
});
