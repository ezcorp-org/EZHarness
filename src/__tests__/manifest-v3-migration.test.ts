/**
 * Phase 1 manifest v2 → v3 migration coverage.
 *
 * Locks in the contract documented in `migrateManifestV2ToV3` at
 * `src/extensions/manifest.ts`:
 *   • v2 manifest with extension-wide perms + tools without
 *     `capabilities` → migration distributes the extension-wide
 *     ceiling onto every tool, marks `_inheritedFromV2: true`.
 *   • v3 manifest with explicit per-tool `capabilities` → identity;
 *     `_inheritedFromV2` not set.
 *   • v3 manifest where extension-wide perms are a strict superset of
 *     a tool's authored caps → authored caps are preserved (NOT
 *     widened to the extension ceiling).
 *   • v2 manifest with empty `permissions` → tools get an empty
 *     `CapabilityDeclaration`.
 */

import { describe, expect, test } from "bun:test";
import {
  deriveCapsFromExtensionPerms,
  migrateManifestV2ToV3,
  validateManifestV2,
} from "../extensions/manifest";
import type {
  CapabilityDeclaration,
  ExtensionManifest,
  ExtensionManifestInternal,
  ToolDefinition,
} from "../extensions/types";

function makeManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "test",
    author: { name: "tester" },
    entrypoint: "./index.ts",
    permissions: {},
    tools: [],
    ...overrides,
  };
}

// ── v2 → v3: distribute extension-wide perms ────────────────────────

describe("migrateManifestV2ToV3 — v2 manifests inherit caps", () => {
  test("network: ['api.foo.com'] + 2 tools → both tools get hosts: ['api.foo.com']", () => {
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: { network: ["api.foo.com"] },
      tools: [
        { name: "fetch_a", description: "a", inputSchema: { type: "object" } },
        { name: "fetch_b", description: "b", inputSchema: { type: "object" } },
      ],
    });
    const out = migrateManifestV2ToV3(manifest);
    expect(out.schemaVersion).toBe(3);
    expect(out._inheritedFromV2).toBe(true);
    expect(out.tools).toHaveLength(2);
    for (const t of out.tools ?? []) {
      expect(t.capabilities?.network?.hosts).toEqual(["api.foo.com"]);
    }
  });

  test("filesystem inheritance defaults to mode ['read', 'write']", () => {
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: { filesystem: ["/tmp"] },
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(manifest);
    expect(out.tools?.[0]?.capabilities?.filesystem?.paths).toEqual(["/tmp"]);
    expect(out.tools?.[0]?.capabilities?.filesystem?.mode).toEqual(["read", "write"]);
  });

  test("legacy boolean perms (taskEvents, agentConfig) → custom block", () => {
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: {
        taskEvents: true,
        agentConfig: "read",
        appendMessages: { excludedDefault: true },
      },
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(manifest);
    const custom = out.tools?.[0]?.capabilities?.custom;
    expect(custom?.taskEvents).toBe(true);
    expect(custom?.agentConfig).toBe(true);
    expect(custom?.appendMessages).toBe(true);
  });

  test("eventSubscriptions: ['x:y'] → custom.eventSubscriptions array", () => {
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: { eventSubscriptions: ["x:y"] },
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(manifest);
    expect(out.tools?.[0]?.capabilities?.custom?.eventSubscriptions).toEqual(["x:y"]);
  });
});

// ── v3 manifests pass through unchanged ─────────────────────────────

describe("migrateManifestV2ToV3 — v3 manifests are identity", () => {
  test("v3 with authored capabilities passes through unchanged", () => {
    const authored: CapabilityDeclaration = {
      network: { hosts: ["narrow.com"] },
    };
    const manifest = makeManifest({
      schemaVersion: 3,
      permissions: { network: ["wide.com"] },
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          capabilities: authored,
        },
      ],
    });
    const out = migrateManifestV2ToV3(manifest);
    expect(out.schemaVersion).toBe(3);
    // Identity: input was already v3 — `_inheritedFromV2` must not be set.
    expect(out._inheritedFromV2).toBeUndefined();
    expect(out.tools?.[0]?.capabilities).toEqual(authored);
  });
});

// ── Authored declarations win over extension-wide perms ─────────────

