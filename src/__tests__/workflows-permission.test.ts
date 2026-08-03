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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateManifestV2, WEBHOOK_PREFIX_RE } from "../extensions/manifest";
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

  test("C3 — accepts an EMPTY names list when, and only when, delegation is asked for", () => {
    expect(validateManifestV2(manifest({ workflows: { names: [], allowDelegated: true } })).valid)
      .toBe(true);
    // PAIRED NEGATIVE — the bit is what makes the empty list legal.
    for (const block of [{ names: [] }, { names: [], allowDelegated: false }]) {
      const res = validateManifestV2(manifest({ workflows: block }));
      expect(res.valid).toBe(false);
      expect(res.errors.join("\n")).toContain("permissions.workflows.names");
    }
  });

  test("C3 — accepts names AND the delegated bit together", () => {
    expect(
      validateManifestV2(manifest({ workflows: { names: ["deploy"], allowDelegated: true } })).valid,
    ).toBe(true);
  });

  test("C3 — a non-boolean allowDelegated is rejected, and names is not blamed for it", () => {
    // A typo must not silently read as "not delegated" and then reject the
    // author's empty `names` with a message pointing at the wrong line.
    const res = validateManifestV2(
      manifest({ workflows: { names: [], allowDelegated: "yes" } }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toContain("permissions.workflows.allowDelegated must be a boolean");
  });

  test("C3 — a delegated declaration still rejects a namespace-forging name", () => {
    const res = validateManifestV2(
      manifest({ workflows: { names: ["other-ext:deploy"], allowDelegated: true } }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.join("\n")).toContain("namespace separator");
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

// ── C3 / D-3 — the delegated-only carve-out ──────────────────────────
//
// `allowDelegated` opts an extension into firing workflows it does NOT
// ship, so it has no `names` of its own. Before C3 every empty-name path
// through the clamp returned `undefined`, `granted.workflows` was absent,
// and rung 2 of the handler refused — the feature was unreachable by
// construction.
//
// The carve-out is exactly one case: "empty names AND the delegated bit
// survived on BOTH sides". Every test below that shows the delegated case
// working is PAIRED with the same input minus the bit, asserting the
// pre-C3 `undefined`. A clamp that admits more than intended passes every
// "does the new feature work" test ever written; only the pairs catch it.

/** The manifest declaration a delegated-only author writes. */
const DELEGATED_ONLY = { names: [] as string[], allowDelegated: true };

describe("clampWorkflowsPermission — BRANCH 1: manifest has no `names` array", () => {
  // `clamp-permissions.ts` — `if (!Array.isArray(manifest.names)) return withoutNames();`
  // Reachable in production because a manifest is parsed from untrusted
  // JSON/TS on disk; the declared type says `names` is required.
  const noNames = { allowDelegated: true } as unknown as { names: string[]; allowDelegated: true };

  test("a delegated-only declaration survives with an EMPTY name list", () => {
    const out = clampWorkflowsPermission(undefined, noNames);
    expect(out).toEqual({
      names: [],
      maxRunsPerHour: WORKFLOW_RUNS_PER_HOUR_DEFAULT,
      allowDelegated: true,
    });
  });

  test("PAIRED NEGATIVE — the same shape without the bit still grants nothing", () => {
    expect(clampWorkflowsPermission(undefined, {} as unknown as { names: string[] }))
      .toBeUndefined();
  });

  test("PAIRED NEGATIVE — an install that DECLINES delegation grants nothing", () => {
    // The submitted side must also say yes. Declining leaves nothing at
    // all: there are no names to fall back to.
    expect(
      clampWorkflowsPermission({ names: [], maxRunsPerHour: 9 }, noNames),
    ).toBeUndefined();
  });
});

describe("clampWorkflowsPermission — BRANCH 2: no VALID manifest name", () => {
  // `clamp-permissions.ts` — `if (manifestNames.length === 0) return withoutNames();`

  test("the canonical `{names: [], allowDelegated: true}` declaration survives", () => {
    const out = clampWorkflowsPermission(undefined, DELEGATED_ONLY);
    expect(out).toEqual({
      names: [],
      maxRunsPerHour: WORKFLOW_RUNS_PER_HOUR_DEFAULT,
      allowDelegated: true,
    });
  });

  test("PAIRED NEGATIVE — `{names: []}` alone is still the husk it always was", () => {
    expect(clampWorkflowsPermission(undefined, { names: [] })).toBeUndefined();
  });

  test("a name that would forge a namespace is STILL dropped by a delegated grant", () => {
    // The carve-out opens the empty case; it must not smuggle an invalid
    // name through with it. `names` comes back empty, not `["ext:forged"]`.
    const out = clampWorkflowsPermission(undefined, {
      names: ["ext:forged"],
      allowDelegated: true,
    });
    expect(out?.names).toEqual([]);
    expect(out?.allowDelegated).toBe(true);
  });

  test("PAIRED NEGATIVE — the forged name without the bit grants nothing", () => {
    expect(clampWorkflowsPermission(undefined, { names: ["ext:forged"] })).toBeUndefined();
  });
});

describe("clampWorkflowsPermission — BRANCH 3: empty submitted ∩ manifest", () => {
  // `clamp-permissions.ts` — `if (names.length === 0) return withoutNames();`

  test("a delegated grant survives an empty NAME intersection, keeping no names", () => {
    const out = clampWorkflowsPermission(
      { names: ["nope"], maxRunsPerHour: 9, allowDelegated: true },
      { names: ["deploy"], allowDelegated: true },
    );
    expect(out).toEqual({ names: [], maxRunsPerHour: 9, allowDelegated: true });
  });

  test("PAIRED NEGATIVE — the identical inputs without the bit drop the grant", () => {
    expect(
      clampWorkflowsPermission(
        { names: ["nope"], maxRunsPerHour: 9 },
        { names: ["deploy"] },
      ),
    ).toBeUndefined();
  });
});

describe("clampWorkflowsPermission — `allowDelegated` cannot be self-granted", () => {
  test("the manifest is the ceiling: an install cannot introduce the bit", () => {
    const out = clampWorkflowsPermission(
      { names: ["deploy"], maxRunsPerHour: 9, allowDelegated: true },
      { names: ["deploy"] },
    );
    expect(out?.names).toEqual(["deploy"]);
    expect(out?.allowDelegated).toBeUndefined();
  });

  test("an install may DECLINE a declared bit — the grant keeps only the names", () => {
    const out = clampWorkflowsPermission(
      { names: ["deploy"], maxRunsPerHour: 9 },
      { names: ["deploy"], allowDelegated: true },
    );
    expect(out).toEqual({ names: ["deploy"], maxRunsPerHour: 9 });
  });

  test("declared AND accepted ⇒ names and the bit both survive", () => {
    const out = clampWorkflowsPermission(
      { names: ["deploy"], maxRunsPerHour: 9, allowDelegated: true },
      { names: ["deploy"], allowDelegated: true },
    );
    expect(out).toEqual({ names: ["deploy"], maxRunsPerHour: 9, allowDelegated: true });
  });

  test("a truthy-but-not-true value does not count as consent on either side", () => {
    const truthy = 1 as unknown as boolean;
    expect(
      clampWorkflowsPermission(
        { names: ["deploy"], maxRunsPerHour: 9, allowDelegated: truthy },
        { names: ["deploy"], allowDelegated: true },
      )?.allowDelegated,
    ).toBeUndefined();
    expect(
      clampWorkflowsPermission(
        { names: ["deploy"], maxRunsPerHour: 9, allowDelegated: true },
        { names: ["deploy"], allowDelegated: truthy },
      )?.allowDelegated,
    ).toBeUndefined();
  });

  test("a delegated-only grant still carries a rate ceiling, narrowed as ever", () => {
    // The bound is not optional just because there are no names: a
    // delegated run fans out into agent steps exactly like a named one,
    // and rung 2 refuses a non-positive ceiling.
    expect(
      clampWorkflowsPermission(
        { names: [], maxRunsPerHour: 3, allowDelegated: true },
        { names: [], maxRunsPerHour: 50, allowDelegated: true },
      )?.maxRunsPerHour,
    ).toBe(3);
  });
});

describe("clampWorkflowsPermission — the NON-delegated path is byte-identical", () => {
  test("no input anywhere mentioning delegation gains the key", () => {
    // The single guard against the failure mode this whole carve-out
    // risks: an ordinary extension quietly acquiring delegated reach.
    const cases: Array<Parameters<typeof clampWorkflowsPermission>> = [
      [undefined, { names: ["deploy", "sync"] }],
      [{ names: ["deploy"], maxRunsPerHour: 4 }, { names: ["deploy"], maxRunsPerHour: 10 }],
      [{ names: ["deploy", "deploy"], maxRunsPerHour: 9 }, { names: ["deploy"] }],
      [{ names: ["deploy", "sneaky"], maxRunsPerHour: 9 }, { names: ["deploy"] }],
    ];
    for (const [submitted, manifestDecl] of cases) {
      const out = clampWorkflowsPermission(submitted, manifestDecl);
      expect(out).toBeDefined();
      expect(out?.allowDelegated).toBeUndefined();
      expect(Object.keys(out as object).sort()).toEqual(["maxRunsPerHour", "names"]);
      expect(out?.names.length).toBeGreaterThan(0);
    }
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

  test("C3 — a delegated-only grant survives the FULL clamp, not just the helper", () => {
    // `clampExtensionPermissions` attaches `workflows` on truthiness
    // (`if (workflows) clamped.workflows = workflows`), so a helper that
    // returned the grant would still be dropped here if the wiring were
    // wrong. Assert the whole path, not the unit.
    const clamped = clampExtensionPermissions(
      { workflows: { names: [], maxRunsPerHour: 4, allowDelegated: true } },
      { workflows: DELEGATED_ONLY },
    );
    expect(clamped.workflows).toEqual({ names: [], maxRunsPerHour: 4, allowDelegated: true });
  });

  test("C3 — the kill-switch drops a delegated-only grant too", () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    try {
      const clamped = clampExtensionPermissions(
        { workflows: { names: [], maxRunsPerHour: 4, allowDelegated: true } },
        { workflows: DELEGATED_ONLY },
      );
      expect(clamped.workflows).toBeUndefined();
    } finally {
      delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
    }
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

  test("C3 — a delegated-only declaration is persisted, not silently dropped", () => {
    const grant = buildFullGrantFromManifest(manifest({ workflows: DELEGATED_ONLY }), 1234);
    expect(grant.workflows).toEqual({
      names: [],
      maxRunsPerHour: WORKFLOW_RUNS_PER_HOUR_DEFAULT,
      allowDelegated: true,
    });
    expect(grant.grantedAt.workflows).toBe(1234);
  });

  test("PAIRED NEGATIVE — a plain declaration gains no delegated key on this path", () => {
    const grant = buildFullGrantFromManifest(
      manifest({ workflows: { names: ["deploy"], maxRunsPerHour: 7 } }),
      1234,
    );
    expect(grant.workflows?.allowDelegated).toBeUndefined();
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

  // ── C3 — the delegated cap ────────────────────────────────────────
  function delegated(names: string[], allowDelegated?: boolean): ExtensionPermissions {
    return {
      grantedAt: {},
      workflows: {
        names,
        maxRunsPerHour: 10,
        ...(allowDelegated !== undefined ? { allowDelegated } : {}),
      },
    };
  }

  test("a delegated-only grant emits exactly ONE kind-only cap", () => {
    expect(grantsToCapabilitySet(delegated([], true))).toEqual([
      { kind: "ezcorp:workflows:run-delegated" },
    ]);
  });

  test("names and the bit emit both cap families side by side", () => {
    expect(grantsToCapabilitySet(delegated(["deploy"], true))).toEqual([
      { kind: "ezcorp:workflows:run", value: "deploy" },
      { kind: "ezcorp:workflows:run-delegated" },
    ]);
  });

  test("PAIRED NEGATIVE — a named grant WITHOUT the bit emits no delegated cap", () => {
    // The whole point: an ordinary extension gains nothing.
    for (const g of [delegated(["deploy"]), delegated(["deploy"], false)]) {
      const caps = grantsToCapabilitySet(g);
      expect(caps).toEqual([{ kind: "ezcorp:workflows:run", value: "deploy" }]);
      expect(caps.some((c) => c.kind === "ezcorp:workflows:run-delegated")).toBe(false);
    }
  });

  test("the two kinds do not satisfy each other in EITHER direction", () => {
    // A separate kind is the entire mechanism. If `run-delegated` covered
    // `run` (or vice versa) the per-name clamp would be bypassable.
    const delegatedOnly = grantsToCapabilitySet(delegated([], true));
    const namedOnly = grantsToCapabilitySet(delegated(["deploy"]));
    expect(isSubset([{ kind: "ezcorp:workflows:run", value: "deploy" }], delegatedOnly))
      .toBe(false);
    expect(isSubset([{ kind: "ezcorp:workflows:run-delegated" }], namedOnly)).toBe(false);
    // …and each still satisfies itself.
    expect(isSubset([{ kind: "ezcorp:workflows:run-delegated" }], delegatedOnly)).toBe(true);
    expect(isSubset([{ kind: "ezcorp:workflows:run", value: "deploy" }], namedOnly)).toBe(true);
  });

  test("a hand-edited row with no `names` key translates instead of throwing", () => {
    // An empty `names` is now a legal shape, so a row that omits the key
    // is a realistic input. `for…of undefined` inside the PDP's grant
    // translation would turn a malformed row into a 500 rather than a
    // denial.
    const halfWritten = {
      grantedAt: {},
      workflows: { maxRunsPerHour: 10, allowDelegated: true },
    } as unknown as ExtensionPermissions;
    expect(grantsToCapabilitySet(halfWritten)).toEqual([
      { kind: "ezcorp:workflows:run-delegated" },
    ]);
  });

  test("the delegated kind is NOT sensitive either — see the P2 note", () => {
    // Same reasoning as `run`, checked explicitly for C3 and recorded in
    // capability-types.ts. The grep test below pins that record.
    expect(SENSITIVE_KINDS.has("ezcorp:workflows:run-delegated")).toBe(false);
  });
});

// ── P2 (acceptance criterion) — the revisit condition was checked ─────
//
// `capability-types.ts` carries a standing instruction: if a future step
// kind can reach a side effect that is NOT independently PDP-gated,
// revisit the decision to leave `ezcorp:workflows:run` out of
// `SENSITIVE_KINDS`. C3 adds a second non-sensitive workflow kind, so it
// owed that check an answer IN THE FILE — a future reader must not have
// to re-derive it.
//
// This is a source-text test on purpose, and it is the mechanism that
// makes P2 enforceable rather than aspirational: no runtime behaviour can
// observe whether a rationale was written down, so the only thing that
// can fail the build when the note is deleted is a test that reads the
// file. Precedent: `audit-regressions.test.ts` reads `registry.ts` to
// pin a trust-boundary import out of existence.
describe("P2 — the SENSITIVE_KINDS revisit condition is answered in the source", () => {
  const CAP_TYPES = resolve(import.meta.dir, "../extensions/capability-types.ts");
  const src = readFileSync(CAP_TYPES, "utf8");
  const lines = src.split("\n");

  /** The standing instruction the P2 note is required to sit next to. */
  const REVISIT = "revisit this decision first.";
  /** The note's stable heading. */
  const P2_HEADING = "P2 · C3 CHECKED THE REVISIT CONDITION ABOVE. The answer HELD.";

  test("the standing revisit instruction still exists to be answered", () => {
    expect(lines.filter((l) => l.includes(REVISIT))).toHaveLength(1);
  });

  test("the P2 note exists and is ADJACENT to that instruction", () => {
    const revisitIdx = lines.findIndex((l) => l.includes(REVISIT));
    const p2Idx = lines.findIndex((l) => l.includes(P2_HEADING));
    expect(p2Idx).toBeGreaterThan(-1);
    // Adjacent, and BELOW it — the note answers the instruction, so a
    // reader who finds the instruction cannot miss the answer.
    expect(p2Idx - revisitIdx).toBeGreaterThan(0);
    expect(p2Idx - revisitIdx).toBeLessThanOrEqual(3);
  });

  test("the note is inside the omission block, not appended somewhere else", () => {
    const omissionIdx = lines.findIndex((l) => l.includes("DELIBERATE OMISSION"));
    const p2Idx = lines.findIndex((l) => l.includes(P2_HEADING));
    const firstCodeIdx = lines.findIndex((l) => l.includes("function keyOf"));
    expect(omissionIdx).toBeGreaterThan(-1);
    expect(p2Idx).toBeGreaterThan(omissionIdx);
    expect(p2Idx).toBeLessThan(firstCodeIdx);
  });

  test("the note records the ANSWER, not just that a check happened", () => {
    // Each of these is a load-bearing claim of the C3 argument. A note
    // that says "we checked, it's fine" is worth nothing to the reader
    // who has to decide whether it still holds.
    for (const claim of [
      // Reason 1 — the only thing holding the decision up.
      "still hits the PDP and still fails CLOSED",
      // Reason 2 — honestly marked as replaced, not preserved.
      "does NOT survive",
      // The name of the thing being decided about.
      "ezcorp:workflows:run-delegated",
      // The condition that would reopen it.
      "WHAT WOULD REOPEN THIS",
    ]) {
      expect(src).toContain(claim);
    }
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

  // ── C3 — the delegated bit through the intersection ───────────────
  function d(names: string[], allowDelegated?: boolean): ExtensionPermissions {
    return {
      grantedAt: {},
      workflows: {
        names,
        maxRunsPerHour: 10,
        ...(allowDelegated !== undefined ? { allowDelegated } : {}),
      },
    };
  }

  test("a delegated-only grant SURVIVES the intersection with empty names", () => {
    // Without this the ceiling clamp and every parent→child narrowing
    // would re-introduce D-3 one layer down: the clamp keeps the grant,
    // then the first intersection deletes it.
    expect(intersectPermissions(d([], true), d([], true)).workflows).toEqual({
      names: [],
      maxRunsPerHour: 10,
      allowDelegated: true,
    });
  });

  test("PAIRED NEGATIVE — one side silent ⇒ the bit dies AND so does the grant", () => {
    // `&&`, not `Math.min`: an omitted ceiling field denies delegation
    // rather than producing NaN. With no names left, nothing survives.
    expect(intersectPermissions(d([], true), d([])).workflows).toBeUndefined();
    expect(intersectPermissions(d([]), d([], true)).workflows).toBeUndefined();
  });

  test("PAIRED NEGATIVE — names survive without inheriting the other side's bit", () => {
    const out = intersectPermissions(d(["a"], true), d(["a"]));
    expect(out.workflows).toEqual({ names: ["a"], maxRunsPerHour: 10 });
    expect(out.workflows?.allowDelegated).toBeUndefined();
  });

  test("names and the bit intersect independently", () => {
    expect(intersectPermissions(d(["a", "b"], true), d(["b"], true)).workflows).toEqual({
      names: ["b"],
      maxRunsPerHour: 10,
      allowDelegated: true,
    });
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

  test("every ceiling row declaring `triggers` carries all four fields AND a usable prefix", () => {
    // The C2 trap, added when `ez-factory` became the first bundled row
    // to declare `triggers`. Two failure modes, both silent at boot:
    //
    //   - a missing numeric ⇒ `Math.min(NaN, …)`, same as workflows /
    //     schedule above;
    //   - a `webhookPrefix` that is empty or fails `WEBHOOK_PREFIX_RE`.
    //     That one is worse than the numerics: `intersectPermissions`
    //     DROPS the whole `triggers` grant when the two sides' prefixes
    //     disagree, and `clampTriggersPermission` refuses to grant at all
    //     on a malformed manifest prefix rather than defaulting one. A
    //     ceiling row is only useful if it can actually match a legal
    //     manifest prefix.
    //
    // Per-extension byte-matching against the owning manifest lives with
    // that extension (ez-factory's is in
    // `ez-factory-bundled-install.test.ts`); this is the cross-row floor
    // every future `triggers` row inherits for free.
    for (const [name, ceiling] of Object.entries(BUNDLED_CEILING)) {
      const t = ceiling.triggers;
      if (!t) continue;
      const label = `BUNDLED_CEILING["${name}"].triggers`;
      expect(Number.isFinite(t.maxCron), label).toBe(true);
      expect(Number.isFinite(t.maxWebhooks), label).toBe(true);
      expect(Number.isFinite(t.maxRunsPerDay), label).toBe(true);
      expect(typeof t.webhookPrefix, label).toBe("string");
      expect(WEBHOOK_PREFIX_RE.test(t.webhookPrefix), label).toBe(true);
    }
  });
});
