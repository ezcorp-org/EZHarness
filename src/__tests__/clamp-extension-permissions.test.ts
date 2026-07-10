/**
 * Bun-leg coverage for `clampExtensionPermissions` +
 * `manifestEventsIncludeFullPayload` at their NEW home,
 * `src/extensions/clamp-permissions.ts` (moved from
 * `web/src/lib/server/extension-helpers.ts` in fix-wave B Phase 2 so the
 * installer can re-clamp grants on update / same-source refresh).
 *
 * The exhaustive behavioral matrix (kill-switch, negative arms,
 * grantedAt edge cases) stays in the vitest suite
 * `web/src/__tests__/extension-helpers-clamp.server.test.ts`, which
 * drives the SAME implementation through the web re-export shim. This
 * file exists so the moved lines are line-covered in the bun coverage
 * leg (src/__tests__ is the coverage host set); it exercises every
 * positive attach path once plus the re-clamp-relevant narrowing arms.
 */
import { test, expect, describe } from "bun:test";
import {
  clampExtensionPermissions,
  manifestEventsIncludeFullPayload,
} from "../extensions/clamp-permissions";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";

// A DIRECT_CARRIER event (src/runtime/sse-conversation-filter.ts) so the
// eventSubscriptions triple-intersection can produce a non-empty grant.
const DCE_EVENT = "tool:start";

describe("clampExtensionPermissions — classic five", () => {
  test("grant ⊆ manifest passes through; grant ⊄ manifest is dropped", () => {
    const submitted: Partial<ExtensionPermissions> = {
      network: ["api.evil.com", "api.allowed.com"],
      filesystem: ["/etc/passwd", "/tmp"],
      env: ["SECRET", "OK_VAR"],
      shell: true,
      storage: true,
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      network: ["api.allowed.com"],
      filesystem: ["/tmp"],
      env: ["OK_VAR"],
      shell: true,
      storage: true,
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.network).toEqual(["api.allowed.com"]);
    expect(out.filesystem).toEqual(["/tmp"]);
    expect(out.env).toEqual(["OK_VAR"]);
    expect(out.shell).toBe(true);
    expect(out.storage).toBe(true);
  });

  test("narrowing manifest drops shell + network entirely (the update re-clamp case)", () => {
    // Stored grant from a WIDER old manifest; new manifest declares less.
    const stored: Partial<ExtensionPermissions> = {
      network: ["api.example.com", "cdn.example.com"],
      shell: true,
      grantedAt: { network: 111, shell: 222 },
    };
    const newManifest: ExtensionManifestV2["permissions"] = {
      network: ["api.example.com"],
      // shell no longer declared
    };
    const out = clampExtensionPermissions(stored, newManifest);
    expect(out.network).toEqual(["api.example.com"]);
    expect(out.shell).toBeUndefined();
    // Numeric grantedAt entries survive.
    expect(out.grantedAt.network).toBe(111);
  });

  test("unchanged manifest re-clamp is a no-op for a manifest-shaped grant", () => {
    const manifest: ExtensionManifestV2["permissions"] = {
      network: ["api.example.com"],
      shell: true,
    };
    const stored = clampExtensionPermissions(
      { network: ["api.example.com"], shell: true, grantedAt: { network: 9, shell: 9 } },
      manifest,
    );
    const reclamped = clampExtensionPermissions(stored, manifest);
    expect(reclamped).toEqual(stored);
  });
});

