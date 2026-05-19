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
import { capabilityDeclarationToSet } from "../extensions/capability-types";
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

  test("Phase 6: legacy boolean perms migrate to namespaced ezcorp:* form", () => {
    // Phase 6 capability namespace migration. The legacy keys
    // (taskEvents, agentConfig, appendMessages, spawnAgents,
    // eventSubscriptions) are translated to their `ezcorp:*` form via
    // NAMESPACE_MAP inside `deriveCapsFromExtensionPerms`. The runtime
    // continues to read BOTH names so existing manifests don't need
    // editing — `customToKind` in capability-types.ts accepts both.
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: {
        taskEvents: true,
        agentConfig: "read",
        appendMessages: { excludedDefault: true },
        spawnAgents: { maxPerHour: 5 },
      },
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(manifest);
    const custom = out.tools?.[0]?.capabilities?.custom;
    expect(custom?.["ezcorp:tasks:emit"]).toBe(true);
    expect(custom?.["ezcorp:agent:config"]).toBe(true);
    expect(custom?.["ezcorp:chat:append"]).toBe(true);
    expect(custom?.["ezcorp:agent:spawn"]).toBe(true);
    // The legacy keys are NOT emitted on the namespaced output.
    expect(custom?.taskEvents).toBeUndefined();
    expect(custom?.agentConfig).toBeUndefined();
    expect(custom?.appendMessages).toBeUndefined();
    expect(custom?.spawnAgents).toBeUndefined();
  });

  test("Phase 6: eventSubscriptions array migrates to ezcorp:events:subscribe", () => {
    const manifest = makeManifest({
      schemaVersion: 2,
      permissions: { eventSubscriptions: ["x:y"] },
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(manifest);
    const custom = out.tools?.[0]?.capabilities?.custom;
    expect(custom?.["ezcorp:events:subscribe"]).toEqual(["x:y"]);
    expect(custom?.eventSubscriptions).toBeUndefined();
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

// ── Phase 6: customToKind dual-spelling acceptance ──────────────────

describe("customToKind — accepts BOTH legacy and namespaced spellings", () => {
  // Phase 6 spec lock-in: "Runtime reads BOTH old + new (back-compat)."
  // `customToKind` (capability-types.ts:472) maps either form to the
  // same `CapabilityKind`. Exercised via `capabilityDeclarationToSet`
  // — the only public consumer of `decl.custom`.
  const pairs: Array<{ legacy: string; namespaced: string; value?: string[] | true }> = [
    { legacy: "appendMessages", namespaced: "ezcorp:chat:append", value: true },
    { legacy: "agentConfig", namespaced: "ezcorp:agent:config", value: true },
    { legacy: "taskEvents", namespaced: "ezcorp:tasks:emit", value: true },
    { legacy: "spawnAgents", namespaced: "ezcorp:agent:spawn", value: true },
    { legacy: "eventSubscriptions", namespaced: "ezcorp:events:subscribe", value: ["foo:bar"] },
  ];

  for (const { legacy, namespaced, value } of pairs) {
    test(`${legacy} ↔ ${namespaced} produce the same CapabilitySet`, () => {
      const declLegacy: CapabilityDeclaration = {
        custom: { [legacy]: value as string[] | boolean },
      };
      const declNamespaced: CapabilityDeclaration = {
        custom: { [namespaced]: value as string[] | boolean },
      };
      const setLegacy = capabilityDeclarationToSet(declLegacy, {});
      const setNamespaced = capabilityDeclarationToSet(declNamespaced, {});
      // Both spellings flatten to the same kind/value tuples.
      expect(setLegacy).toEqual(setNamespaced);
      // And both must produce the namespaced kind, not the legacy
      // string — the PDP and audit log only see the namespaced form.
      expect(setLegacy.length).toBeGreaterThan(0);
      expect(setLegacy[0]!.kind).toBe(namespaced as never);
    });
  }

  test("unknown custom key is silently dropped", () => {
    const decl: CapabilityDeclaration = { custom: { someThirdParty: true } };
    expect(capabilityDeclarationToSet(decl, {})).toEqual([]);
  });
});

// ── Phase 4: deputy / orchestration manifest fields ────────────────

describe("migrateManifestV2ToV3 — Phase 4 deputy/orchestration flags", () => {
  test("v2 manifest without flags → migrated v3 has both absent (treated as false at runtime)", () => {
    const m = makeManifest({
      schemaVersion: 2,
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(m);
    expect(out.acceptsCallerCaps).toBeUndefined();
    expect(out.escalateChildCaps).toBeUndefined();
  });

  test("v3 manifest with acceptsCallerCaps: true → preserved through migration", () => {
    const m = makeManifest({
      schemaVersion: 3,
      acceptsCallerCaps: true,
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          capabilities: {},
        } as ToolDefinition,
      ],
    });
    const out = migrateManifestV2ToV3(m);
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.escalateChildCaps).toBeUndefined();
  });

  test("v3 manifest with escalateChildCaps: true → preserved through migration", () => {
    const m = makeManifest({
      schemaVersion: 3,
      escalateChildCaps: true,
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          capabilities: {},
        } as ToolDefinition,
      ],
    });
    const out = migrateManifestV2ToV3(m);
    expect(out.escalateChildCaps).toBe(true);
    expect(out.acceptsCallerCaps).toBeUndefined();
  });

  test("v3 manifest with both flags → both preserved", () => {
    const m = makeManifest({
      schemaVersion: 3,
      acceptsCallerCaps: true,
      escalateChildCaps: true,
      tools: [
        {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          capabilities: {},
        } as ToolDefinition,
      ],
    });
    const out = migrateManifestV2ToV3(m);
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.escalateChildCaps).toBe(true);
  });

  test("v2 manifest carrying acceptsCallerCaps: true → preserved (v2 schema accepts it)", () => {
    // The validator accepts the field on either version; the runtime
    // check is `=== true`. This case asserts that authors writing v2
    // manifests can still surface the deputy flag — the migration
    // doesn't strip it.
    const m = makeManifest({
      schemaVersion: 2,
      acceptsCallerCaps: true,
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    });
    const out = migrateManifestV2ToV3(m);
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out._inheritedFromV2).toBe(true);
  });
});

// ── Phase 4: validator accepts boolean flags ───────────────────────

describe("validateManifestV2 — Phase 4 deputy/orchestration flags", () => {
  test("acceptsCallerCaps: true validates", () => {
    const m = makeManifest({ acceptsCallerCaps: true });
    const result = validateManifestV2(m);
    expect(result.valid).toBe(true);
  });

  test("escalateChildCaps: false validates", () => {
    const m = makeManifest({ escalateChildCaps: false });
    const result = validateManifestV2(m);
    expect(result.valid).toBe(true);
  });

  test("acceptsCallerCaps: 'yes' (non-boolean) is rejected", () => {
    const m = {
      ...makeManifest(),
      acceptsCallerCaps: "yes" as unknown as boolean,
    };
    const result = validateManifestV2(m as ExtensionManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptsCallerCaps"))).toBe(true);
  });

  test("escalateChildCaps: 1 (non-boolean) is rejected", () => {
    const m = {
      ...makeManifest(),
      escalateChildCaps: 1 as unknown as boolean,
    };
    const result = validateManifestV2(m as ExtensionManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("escalateChildCaps"))).toBe(true);
  });
});
