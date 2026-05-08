/**
 * Helper-level unit tests for `clampExtensionPermissions` extracted into
 * `web/src/lib/server/extension-helpers.ts`.
 *
 * Existing handler tests (api-extensions-id-permissions / -id-activate)
 * exercise the helper indirectly via the HTTP boundary; these tests pin
 * tricky edge cases on the helper itself so future regressions surface
 * fast (independent of route handler shape).
 *
 * Covered branches:
 *   - empty submitted / empty manifest
 *   - filtering: submitted not-in-manifest dropped silently
 *   - filtering: manifest not-in-submitted dropped (no defaults)
 *   - boolean toggles (`shell`, `storage`) only granted when both sides true
 *   - spawnAgents numeric floor + missing maxConcurrent default
 *   - eventSubscriptions triple-intersection (submitted ∩ manifest ∩ DCE)
 *   - capability kill-switch suppresses the whole capability tier
 *   - grantedAt timestamp filtering (non-number values dropped)
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clampExtensionPermissions } from "$lib/server/extension-helpers";
import type { ExtensionManifestV2, ExtensionPermissions } from "$server/extensions/types";

// Use any DIRECT_CARRIER event so the eventSubscriptions branch can
// produce a non-empty grant. Pick one that's guaranteed to be in the
// allowlist per src/runtime/sse-conversation-filter.ts.
const DCE_EVENT = "tool:start";

// Kill-switch hygiene — never leak env var across tests.
let prevEnv: string | undefined;
beforeEach(() => {
  prevEnv = process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
  else process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = prevEnv;
});

describe("clampExtensionPermissions — base perm tier", () => {
  test("empty submitted ∩ any manifest yields empty grantedAt-only result", () => {
    const manifest: ExtensionManifestV2["permissions"] = {
      network: ["api.example.com"],
      shell: true,
    };
    const out = clampExtensionPermissions({}, manifest);
    expect(out).toEqual({ grantedAt: {} });
  });

  test("submitted entries not declared in manifest are silently dropped", () => {
    const submitted: Partial<ExtensionPermissions> = {
      network: ["api.evil.com", "api.allowed.com"],
      filesystem: ["/etc/passwd", "/tmp"],
      env: ["SECRET", "OK_VAR"],
      shell: true,
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      network: ["api.allowed.com"],
      filesystem: ["/tmp"],
      env: ["OK_VAR"],
      // shell intentionally omitted — caller cannot grant past manifest
    };

    const out = clampExtensionPermissions(submitted, manifest);

    expect(out.network).toEqual(["api.allowed.com"]);
    expect(out.filesystem).toEqual(["/tmp"]);
    expect(out.env).toEqual(["OK_VAR"]);
    // shell asked but manifest didn't declare → not in clamped output
    expect(out.shell).toBeUndefined();
  });

  test("manifest perms not in submitted are dropped (no auto-defaults)", () => {
    const manifest: ExtensionManifestV2["permissions"] = {
      network: ["api.example.com"],
      filesystem: ["/var"],
      shell: true,
      env: ["FOO"],
      storage: true,
    };
    // Caller submits NO permissions — must not auto-grant any.
    const out = clampExtensionPermissions({}, manifest);
    expect(out.network).toBeUndefined();
    expect(out.filesystem).toBeUndefined();
    expect(out.shell).toBeUndefined();
    expect(out.env).toBeUndefined();
    expect(out.storage).toBeUndefined();
  });

  test("array intersection that ends up empty drops the whole field", () => {
    const submitted: Partial<ExtensionPermissions> = {
      network: ["api.evil.com"], // none in manifest
      filesystem: ["/etc"],       // none in manifest
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      network: ["api.good.com"],
      filesystem: ["/tmp"],
    };
    const out = clampExtensionPermissions(submitted, manifest);
    // Empty filtered arrays must NOT appear as `[]` in the result.
    expect(out).not.toHaveProperty("network");
    expect(out).not.toHaveProperty("filesystem");
  });

  test("boolean toggles only flip true when both sides are exactly true", () => {
    const manifest: ExtensionManifestV2["permissions"] = { shell: true, storage: true };

    expect(clampExtensionPermissions({ shell: true, storage: true }, manifest))
      .toEqual({ grantedAt: {}, shell: true, storage: true });

    // Ambiguous truthy values — only `=== true` clears the gate.
    expect(clampExtensionPermissions(
      // @ts-expect-error — coercive truthy values must NOT pass
      { shell: 1, storage: "yes" },
      manifest,
    ))
      .toEqual({ grantedAt: {} });
  });
});

describe("clampExtensionPermissions — capability tier", () => {
  test("spawnAgents takes Math.min of submitted vs manifest caps", () => {
    const submitted: Partial<ExtensionPermissions> = {
      spawnAgents: { maxPerHour: 100, maxConcurrent: 50 },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.spawnAgents).toEqual({ maxPerHour: 10, maxConcurrent: 5 });
  });

  test("spawnAgents missing maxConcurrent defaults to 3 (lower of two)", () => {
    const submitted: Partial<ExtensionPermissions> = {
      spawnAgents: { maxPerHour: 50 }, // no maxConcurrent
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      spawnAgents: { maxPerHour: 50 }, // no maxConcurrent
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.spawnAgents).toEqual({ maxPerHour: 50, maxConcurrent: 3 });
  });

  test("spawnAgents: submitted maxConcurrent undefined falls back to manifest value, not 3", () => {
    // V3 gap closure — pin the `?? manifestMax.maxConcurrent ?? 3` chain
    // so the manifest's declared cap is used when the submitted side
    // omits maxConcurrent. A regression that swapped the inner ?? order
    // would silently downgrade the cap to 3 across all admin grants
    // that rely on the manifest default.
    const submitted: Partial<ExtensionPermissions> = {
      spawnAgents: { maxPerHour: 5 } as ExtensionPermissions["spawnAgents"], // no maxConcurrent
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      spawnAgents: { maxPerHour: 5, maxConcurrent: 7 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.spawnAgents).toEqual({ maxPerHour: 5, maxConcurrent: 7 });
  });

  test("spawnAgents drops the field entirely when computed cap is zero", () => {
    const submitted: Partial<ExtensionPermissions> = {
      spawnAgents: { maxPerHour: 0, maxConcurrent: 5 },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.spawnAgents).toBeUndefined();
  });

  test("eventSubscriptions: triple-intersection submitted ∩ manifest ∩ DIRECT_CARRIER", () => {
    const submitted: Partial<ExtensionPermissions> = {
      eventSubscriptions: [DCE_EVENT, "not-in-manifest", "not:a:real:event"],
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      eventSubscriptions: [DCE_EVENT, "not:in:carrier:list"],
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.eventSubscriptions).toEqual([DCE_EVENT]);
  });

  test("eventSubscriptions: empty intersection drops the field", () => {
    const submitted: Partial<ExtensionPermissions> = {
      eventSubscriptions: ["nope:not:a:real:event"],
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      eventSubscriptions: ["nope:not:a:real:event"],
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.eventSubscriptions).toBeUndefined();
  });

  test("kill-switch (EZCORP_DISABLE_CAPABILITY_TOOLS=1) suppresses ALL capability fields", () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";

    const submitted: Partial<ExtensionPermissions> = {
      taskEvents: true,
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
      agentConfig: "read",
      eventSubscriptions: [DCE_EVENT],
      // base tier still flows through
      shell: true,
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      taskEvents: true,
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
      agentConfig: "read",
      eventSubscriptions: [DCE_EVENT],
      shell: true,
    };

    const out = clampExtensionPermissions(submitted, manifest);

    expect(out.taskEvents).toBeUndefined();
    expect(out.spawnAgents).toBeUndefined();
    expect(out.agentConfig).toBeUndefined();
    expect(out.eventSubscriptions).toBeUndefined();
    // base tier must still pass — kill-switch is capability-only.
    expect(out.shell).toBe(true);
  });

  test("kill-switch env var only matches the exact string '1', not 'true'", () => {
    // V3 gap closure — `capabilityToolsDisabled()` is `=== "1"` not
    // truthy-coerce. Operators who set EZCORP_DISABLE_CAPABILITY_TOOLS
    // to "true" / "yes" / "on" must NOT accidentally trigger the
    // kill-switch — those strings are NOT honored. Pin the strict
    // equality so a regression to a truthy-coerce check (which would
    // expand the killable set silently) surfaces here.
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "true";

    const submitted: Partial<ExtensionPermissions> = {
      taskEvents: true,
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
      agentConfig: "read",
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      taskEvents: true,
      spawnAgents: { maxPerHour: 10, maxConcurrent: 5 },
      agentConfig: "read",
    };

    const out = clampExtensionPermissions(submitted, manifest);

    // Capability tier still flows — kill-switch did NOT trigger.
    expect(out.taskEvents).toBe(true);
    expect(out.spawnAgents).toEqual({ maxPerHour: 10, maxConcurrent: 5 });
    expect(out.agentConfig).toBe("read");
  });

  test("agentConfig only granted when both sides exactly === 'read'", () => {
    const manifestRead: ExtensionManifestV2["permissions"] = { agentConfig: "read" };

    expect(clampExtensionPermissions({ agentConfig: "read" }, manifestRead).agentConfig)
      .toBe("read");

    // Submitter sends something else (e.g. legacy "write" or undefined).
    expect(clampExtensionPermissions(
      // @ts-expect-error — schema only allows "read"
      { agentConfig: "write" },
      manifestRead,
    ).agentConfig).toBeUndefined();

    expect(clampExtensionPermissions({}, manifestRead).agentConfig).toBeUndefined();
  });
});

describe("clampExtensionPermissions — Phase 51 capability surfaces (C1)", () => {
  test("manifest declares llm → submitted llm flows through", () => {
    const submitted: Partial<ExtensionPermissions> = {
      llm: {
        providers: ["anthropic"],
        maxCallsPerHour: 60,
        maxCallsPerDay: 500,
      },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      llm: {
        providers: ["anthropic"],
        maxCallsPerHour: 60,
        maxCallsPerDay: 500,
      },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.llm).toBeDefined();
    expect(out.llm?.providers).toEqual(["anthropic"]);
    expect(out.llm?.maxCallsPerHour).toBe(60);
  });

  test("submitted llm narrows manifest providers", () => {
    const submitted: Partial<ExtensionPermissions> = {
      llm: { providers: ["openai", "evil"], maxCallsPerHour: 100, maxCallsPerDay: 1000 },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      llm: { providers: ["openai", "anthropic"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.llm?.providers).toEqual(["openai"]);
    expect(out.llm?.maxCallsPerHour).toBe(60); // clamped to manifest
  });

  test("manifest declares memory → submitted memory flows through with selfOnly default true", () => {
    const submitted: Partial<ExtensionPermissions> = {
      memory: { access: "write", maxWritesPerDay: 100, selfOnly: true },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      memory: { access: "write", maxWritesPerDay: 100 },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.memory?.access).toBe("write");
    expect(out.memory?.selfOnly).toBe(true);
  });

  test("manifest declares lessons → submitted lessons flows through with maxVisibility clamp", () => {
    const submitted: Partial<ExtensionPermissions> = {
      lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "project" },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "user" },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.lessons?.maxVisibility).toBe("user"); // clamped down
  });

  test("manifest declares schedule → crons flow through (clamped to manifest)", () => {
    const submitted: Partial<ExtensionPermissions> = {
      schedule: {
        crons: ["*/5 * * * *", "* * * * *"], // second is sub-5-min — drop
        maxRunsPerDay: 24, maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once", maxRetries: 0,
      },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      schedule: {
        crons: ["*/5 * * * *"],
        maxRunsPerDay: 24, maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once", maxRetries: 0,
      },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    // Manifest is source of truth — only the manifest's cron survives.
    expect(out.schedule?.crons).toEqual(["*/5 * * * *"]);
  });

  test("kill-switch suppresses Phase 51 capability surfaces too", () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const submitted: Partial<ExtensionPermissions> = {
      llm: { providers: ["anthropic"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
      memory: { access: "write", maxWritesPerDay: 100, selfOnly: true },
      lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "user" },
      schedule: {
        crons: ["*/5 * * * *"], maxRunsPerDay: 24, maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once", maxRetries: 0,
      },
    };
    const manifest: ExtensionManifestV2["permissions"] = {
      llm: { providers: ["anthropic"], maxCallsPerHour: 60, maxCallsPerDay: 500 },
      memory: { access: "write", maxWritesPerDay: 100 },
      lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "user" },
      schedule: {
        crons: ["*/5 * * * *"], maxRunsPerDay: 24, maxRunDurationMs: 300_000,
        missedRunPolicy: "fire-once", maxRetries: 0,
      },
    };
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.llm).toBeUndefined();
    expect(out.memory).toBeUndefined();
    expect(out.lessons).toBeUndefined();
    expect(out.schedule).toBeUndefined();
  });
});

describe("clampExtensionPermissions — grantedAt passthrough", () => {
  test("preserves number-valued grantedAt entries; drops non-numbers", () => {
    const submitted: Partial<ExtensionPermissions> = {
      grantedAt: {
        network: 1234,
        shell: 5678,
        // Non-number values should be silently dropped.
        bogus: "not-a-number" as unknown as number,
        weird: null as unknown as number,
        empty: undefined as unknown as number,
      },
    };
    const manifest: ExtensionManifestV2["permissions"] = {};
    const out = clampExtensionPermissions(submitted, manifest);
    expect(out.grantedAt).toEqual({ network: 1234, shell: 5678 });
  });

  test("missing grantedAt object yields empty grantedAt — does not crash", () => {
    const out = clampExtensionPermissions({}, {});
    expect(out.grantedAt).toEqual({});
  });
});
