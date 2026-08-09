/**
 * The `permissions.triggers` surface (C2) end-to-end across every site it
 * has to be wired into: manifest validation → install-grant construction →
 * clamp → capability translation → intersection → the capability-field
 * registry.
 *
 * Modelled on `workflows-permission.test.ts`, and for the same reason: a
 * permission that is only half-wired fails SILENTLY — a dropped field, a
 * `Math.min(NaN, …)`, a cap the PDP never sees. Each site gets an explicit
 * test rather than relying on a happy path to pass through all of them.
 */
import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import { clampExtensionPermissions } from "../extensions/clamp-permissions";
import {
  grantsToCapabilitySet,
  intersectPermissions,
  SENSITIVE_KINDS,
} from "../extensions/capability-types";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import { CAPABILITY_PERMISSION_FIELDS } from "../extensions/capability-flags";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";

function manifest(perms: Record<string, unknown>): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "trig-ext",
    version: "1.0.0",
    description: "d",
    author: { name: "a" },
    entrypoint: "./index.ts",
    permissions: perms,
  } as unknown as ExtensionManifestV2;
}

const DECL = {
  maxCron: 25,
  maxWebhooks: 10,
  webhookPrefix: "factory-",
  maxRunsPerDay: 500,
};

const GRANT: NonNullable<ExtensionPermissions["triggers"]> = {
  maxCron: 25,
  maxWebhooks: 10,
  webhookPrefix: "factory-",
  maxRunsPerDay: 500,
};

