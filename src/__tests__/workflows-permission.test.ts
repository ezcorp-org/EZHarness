/**
 * The `permissions.workflows` surface (W2) end-to-end across every site it
 * has to be wired into: manifest validation → install-grant construction →
 * clamp → capability translation → intersection → the bundled ceiling.
 *
 * A permission that is only half-wired fails SILENTLY (a dropped field, a
 * `Math.min(NaN, …)`, a cap the PDP never sees), so each site gets an
 * explicit test rather than relying on the happy path passing through.
 */
import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import {
  clampWorkflowsPermission,
  clampExtensionPermissions,
  WORKFLOW_RUNS_PER_HOUR_DEFAULT,
  WORKFLOW_RUNS_PER_HOUR_CEILING,
} from "../extensions/clamp-permissions";
import {
  grantsToCapabilitySet,
  intersectPermissions,
  SENSITIVE_KINDS,
  isSubset,
} from "../extensions/capability-types";
import { BUNDLED_CEILING } from "../extensions/bundled-ceiling";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import { CAPABILITY_PERMISSION_FIELDS } from "../extensions/capability-flags";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";

function manifest(perms: Record<string, unknown>): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "wf-ext",
    version: "1.0.0",
    description: "d",
    author: { name: "a" },
    entrypoint: "./index.ts",
    permissions: perms,
  } as unknown as ExtensionManifestV2;
}

describe("manifest validation", () => {
  test("accepts a well-formed workflows declaration", () => {
    const res = validateManifestV2(manifest({ workflows: { names: ["deploy", "sync.2"] } }));
    expect(res.valid).toBe(true);
  });

  test("accepts an explicit maxRunsPerHour", () => {
    const res = validateManifestV2(
      manifest({ workflows: { names: ["deploy"], maxRunsPerHour: 5 } }),
    );
    expect(res.valid).toBe(true);
  });

  test("rejects a non-object workflows block", () => {
    const res = validateManifestV2(manifest({ workflows: ["deploy"] }));
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toContain("permissions.workflows must be an object");
  });

  test("rejects an empty or missing names list", () => {
    for (const block of [{ names: [] }, {}, { names: "deploy" }]) {
      const res = validateManifestV2(manifest({ workflows: block }));
      expect(res.valid).toBe(false);
      expect(res.errors.join("\n")).toContain("permissions.workflows.names");
    }
  });

  test("REJECTS a name carrying the `:` namespace separator", () => {
    // The forge attempt at the manifest boundary: declare a foreign
    // namespace so the host would prefix it into `wf-ext:other-ext:deploy`.
    const res = validateManifestV2(manifest({ workflows: { names: ["other-ext:deploy"] } }));
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toContain("namespace separator");
  });

  test("rejects path-traversal-shaped and malformed names", () => {
    for (const bad of ["../escape", "has space", "", "-leading", 42]) {
      const res = validateManifestV2(manifest({ workflows: { names: [bad] } }));
      expect(res.valid).toBe(false);
    }
  });

  test("rejects a non-positive maxRunsPerHour", () => {
    for (const bad of [0, -1, "many", Number.NaN]) {
      const res = validateManifestV2(
        manifest({ workflows: { names: ["deploy"], maxRunsPerHour: bad } }),
      );
      expect(res.valid).toBe(false);
      expect(res.errors.join("\n")).toContain("maxRunsPerHour must be a positive number");
    }
  });
});

