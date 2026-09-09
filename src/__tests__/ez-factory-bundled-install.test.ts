import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

// The seeder the ez-factory registration activates; stubbed to a no-op
// table so this file stays about the GRANT.
// `ez-factory-agents-bundled-wiring.test.ts` owns the seeding behaviour.
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => [],
  getAgentConfig: async () => undefined,
  createAgentConfig: async (data: { id?: string; name: string }) => ({
    id: data.id ?? "agent-x",
    name: data.name,
  }),
  deleteAgentConfigsByNameExceptId: async () => 0,
}));

afterAll(() => restoreModuleMocks());

// Import AFTER the mocks so the installer resolves to the stubbed queries.
const { resolveBundledExtensions, isBundledExtensionName } =
  await import("../extensions/bundled");
const { clampToBundledCeiling, getCeiling } = await import("../extensions/bundled-ceiling");
const { intersectPermissions, grantsToCapabilitySet } = await import(
  "../extensions/capability-types"
);
const manifest = (await import("../../extensions/ez-factory/ezcorp.config")).default;

/** The expected envelope, written once. Every assertion below compares
 *  against THIS object rather than restating literals, so a deliberate
 *  future change to (say) `maxRunsPerDay` is one edit, while an
 *  accidental divergence between manifest / grant / ceiling is still
 *  caught by the byte-match tests. */
const TRIGGERS = {
  maxCron: 25,
  maxWebhooks: 25,
  webhookPrefix: "factory-",
  maxRunsPerDay: 500,
} as const;

/** The `workflows` envelope, likewise written once. `allowDelegated` is the
 *  phase-9 addition and the one field on this shape that dies SILENTLY:
 *  `intersectPermissions` folds it with `&&`, so a side that omits it makes
 *  `undefined && true` falsy and the flag is dropped while every other
 *  field survives. */
const WORKFLOWS: NonNullable<ExtensionPermissions["workflows"]> = {
  names: ["docs-factory", "etl-factory", "draft-and-verify"],
  maxRunsPerHour: 60,
  allowDelegated: true,
};

const bundledEntry = () => resolveBundledExtensions({}).find((e) => e.name === "ez-factory")!;

beforeEach(() => {
  extStore.reset();
});

describe("bundled registry — ez-factory entry", () => {
  test("ez-factory is in the resolved bundled list and recognized as bundled", () => {
    // The `isBundled` predicate is what `permission-engine.ts` reads to
    // auto-allow `fs.write` inside a workflow. See the file header.
    const entry = bundledEntry();
    expect(entry).toBeDefined();
    expect(entry.path).toBe("extensions/ez-factory");
    expect(isBundledExtensionName("ez-factory")).toBe(true);
  });

  test("the install grant declares exactly the manifest's capability set", () => {
    const p = bundledEntry().permissions;
    expect(p.storage).toBe(true);
    expect(p.triggers).toEqual(TRIGGERS);
    expect(p.workflows).toEqual(WORKFLOWS);
    expect(p.filesystem).toEqual(["$CWD"]);
    for (const key of ["storage", "triggers", "workflows", "filesystem"]) {
      expect(p.grantedAt[key]).toBeGreaterThan(0);
    }
  });

  test("the install grant carries no llm / shell / network / env / schedule", () => {
    const p = bundledEntry().permissions;
    expect(p.llm).toBeUndefined();
    expect(p.shell).toBeUndefined();
    expect(p.network).toBeUndefined();
    expect(p.env).toBeUndefined();
    expect(p.schedule).toBeUndefined();
  });

  test("the install grant's ONLY events are the console's own page actions", () => {
    // The grant is what `hub-render-pull.ts` turns into `allowedEvents`, so
    // this list is exactly the set of page actions the host will render and
    // deliver. Anything outside the extension's own namespace could not
    // register anyway (the dispatcher's namespace check), and a `workflow:*`
    // name would register and then never fire.
    //
    // `job-run` is the one that makes the console able to START work.
    // It widens nothing: firing is authorized by the `workflows` grant.
    const p = bundledEntry().permissions;
    expect(p.eventSubscriptions).toEqual(["ez-factory:job-save", "ez-factory:job-run"]);
    expect(p.grantedAt.eventSubscriptions).toBeGreaterThan(0);
  });

  test("the install grant carries NO rbacScopes — declarations live in the manifest", () => {
    // Grants never carry declarations: `intersectPermissions` drops them
    // and the clamp comparator ignores them, so mirroring the three
    // console scopes into the grant would be dead weight that also reads
    // as ceiling drift.
    expect(
      (bundledEntry().permissions as unknown as Record<string, unknown>).rbacScopes,
    ).toBeUndefined();
    // …while the manifest DOES declare them.
    expect(
      (manifest.permissions as unknown as Record<string, unknown>).rbacScopes,
    ).toHaveLength(3);
  });
});