describe("migrateManifestV2ToV3 — authored caps preserved on v2 tools", () => {
  test("v2 manifest with one tool having authored caps preserves them", () => {
    const authored: CapabilityDeclaration = {
      network: { hosts: ["narrow.com"] },
    };
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: { network: ["wide.com", "narrow.com"] },
      tools: [
        {
          name: "narrow",
          description: "uses authored caps",
          inputSchema: { type: "object" },
          capabilities: authored,
        },
        {
          name: "wide",
          description: "inherits extension-wide",
          inputSchema: { type: "object" },
        },
      ],
    });
    const out = migrateManifestV2ToV3(manifest);
    // Authored tool keeps its narrow declaration.
    expect(out.tools?.[0]?.capabilities).toEqual(authored);
    // Inherited tool gets the full extension-wide list.
    expect(out.tools?.[1]?.capabilities?.network?.hosts).toEqual(["wide.com", "narrow.com"]);
  });
});

// ── Edge: empty permissions ─────────────────────────────────────────

describe("migrateManifestV2ToV3 — empty permissions yields empty caps", () => {
  test("v2 with empty permissions gives tools an empty CapabilityDeclaration", () => {
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: {},
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(manifest);
    expect(out.tools?.[0]?.capabilities).toEqual({});
    expect(out._inheritedFromV2).toBe(true);
  });
});

// ── deriveCapsFromExtensionPerms — direct unit coverage ─────────────

describe("deriveCapsFromExtensionPerms — translates v2 perms shape", () => {
  test("network array → { hosts: [...] }", () => {
    expect(deriveCapsFromExtensionPerms({ network: ["a.com", "b.com"] })).toEqual({
      network: { hosts: ["a.com", "b.com"] },
    });
  });

  test("shell true → shell: true", () => {
    expect(deriveCapsFromExtensionPerms({ shell: true })).toEqual({ shell: true });
  });

  test("shell false is dropped (no decl emitted)", () => {
    const result = deriveCapsFromExtensionPerms({ shell: false } as Parameters<typeof deriveCapsFromExtensionPerms>[0]);
    expect(result.shell).toBeUndefined();
  });

  test("env array preserved as env: [...]", () => {
    expect(deriveCapsFromExtensionPerms({ env: ["X", "Y"] })).toEqual({ env: ["X", "Y"] });
  });

  test("undefined input yields {}", () => {
    expect(deriveCapsFromExtensionPerms(undefined)).toEqual({});
  });
});

// ── Validator now accepts schemaVersion 3 ───────────────────────────

describe("validateManifestV2 — schemaVersion 3 is accepted", () => {
  test("v3 with authored capabilities validates", () => {
    const m = makeManifest({
      schemaVersion: 3,
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          capabilities: { network: { hosts: ["a.com"] } },
        } as ToolDefinition,
      ],
    });
    const result = validateManifestV2(m);
    expect(result.valid).toBe(true);
  });

  test("v3 with malformed capabilities.network rejects", () => {
    const m = {
      ...makeManifest({ schemaVersion: 3 }),
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          capabilities: { network: "not-an-object" },
        } as unknown as ToolDefinition,
      ],
    };
    const result = validateManifestV2(m as ExtensionManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("network");
  });

  test("v4 (or any other) is rejected", () => {
    const m = makeManifest({ schemaVersion: 4 as unknown as 3 });
    const result = validateManifestV2(m);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("schemaVersion must be 2 or 3");
  });

  test("schemaVersion: 1 is rejected BEFORE migration runs", () => {
    const m = makeManifest({ schemaVersion: 1 as unknown as 2 });
    const result = validateManifestV2(m);
    expect(result.valid).toBe(false);
    // The migration helper would still pass v1 through (it only
    // branches on `=== 3`), so the contract is that the validator
    // gates v1 out before any migration call. Any caller that reaches
    // `migrateManifestV2ToV3` has already passed validation.
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("missing schemaVersion is rejected", () => {
    const raw: Record<string, unknown> = {
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      author: { name: "tester" },
      entrypoint: "./index.ts",
      permissions: {},
      tools: [],
    };
    const result = validateManifestV2(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });
});

// ── Type-narrow assertion ───────────────────────────────────────────

describe("ExtensionManifestInternal shape", () => {
  test("migrated v2 manifest is assignable to ExtensionManifestInternal", () => {
    const out: ExtensionManifestInternal = migrateManifestV2ToV3(makeManifest());
    expect(out._inheritedFromV2).toBeDefined();
  });
});