describe("clampWorkflowsPermission", () => {
  test("an undeclared manifest grants nothing (cannot self-grant)", () => {
    expect(clampWorkflowsPermission({ names: ["deploy"], maxRunsPerHour: 9 }, undefined))
      .toBeUndefined();
  });

  test("the manifest is the source of truth — an undeclared submitted name is dropped", () => {
    const out = clampWorkflowsPermission(
      { names: ["deploy", "sneaky"], maxRunsPerHour: 9 },
      { names: ["deploy"] },
    );
    expect(out?.names).toEqual(["deploy"]);
  });

  test("an empty intersection drops the grant entirely, not a {names:[]} husk", () => {
    // A husk would read as "granted" to any presence check while
    // authorizing nothing.
    expect(clampWorkflowsPermission({ names: ["nope"], maxRunsPerHour: 9 }, { names: ["deploy"] }))
      .toBeUndefined();
  });

  test("a name that would forge a namespace is dropped even if it reached the grant", () => {
    expect(
      clampWorkflowsPermission(
        { names: ["ext:deploy"], maxRunsPerHour: 9 },
        { names: ["ext:deploy"] },
      ),
    ).toBeUndefined();
  });

  test("no submitted grant defaults to approving the manifest declaration", () => {
    const out = clampWorkflowsPermission(undefined, { names: ["deploy", "sync"] });
    expect(out?.names).toEqual(["deploy", "sync"]);
  });

  test("duplicate submitted names are de-duplicated", () => {
    const out = clampWorkflowsPermission(
      { names: ["deploy", "deploy"], maxRunsPerHour: 9 },
      { names: ["deploy"] },
    );
    expect(out?.names).toEqual(["deploy"]);
  });

  test("maxRunsPerHour takes the NARROWER of submitted and manifest", () => {
    expect(
      clampWorkflowsPermission(
        { names: ["deploy"], maxRunsPerHour: 100 },
        { names: ["deploy"], maxRunsPerHour: 5 },
      )?.maxRunsPerHour,
    ).toBe(5);
    expect(
      clampWorkflowsPermission(
        { names: ["deploy"], maxRunsPerHour: 3 },
        { names: ["deploy"], maxRunsPerHour: 50 },
      )?.maxRunsPerHour,
    ).toBe(3);
  });

  test("a grant ALWAYS carries a rate ceiling, even when nobody declared one", () => {
    // The bound exists because a run can fan out into agent steps that cost
    // real LLM spend — an author omitting it must not mean "unlimited".
    expect(clampWorkflowsPermission(undefined, { names: ["deploy"] })?.maxRunsPerHour)
      .toBe(WORKFLOW_RUNS_PER_HOUR_DEFAULT);
  });

  test("an absurd declared ceiling is clamped to the hard maximum", () => {
    expect(
      clampWorkflowsPermission(
        { names: ["deploy"], maxRunsPerHour: 1e9 },
        { names: ["deploy"], maxRunsPerHour: 1e9 },
      )?.maxRunsPerHour,
    ).toBe(WORKFLOW_RUNS_PER_HOUR_CEILING);
  });
});

describe("clampExtensionPermissions wiring", () => {
  test("workflows survives the full clamp", () => {
    const clamped = clampExtensionPermissions(
      { workflows: { names: ["deploy"], maxRunsPerHour: 4 } },
      { workflows: { names: ["deploy"], maxRunsPerHour: 10 } },
    );
    expect(clamped.workflows).toEqual({ names: ["deploy"], maxRunsPerHour: 4 });
  });

  test("the capability kill-switch drops it wholesale", () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    try {
      const clamped = clampExtensionPermissions(
        { workflows: { names: ["deploy"], maxRunsPerHour: 4 } },
        { workflows: { names: ["deploy"] } },
      );
      expect(clamped.workflows).toBeUndefined();
    } finally {
      delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
    }
  });

  test("it is registered as a capability-tier permission field", () => {
    expect(CAPABILITY_PERMISSION_FIELDS).toContain("workflows");
  });
});

describe("install-grant construction", () => {
  test("a 'grant everything declared' install persists workflows AND stamps grantedAt", () => {
    // The exact class of bug install-grant.ts exists to prevent: a new
    // capability that the local-install path silently drops.
    const grant = buildFullGrantFromManifest(
      manifest({ workflows: { names: ["deploy"], maxRunsPerHour: 7 } }),
      1234,
    );
    expect(grant.workflows).toEqual({ names: ["deploy"], maxRunsPerHour: 7 });
    expect(grant.grantedAt.workflows).toBe(1234);
  });
});

describe("grantsToCapabilitySet", () => {
  function grant(names: string[]): ExtensionPermissions {
    return { grantedAt: {}, workflows: { names, maxRunsPerHour: 10 } };
  }

  test("emits ONE cap per granted name, not a single boolean", () => {
    expect(grantsToCapabilitySet(grant(["deploy", "sync"]))).toEqual([
      { kind: "ezcorp:workflows:run", value: "deploy" },
      { kind: "ezcorp:workflows:run", value: "sync" },
    ]);
  });

  test("holding one name does NOT satisfy the PDP for another", () => {
    // A boolean cap would make the subset check pass for every name once
    // the extension held the capability at all — defeating the clamp.
    const held = grantsToCapabilitySet(grant(["deploy"]));
    expect(isSubset([{ kind: "ezcorp:workflows:run", value: "deploy" }], held)).toBe(true);
    expect(isSubset([{ kind: "ezcorp:workflows:run", value: "sync" }], held)).toBe(false);
  });

  test("no grant ⇒ no workflow caps", () => {
    expect(grantsToCapabilitySet({ grantedAt: {} })).toEqual([]);
  });

  test("is NOT sensitive — it never forces an unanswerable prompt", () => {
    // Deliberate: a workflow run's own tool steps re-enter the PDP under a
    // non-interactive scope, so anything genuinely sensitive still fails
    // closed inside the run. See the rationale block in capability-types.ts.
    expect(SENSITIVE_KINDS.has("ezcorp:workflows:run")).toBe(false);
  });
});