describe("webhookPrefix — the three-way byte match", () => {
  // The manifest, the install grant, and the ceiling row each state the
  // prefix independently. Any two disagreeing kills the grant, so all
  // three are compared to the same literal and to each other.

  test("manifest, install grant, and ceiling row all state `factory-` byte for byte", () => {
    const manifestPrefix = (
      manifest.permissions as unknown as { triggers: { webhookPrefix: string } }
    ).triggers.webhookPrefix;
    const grantPrefix = bundledEntry().permissions.triggers!.webhookPrefix;
    const ceilingPrefix = getCeiling("ez-factory")!.triggers!.webhookPrefix;

    expect(manifestPrefix).toBe("factory-");
    expect(grantPrefix).toBe(manifestPrefix);
    expect(ceilingPrefix).toBe(manifestPrefix);
    // Byte-for-byte, not just equal-after-normalisation: no trailing
    // whitespace, no case difference, same length.
    expect(ceilingPrefix.length).toBe(manifestPrefix.length);
    expect([...ceilingPrefix]).toEqual([...manifestPrefix]);
  });

  test("the ceiling row repeats every one of the four trigger fields", () => {
    // A missing numeric is the OTHER silent killer: `Math.min(NaN, …)`.
    // The granted type makes all four required, so this asserts the
    // runtime invariant in case the type is ever loosened.
    expect(getCeiling("ez-factory")!.triggers).toEqual(TRIGGERS);
  });
});

describe("allowDelegated — the phase-9 three-way match", () => {
  // The SAME class of trap as `webhookPrefix`, in the opposite direction
  // and with no type-system help. `intersectPermissions` folds this field
  // with `&&`, not `Math.min`, so a side that omits it yields
  // `undefined && true` — falsy — and the flag is dropped while `names`,
  // `maxRunsPerHour`, `storage`, `filesystem` and the whole `triggers`
  // envelope all sail through untouched. It is optional on the granted
  // type, so TypeScript refuses nothing.
  //
  // The consequence is the reason this extension exists in phase 9: with
  // the flag dropped, `runFor` refuses, and because a cron fire is
  // ownerless there is no session anywhere to surface the refusal to. The
  // observable symptom is "the nightly job just never ran" — weeks later.

  test("manifest, install grant, and ceiling row all say allowDelegated: true", () => {
    const manifestFlag = (
      manifest.permissions as unknown as { workflows: { allowDelegated?: boolean } }
    ).workflows.allowDelegated;
    const grantFlag = bundledEntry().permissions.workflows!.allowDelegated;
    const ceilingFlag = getCeiling("ez-factory")!.workflows!.allowDelegated;

    // `toBe(true)`, never `toBeTruthy()`: `intersectPermissions` tests
    // `=== true` on both sides, so a stringy `"true"` would read as
    // truthy here and STILL be dropped by the intersection.
    expect(manifestFlag).toBe(true);
    expect(grantFlag).toBe(true);
    expect(ceilingFlag).toBe(true);
  });

  test("the ceiling's workflows row matches the install grant field for field", () => {
    // Including `names` and `maxRunsPerHour`: the raise is `allowDelegated`
    // and NOTHING ELSE. A ceiling that quietly grew a fourth workflow name
    // alongside the flag would pass the flag assertion above.
    expect(getCeiling("ez-factory")!.workflows).toEqual(WORKFLOWS);
    expect(bundledEntry().permissions.workflows).toEqual(WORKFLOWS);
  });

  test("THE ASSERTION: allowDelegated SURVIVES the real intersection", () => {
    const { effective, clamped } = clampToBundledCeiling(
      "ez-factory",
      bundledEntry().permissions,
    );
    expect(clamped).toBe(false);
    expect(effective.workflows).toEqual(WORKFLOWS);
    expect(effective.workflows!.allowDelegated).toBe(true);
  });

  test("NEGATIVE CONTROL: a ceiling that OMITS the flag silently denies delegation", () => {
    // Proves the assertion above is load-bearing. Note precisely what
    // this does NOT do: it does not throw, it does not clamp `names`, it
    // does not touch `triggers`. The grant comes out looking almost
    // identical and cannot fire a delegation.
    const ceiling = getCeiling("ez-factory")!;
    const silentCeiling: ExtensionPermissions = {
      ...ceiling,
      workflows: { names: [...WORKFLOWS.names], maxRunsPerHour: 60 },
    };
    const effective = intersectPermissions(bundledEntry().permissions, silentCeiling);

    expect(effective.workflows!.allowDelegated).toBeUndefined();
    // Everything else is intact — which is exactly why nothing flags it.
    expect(effective.workflows!.names).toEqual([...WORKFLOWS.names]);
    expect(effective.workflows!.maxRunsPerHour).toBe(60);
    expect(effective.triggers).toEqual(TRIGGERS);
    expect(effective.storage).toBe(true);
  });

  test("NEGATIVE CONTROL: a MANIFEST-side drop denies it too — both sides must say it", () => {
    // The `&&` fold is symmetric, so the trap is not "remember the
    // ceiling"; it is "remember all three". Here the ceiling is correct
    // and the requested grant is the one missing the flag.
    const requested: ExtensionPermissions = {
      ...bundledEntry().permissions,
      workflows: { names: [...WORKFLOWS.names], maxRunsPerHour: 60 },
    };
    const effective = intersectPermissions(requested, getCeiling("ez-factory")!);
    expect(effective.workflows!.allowDelegated).toBeUndefined();
  });

  test("the delegated capability is actually MINTED from the effective grant", () => {
    // One rung past the intersection, and the rung that matters: the PDP
    // does not read the boolean, it reads the capability set derived from
    // it. `grantsToCapabilitySet` emits
    // `{kind:"ezcorp:workflows:run-delegated"}` on an explicit `=== true`
    // and nothing otherwise, so this is the assertion that the flag is
    // live rather than merely stored.
    const { effective } = clampToBundledCeiling("ez-factory", bundledEntry().permissions);
    const caps = grantsToCapabilitySet(effective);
    expect(caps.some((c) => c.kind === "ezcorp:workflows:run-delegated")).toBe(true);
  });

  test("NEGATIVE CONTROL: no flag ⇒ no run-delegated capability", () => {
    const stripped: ExtensionPermissions = {
      ...bundledEntry().permissions,
      workflows: { names: [...WORKFLOWS.names], maxRunsPerHour: 60 },
    };
    const caps = grantsToCapabilitySet(stripped);
    expect(caps.some((c) => c.kind === "ezcorp:workflows:run-delegated")).toBe(false);
  });

  test("the raise did NOT come with a trigger-register capability widening", () => {
    // The two grants are wired together by intent (a trigger fire is what
    // calls `runFor`), so a reviewer should be able to see that enabling
    // delegation did not also move the trigger envelope. Both kinds, both
    // still bounded by the same 25/25 as before.
    const { effective } = clampToBundledCeiling("ez-factory", bundledEntry().permissions);
    const caps = grantsToCapabilitySet(effective);
    const registerKinds = caps
      .filter((c) => c.kind === "ezcorp:triggers:register")
      .map((c) => c.value)
      .sort();
    expect(registerKinds).toEqual(["cron", "webhook"]);
    expect(effective.triggers).toEqual(TRIGGERS);
  });
});