describe("clampExtensionPermissions — capability tier", () => {
  test("taskEvents + agentConfig + spawnAgents attach when both sides declare", () => {
    const submitted: Partial<ExtensionPermissions> = {
      taskEvents: true,
      agentConfig: "read",
      spawnAgents: { maxPerHour: 100, maxConcurrent: 50 },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      taskEvents: true,
      agentConfig: "read",
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.taskEvents).toBe(true);
    expect(out.agentConfig).toBe("read");
    // Numeric clamp takes the manifest's lower ceilings.
    expect(out.spawnAgents).toEqual({ maxPerHour: 10, maxConcurrent: 5 });
  });

  test("eventSubscriptions: array-form triple-intersection (∩ manifest ∩ direct-carrier)", () => {
    const out = clampExtensionPermissions(
      { eventSubscriptions: [DCE_EVENT, "not-in-manifest", "not:a:real:event"] },
      { eventSubscriptions: [DCE_EVENT, "not:in:carrier:list"] },
    );
    expect(out.eventSubscriptions).toEqual([DCE_EVENT]);
  });

  test("eventSubscriptions: object forms normalize on BOTH sides", () => {
    const out = clampExtensionPermissions(
      {
        eventSubscriptions: { events: [DCE_EVENT] } as unknown as ExtensionPermissions["eventSubscriptions"],
      },
      { eventSubscriptions: { events: [DCE_EVENT], includeFullPayload: true } },
    );
    expect(out.eventSubscriptions).toEqual([DCE_EVENT]);
  });

  test("eventSubscriptions: manifest without a declaration yields no grant", () => {
    const out = clampExtensionPermissions({ eventSubscriptions: [DCE_EVENT] }, {});
    expect(out.eventSubscriptions).toBeUndefined();
  });
});

describe("clampExtensionPermissions — Phase 51 capability surfaces", () => {
  test("llm / memory / lessons / schedule / search all attach when declared", () => {
    const submitted: Partial<ExtensionPermissions> = {
      llm: { providers: ["anthropic"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
      memory: { access: "write", maxWritesPerDay: 100, selfOnly: true },
      lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "project" },
      schedule: {
        crons: ["*/5 * * * *"],
        maxRunsPerDay: 24,
        maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once",
        maxRetries: 0,
      },
      search: { providers: ["duckduckgo"], maxResults: 5 },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      llm: { providers: ["anthropic"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
      memory: { access: "write", maxWritesPerDay: 100 },
      lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "user" },
      schedule: {
        crons: ["*/5 * * * *"],
        maxRunsPerDay: 24,
        maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once",
        maxRetries: 0,
      },
      search: { providers: ["duckduckgo"], maxResults: 5 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.llm?.providers).toEqual(["anthropic"]);
    expect(out.memory?.access).toBe("write");
    expect(out.lessons?.maxVisibility).toBe("user"); // clamped down
    expect(out.schedule?.crons).toEqual(["*/5 * * * *"]);
    expect(out.search).toEqual({ providers: ["duckduckgo"], maxResults: 5 });
  });
});

describe("clampExtensionPermissions — deputy flags + grantedAt", () => {
  test("acceptsCallerCaps / escalateChildCaps attach only with manifest top-level consent", () => {
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: true, escalateChildCaps: true },
      {},
      { acceptsCallerCaps: true, escalateChildCaps: true },
    );
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.escalateChildCaps).toBe(true);

    const denied = clampExtensionPermissions(
      { acceptsCallerCaps: true, escalateChildCaps: true },
      {},
    );
    expect(denied.acceptsCallerCaps).toBeUndefined();
    expect(denied.escalateChildCaps).toBeUndefined();
  });

  test("numeric grantedAt entries pass through; non-numbers dropped", () => {
    const out = clampExtensionPermissions(
      {
        grantedAt: {
          network: 1234,
          bogus: "nope" as unknown as number,
        },
      },
      {},
    );
    expect(out.grantedAt).toEqual({ network: 1234 });
  });
});

describe("manifestEventsIncludeFullPayload", () => {
  test("true only for the object form with includeFullPayload: true", () => {
    expect(manifestEventsIncludeFullPayload({ events: [DCE_EVENT], includeFullPayload: true })).toBe(true);
    expect(manifestEventsIncludeFullPayload({ events: [DCE_EVENT] })).toBe(false);
    expect(manifestEventsIncludeFullPayload([DCE_EVENT])).toBe(false);
    expect(manifestEventsIncludeFullPayload(undefined)).toBe(false);
  });
});