describe("manifest validation", () => {
  test("accepts a well-formed triggers declaration", () => {
    expect(validateManifestV2(manifest({ triggers: DECL })).valid).toBe(true);
  });

  test("accepts a declaration carrying only the required prefix", () => {
    expect(validateManifestV2(manifest({ triggers: { webhookPrefix: "f-" } })).valid).toBe(true);
  });

  test("rejects a non-object triggers block", () => {
    const res = validateManifestV2(manifest({ triggers: [25] }));
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toContain("permissions.triggers must be an object");
  });

  test("rejects a missing or malformed webhookPrefix", () => {
    for (const bad of [{}, { webhookPrefix: "factory" }, { webhookPrefix: "Factory-" }]) {
      const res = validateManifestV2(manifest({ triggers: bad }));
      expect(res.valid).toBe(false);
      expect(res.errors.join("\n")).toContain("permissions.triggers.webhookPrefix");
    }
  });

  test("rejects negative or non-numeric caps", () => {
    for (const field of ["maxCron", "maxWebhooks", "maxRunsPerDay"]) {
      const res = validateManifestV2(
        manifest({
          triggers: { webhookPrefix: "factory-", [field]: -1 },
        }),
      );
      expect(res.valid).toBe(false);
      expect(res.errors.join("\n")).toContain(`permissions.triggers.${field}`);
    }
    const res = validateManifestV2(
      manifest({
        triggers: { webhookPrefix: "factory-", maxCron: "lots" },
      }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toContain("permissions.triggers.maxCron");
  });

  test("a manifest with no triggers block stays valid", () => {
    expect(validateManifestV2(manifest({})).valid).toBe(true);
  });
});

describe("install-grant construction", () => {
  test("the declared envelope reaches the requested grant", () => {
    const full = buildFullGrantFromManifest(manifest({ triggers: DECL }));
    expect(full.triggers).toEqual(DECL);
  });

  test("an undeclared envelope is absent from the requested grant", () => {
    expect(buildFullGrantFromManifest(manifest({})).triggers).toBeUndefined();
  });
});

describe("clamp integration", () => {
  test("clampExtensionPermissions attaches a clamped triggers grant", () => {
    const clamped = clampExtensionPermissions(
      { triggers: { maxCron: 5, maxWebhooks: 5, webhookPrefix: "x-", maxRunsPerDay: 50 } },
      manifest({ triggers: DECL }).permissions,
    );
    // Narrowed by the submitted side; prefix still the manifest's.
    expect(clamped.triggers).toEqual({
      maxCron: 5,
      maxWebhooks: 5,
      webhookPrefix: "factory-",
      maxRunsPerDay: 50,
    });
  });

  test("an undeclared envelope never appears on the clamped grant", () => {
    const clamped = clampExtensionPermissions(
      { triggers: { maxCron: 5, maxWebhooks: 5, webhookPrefix: "evil-", maxRunsPerDay: 50 } },
      manifest({}).permissions,
    );
    expect(clamped.triggers).toBeUndefined();
  });

  test("a husk envelope is dropped by the integrated clamp too", () => {
    const clamped = clampExtensionPermissions(
      {},
      manifest({ triggers: { ...DECL, maxCron: 0, maxWebhooks: 0 } }).permissions,
    );
    expect(clamped.triggers).toBeUndefined();
  });
});

describe("capability translation (the PDP's view)", () => {
  test("emits one cap PER KIND", () => {
    const caps = grantsToCapabilitySet({ triggers: GRANT, grantedAt: {} });
    expect(caps).toContainEqual({ kind: "ezcorp:triggers:register", value: "cron" });
    expect(caps).toContainEqual({ kind: "ezcorp:triggers:register", value: "webhook" });
  });

  test("a zero cap emits NO cap for that kind", () => {
    // Otherwise the PDP would allow a registration the handler's own cap
    // check rejects — one decision split across two layers that disagree.
    const cronOnly = grantsToCapabilitySet({
      triggers: { ...GRANT, maxWebhooks: 0 },
      grantedAt: {},
    });
    expect(cronOnly).toContainEqual({ kind: "ezcorp:triggers:register", value: "cron" });
    expect(cronOnly).not.toContainEqual({ kind: "ezcorp:triggers:register", value: "webhook" });

    const hookOnly = grantsToCapabilitySet({ triggers: { ...GRANT, maxCron: 0 }, grantedAt: {} });
    expect(hookOnly).not.toContainEqual({ kind: "ezcorp:triggers:register", value: "cron" });
    expect(hookOnly).toContainEqual({ kind: "ezcorp:triggers:register", value: "webhook" });
  });

  test("no grant ⇒ no trigger caps at all", () => {
    const caps = grantsToCapabilitySet({ grantedAt: {} });
    expect(caps.filter((c) => c.kind === "ezcorp:triggers:register")).toHaveLength(0);
  });

  test("registering a trigger is not classified sensitive", () => {
    // Consistent with `ezcorp:workflows:run`: the install-time envelope is
    // the reviewed bound, so a per-call prompt would add friction without
    // adding a decision.
    expect(SENSITIVE_KINDS.has("ezcorp:triggers:register")).toBe(false);
  });
});

describe("ceiling intersection", () => {
  test("takes the narrower of every numeric bound", () => {
    const out = intersectPermissions(
      { triggers: GRANT, grantedAt: {} },
      {
        triggers: { maxCron: 5, maxWebhooks: 50, webhookPrefix: "factory-", maxRunsPerDay: 100 },
        grantedAt: {},
      },
    );
    expect(out.triggers).toEqual({
      maxCron: 5,
      maxWebhooks: 10,
      webhookPrefix: "factory-",
      maxRunsPerDay: 100,
    });
  });

  test("survives only when BOTH sides declare it", () => {
    expect(
      intersectPermissions({ triggers: GRANT, grantedAt: {} }, { grantedAt: {} }).triggers,
    ).toBeUndefined();
    expect(
      intersectPermissions({ grantedAt: {} }, { triggers: GRANT, grantedAt: {} }).triggers,
    ).toBeUndefined();
  });

  test("DROPS the grant when the two prefixes disagree", () => {
    // A namespace claim has no "narrower of the two". Picking either side
    // would silently mint future slugs under a namespace one side never
    // agreed to.
    const out = intersectPermissions(
      { triggers: GRANT, grantedAt: {} },
      { triggers: { ...GRANT, webhookPrefix: "other-" }, grantedAt: {} },
    );
    expect(out.triggers).toBeUndefined();
  });

  test("never produces NaN from a half-written ceiling row", () => {
    // The granted type requires all four fields precisely so this cannot
    // happen; assert the runtime invariant in case the type is loosened.
    const out = intersectPermissions(
      { triggers: GRANT, grantedAt: {} },
      {
        triggers: { maxCron: 3 } as NonNullable<ExtensionPermissions["triggers"]>,
        grantedAt: {},
      },
    );
    // Prefix mismatch (undefined vs "factory-") drops it — the safe outcome.
    expect(out.triggers).toBeUndefined();
  });
});

describe("capability-field registry", () => {
  test("triggers is registered as a capability-tool field", () => {
    // Drives the capability-tool kill switch and the audit field set; an
    // omission here means the surface is invisible to both.
    expect(CAPABILITY_PERMISSION_FIELDS).toContain("triggers");
  });
});