describe("bundled ceiling — the ez-factory intersection is lossless", () => {
  test("ez-factory has a ceiling row", () => {
    expect(getCeiling("ez-factory")).not.toBeNull();
  });

  test("clampToBundledCeiling(ez-factory) does NOT clamp the install grant", () => {
    const { effective, clamped } = clampToBundledCeiling(
      "ez-factory",
      bundledEntry().permissions,
    );
    expect(clamped).toBe(false);

    expect(effective.storage).toBe(true);
    expect(effective.filesystem).toEqual(["$CWD"]);
    expect(effective.workflows).toEqual(WORKFLOWS);

    // THE ASSERTION THIS FILE EXISTS FOR: the triggers envelope survives
    // whole, with no NaN on any numeric.
    expect(effective.triggers).toEqual(TRIGGERS);
    expect(Number.isNaN(effective.triggers!.maxCron)).toBe(false);
    expect(Number.isNaN(effective.triggers!.maxWebhooks)).toBe(false);
    expect(Number.isNaN(effective.triggers!.maxRunsPerDay)).toBe(false);
  });

  test("NEGATIVE CONTROL: a one-byte prefix difference DROPS the whole grant", () => {
    // Proves the byte-match test above is load-bearing rather than
    // decorative. `factory-` vs `factory_` is one character; the result
    // is not a narrowed grant but NO grant.
    const mismatchedCeiling: ExtensionPermissions = {
      ...getCeiling("ez-factory")!,
      triggers: { ...TRIGGERS, webhookPrefix: "factory_" },
    };
    const effective = intersectPermissions(bundledEntry().permissions, mismatchedCeiling);
    expect(effective.triggers).toBeUndefined();
    // Silent: everything else sails through, so nothing else in the
    // system flags it.
    expect(effective.storage).toBe(true);
    expect(effective.filesystem).toEqual(["$CWD"]);
  });

  test("NEGATIVE CONTROL: a missing numeric yields NaN, not a bound", () => {
    // The `Math.min(NaN, …)` trap the module header names. Cast because
    // the granted type requires all four — the point is that the runtime
    // has no defence if the type is ever loosened.
    const holedCeiling = {
      ...getCeiling("ez-factory")!,
      triggers: {
        maxWebhooks: 25,
        webhookPrefix: "factory-",
        maxRunsPerDay: 500,
      },
    } as unknown as ExtensionPermissions;
    const effective = intersectPermissions(bundledEntry().permissions, holedCeiling);
    expect(effective.triggers).toBeDefined();
    expect(Number.isNaN(effective.triggers!.maxCron)).toBe(true);
  });
});