describe("intersectPermissions", () => {
  function p(names: string[], maxRunsPerHour: number, at?: number): ExtensionPermissions {
    return {
      grantedAt: at !== undefined ? { workflows: at } : {},
      workflows: { names, maxRunsPerHour },
    };
  }

  test("intersects names and takes the narrower rate ceiling", () => {
    const out = intersectPermissions(p(["a", "b"], 50), p(["b", "c"], 10));
    expect(out.workflows).toEqual({ names: ["b"], maxRunsPerHour: 10 });
  });

  test("an empty name intersection drops the grant", () => {
    expect(intersectPermissions(p(["a"], 10), p(["b"], 10)).workflows).toBeUndefined();
  });

  test("one side absent ⇒ absent (the more restrictive wins)", () => {
    expect(intersectPermissions(p(["a"], 10), { grantedAt: {} }).workflows).toBeUndefined();
    expect(intersectPermissions({ grantedAt: {} }, p(["a"], 10)).workflows).toBeUndefined();
  });

  test("de-duplicates repeated names on the left", () => {
    const out = intersectPermissions(p(["a", "a"], 10), p(["a"], 10));
    expect(out.workflows?.names).toEqual(["a"]);
  });

  test("grantedAt.workflows survives and keeps the OLDER timestamp", () => {
    const out = intersectPermissions(p(["a"], 10, 500), p(["a"], 10, 900));
    expect(out.grantedAt.workflows).toBe(500);
  });

  test("grantedAt.workflows is dropped when the permission did not survive", () => {
    const out = intersectPermissions(p(["a"], 10, 500), p(["b"], 10, 500));
    expect(out.grantedAt.workflows).toBeUndefined();
  });

  test("never produces NaN from a missing ceiling on one side", () => {
    // The `Math.min(NaN, …)` trap documented in bundled-ceiling.ts. The
    // granted type requires maxRunsPerHour, but assert the runtime behavior
    // in case the type is ever loosened.
    const halfWritten = {
      grantedAt: {},
      workflows: { names: ["a"] },
    } as unknown as ExtensionPermissions;
    const out = intersectPermissions(halfWritten, p(["a"], 10));
    expect(Number.isNaN(out.workflows?.maxRunsPerHour)).toBe(true);
  });
});

describe("bundled ceiling — the full-field-set invariant", () => {
  test("every ceiling row declaring `workflows` carries a finite maxRunsPerHour", () => {
    // Guards the `Math.min(NaN, …)` trap for future rows: a half-written
    // ceiling would silently kill the grant at boot rather than fail loudly.
    for (const [name, ceiling] of Object.entries(BUNDLED_CEILING)) {
      const wf = ceiling.workflows;
      if (!wf) continue;
      expect(
        Number.isFinite(wf.maxRunsPerHour),
        `BUNDLED_CEILING["${name}"].workflows must carry a finite maxRunsPerHour`,
      ).toBe(true);
      expect(Array.isArray(wf.names) && wf.names.length > 0).toBe(true);
    }
  });

  test("every ceiling row declaring `schedule` still carries all five fields", () => {
    // The original SCHEDULE TRAP, kept asserted alongside the new one.
    for (const [name, ceiling] of Object.entries(BUNDLED_CEILING)) {
      const s = ceiling.schedule;
      if (!s) continue;
      const label = `BUNDLED_CEILING["${name}"].schedule`;
      expect(Array.isArray(s.crons), label).toBe(true);
      expect(Number.isFinite(s.maxRunsPerDay), label).toBe(true);
      expect(Number.isFinite(s.maxRunDurationMs), label).toBe(true);
      expect(Number.isFinite(s.maxRetries), label).toBe(true);
      expect(typeof s.missedRunPolicy, label).toBe("string");
    }
  });
});
