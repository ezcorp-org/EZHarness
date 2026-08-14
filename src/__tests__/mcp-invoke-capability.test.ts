/**
 * `ezcorp:mcp:invoke` — the `kind:"mcp"` dispatch sentinel (F5).
 *
 * The kind exists because an MCP tool's only other declared capability is
 * `network`, and `deriveCapsFromExtensionPerms` SKIPS an empty host array. A
 * stdio server whose command line names no host — `npx -y
 * @modelcontextprotocol/server-github`, the most common shape — therefore
 * declared `capabilities: {}`, which flattens to an EMPTY needed set, and
 * `firstMissingCapability([], granted)` returns null for ANY grant. An
 * admin's revocation was a silent no-op.
 *
 * This file pins the VOCABULARY end of that fix (shape, sensitivity, clamp,
 * grant translation, intersection). The end-to-end denial it buys is pinned
 * in `mcp-pdp-gate-integration.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  SENSITIVE_KINDS,
  capabilityDeclarationToSet,
  firstMissingCapability,
  grantsToCapabilitySet,
  intersectPermissions,
  isSubset,
} from "../extensions/capability-types";
import { deriveCapsFromExtensionPerms, NAMESPACE_MAP } from "../extensions/manifest";
import { clampExtensionPermissions } from "../extensions/clamp-permissions";
import { CAPABILITY_PERMISSION_FIELDS } from "../extensions/capability-flags";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";

const CAP = { kind: "ezcorp:mcp:invoke" } as const;

describe("shape", () => {
  test("is VALUELESS — one MCP server per manifest, so the row already scopes it", () => {
    const caps = grantsToCapabilitySet({ mcpInvoke: true, grantedAt: {} });
    expect(caps).toEqual([CAP]);
    expect(caps[0]).not.toHaveProperty("value");
  });

  test("a valueless grant covers the valueless need (the subset check passes)", () => {
    expect(isSubset([CAP], grantsToCapabilitySet({ mcpInvoke: true, grantedAt: {} }))).toBe(true);
  });

  test("is NOT sensitive, so it can never return `prompt`", () => {
    // Load-bearing: a `prompt` decision is unanswerable in a cron fire, a
    // webhook delivery or a workflow `tool` step, all of which dispatch MCP
    // tools. Marking this kind sensitive would park those runs at
    // `awaiting_approval` forever — a governance gate turned into an
    // availability bug. `shell` was rejected as the sentinel for this reason.
    expect(SENSITIVE_KINDS.has("ezcorp:mcp:invoke")).toBe(false);
  });

  test("is deliberately absent from CAPABILITY_PERMISSION_FIELDS", () => {
    // That list is the EZCORP_DISABLE_CAPABILITY_TOOLS kill-switch surface.
    // This cap sits on the NEEDED side of every MCP dispatch, so dropping it
    // under the kill-switch would not disable a feature — it would DENY every
    // MCP tool call on the instance.
    expect(CAPABILITY_PERMISSION_FIELDS as readonly string[]).not.toContain("mcpInvoke");
  });
});

describe("grantsToCapabilitySet", () => {
  test("emits nothing unless the grant is explicitly true", () => {
    // A legacy grant blob (written before this kind existed) must produce a
    // byte-identical capability set and fail CLOSED, not inherit the cap.
    for (const grant of [
      { grantedAt: {} },
      { mcpInvoke: false, grantedAt: {} },
      { mcpInvoke: undefined, grantedAt: {} },
    ] as ExtensionPermissions[]) {
      expect(grantsToCapabilitySet(grant)).toEqual([]);
    }
  });

  test("an ungranted need names the missing cap in the deny reason", () => {
    const missing = firstMissingCapability([CAP], grantsToCapabilitySet({ grantedAt: {} }));
    expect(missing).toEqual(CAP);
  });
});

describe("declaration → needed set", () => {
  test("deriveCapsFromExtensionPerms routes it through the namespaced custom bag", () => {
    expect(NAMESPACE_MAP.mcpInvoke).toBe("ezcorp:mcp:invoke");
    const decl = deriveCapsFromExtensionPerms({ mcpInvoke: true });
    expect(decl.custom).toEqual({ "ezcorp:mcp:invoke": true });
    // No special case in the flattener — it is an ordinary declaration.
    expect(capabilityDeclarationToSet(decl, {})).toEqual([CAP]);
  });

  test("both the legacy key and the namespaced key flatten to the same cap", () => {
    expect(capabilityDeclarationToSet({ custom: { mcpInvoke: true } }, {})).toEqual([CAP]);
    expect(capabilityDeclarationToSet({ custom: { "ezcorp:mcp:invoke": true } }, {})).toEqual([
      CAP,
    ]);
  });

  test("a false declaration contributes nothing", () => {
    expect(deriveCapsFromExtensionPerms({ mcpInvoke: false }).custom).toBeUndefined();
  });
});

describe("clamp — the three-state grant", () => {
  const ceiling = { mcpInvoke: true } satisfies ExtensionManifestV2["permissions"];

  test("submitted true → granted", () => {
    expect(clampExtensionPermissions({ mcpInvoke: true }, ceiling).mcpInvoke).toBe(true);
  });

  test("submitted ABSENT → granted (mirrors the ceiling)", () => {
    // The one departure from "an omitted key revokes", and it is deliberate:
    // the extension detail page's Save posts a FIXED six-key body and cannot
    // express this field, so the usual default would let an admin editing an
    // unrelated host list silently brick every tool on the server. `search`
    // resolves the same tension the same way (`undefined → "inherit"`).
    expect(clampExtensionPermissions({}, ceiling).mcpInvoke).toBe(true);
    expect(
      clampExtensionPermissions({ network: ["a.example.com"] }, ceiling).mcpInvoke,
    ).toBe(true);
  });

  test("submitted FALSE → revoked (the explicit off switch)", () => {
    expect(clampExtensionPermissions({ mcpInvoke: false }, ceiling).mcpInvoke).toBeUndefined();
  });

  test("a manifest that does not declare it can never be granted it", () => {
    // `granted ⊆ manifest` — the clamp's actual invariant — is untouched by
    // the absent-means-granted rule: the fallback is the CEILING, never
    // something the manifest withheld.
    expect(clampExtensionPermissions({ mcpInvoke: true }, {}).mcpInvoke).toBeUndefined();
    expect(clampExtensionPermissions({ mcpInvoke: true }, { mcpInvoke: false }).mcpInvoke)
      .toBeUndefined();
  });

  test("the kill-switch does NOT strip it", () => {
    // Placed outside the `capabilityToolsDisabled()` guard on purpose — see
    // the CAPABILITY_PERMISSION_FIELDS test above for why.
    const prior = process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    try {
      expect(clampExtensionPermissions({ mcpInvoke: true }, ceiling).mcpInvoke).toBe(true);
    } finally {
      if (prior === undefined) delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
      else process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = prior;
    }
  });
});

describe("intersectPermissions", () => {
  test("boolean AND — a parent without it clips the child", () => {
    const withCap: ExtensionPermissions = { mcpInvoke: true, grantedAt: { mcpInvoke: 5 } };
    const without: ExtensionPermissions = { grantedAt: {} };
    expect(intersectPermissions(withCap, withCap).mcpInvoke).toBe(true);
    expect(intersectPermissions(withCap, without).mcpInvoke).toBeUndefined();
    expect(intersectPermissions(without, withCap).mcpInvoke).toBeUndefined();
  });

  test("a surviving grant keeps the OLDER grantedAt stamp", () => {
    const a: ExtensionPermissions = { mcpInvoke: true, grantedAt: { mcpInvoke: 10 } };
    const b: ExtensionPermissions = { mcpInvoke: true, grantedAt: { mcpInvoke: 2 } };
    expect(intersectPermissions(a, b).grantedAt.mcpInvoke).toBe(2);
  });

  test("a clipped grant drops its grantedAt key too", () => {
    const a: ExtensionPermissions = { mcpInvoke: true, grantedAt: { mcpInvoke: 10 } };
    const b: ExtensionPermissions = { grantedAt: { mcpInvoke: 2 } };
    expect(intersectPermissions(a, b).grantedAt.mcpInvoke).toBeUndefined();
  });
});

describe("install-grant helper", () => {
  test("a CLI 'grant all declared' install carries the sentinel", () => {
    // Without the passthrough in `manifestRequestedGrant`, a local
    // `ext install --yes` of an MCP manifest would install a row whose every
    // tool is denied.
    const manifest = {
      schemaVersion: 2,
      name: "cli-mcp",
      version: "1.0.0",
      description: "d",
      author: { name: "t" },
      kind: "mcp",
      permissions: { network: ["a.example.com"], mcpInvoke: true },
      tools: [],
    } as unknown as ExtensionManifestV2;
    const grant = buildFullGrantFromManifest(manifest, 1_700_000_000_000);
    expect(grant.mcpInvoke).toBe(true);
    expect(grant.grantedAt.mcpInvoke).toBe(1_700_000_000_000);
  });
});
