/**
 * ez-factory's bundled registration + the FIRST `triggers` ceiling row.
 *
 * Two things are being locked in here, and the second is the reason
 * `ezcorp.config.ts` and the `bundled-ceiling.ts` row have to land in one
 * commit.
 *
 * ── 1. Bundled siting is load-bearing, not a preference ───────────────
 *
 * `write_file` / `emit_artifact` (8.4) only authorize inside a workflow
 * because the sensitive-capability gate in `permission-engine.ts`
 * short-circuits to allow on `registry.isBundled(...) === true`
 * (`bundled-ceiling-auto-allow`). `fs.write` IS sensitive. For a
 * non-bundled extension the PDP returns `prompt`, a workflow's
 * non-interactive scope rejects a prompt synchronously, and the run
 * terminalizes `awaiting_approval`. So "is ez-factory in the bundled
 * list" is a security assertion, not bookkeeping.
 *
 * ── 2. The trigger grant dies SILENTLY, so it must be proven alive ────
 *
 * `intersectPermissions` treats `triggers.webhookPrefix` as a namespace
 * claim: there is no "narrower of the two", so when the manifest and the
 * ceiling disagree it DROPS the entire `triggers` grant. No throw, no
 * warning, no audit row — the extension just has no dynamic triggers from
 * that boot onward. The four numerics fail the same way through
 * `Math.min(NaN, …)`.
 *
 * A test asserting `getCeiling("ez-factory") !== null` would pass on a
 * mismatched prefix. So the assertions below run the REAL intersection and
 * require the grant to come out the other side intact — and, so the
 * assertion is not vacuous, two negative-control tests mutate one byte /
 * drop one numeric and require the grant to die. No bundled extension had
 * ever declared `triggers` before this one; this file is that path's only
 * exercise.
 *
 * Mock shape copied from `ez-code-bundled-install.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

interface StoredExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: unknown;
  source: string;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  checksumVerified: boolean;
  consecutiveFailures: number;
}

let store: Map<string, StoredExtension>;
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
  },
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
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
const { ensureBundledExtensions, resolveBundledExtensions, isBundledExtensionName } =
  await import("../extensions/bundled");
const { clampToBundledCeiling, getCeiling } = await import("../extensions/bundled-ceiling");
const { intersectPermissions } = await import("../extensions/capability-types");
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

const bundledEntry = () => resolveBundledExtensions({}).find((e) => e.name === "ez-factory")!;

beforeEach(() => {
  store = new Map();
  nextId = 0;
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
    expect(p.workflows).toEqual({
      names: ["docs-factory", "etl-factory", "draft-and-verify"],
      maxRunsPerHour: 60,
    });
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

  test("the install grant's ONLY event is the console's own page action", () => {
    // The grant is what `hub-render-pull.ts` turns into `allowedEvents`, so
    // this list is exactly the set of page actions the host will render and
    // deliver. Anything outside the extension's own namespace could not
    // register anyway (the dispatcher's namespace check), and a `workflow:*`
    // name would register and then never fire.
    const p = bundledEntry().permissions;
    expect(p.eventSubscriptions).toEqual(["ez-factory:job-save"]);
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
    expect(effective.workflows).toEqual({
      names: ["docs-factory", "etl-factory", "draft-and-verify"],
      maxRunsPerHour: 60,
    });

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

describe("ensureBundledExtensions — ez-factory first-boot install", () => {
  test("creates an enabled, bundled-flagged ez-factory row", async () => {
    await ensureBundledExtensions();
    const row = store.get("ez-factory");
    expect(row).toBeDefined();
    expect(row!.name).toBe("ez-factory");
    expect(row!.enabled).toBe(true);
    expect(row!.isBundled).toBe(true);
  });

  test("BOOT PROOF: the persisted grant still carries the full trigger envelope", async () => {
    // This is B10's actual failure mode. Everything upstream can look
    // right and the row that lands in the DB — the one the runtime reads
    // — can still have no `triggers` at all.
    await ensureBundledExtensions();
    const granted = store.get("ez-factory")!.grantedPermissions;

    expect(granted.triggers).toBeDefined();
    expect(granted.triggers).toEqual(TRIGGERS);
    expect(Number.isNaN(granted.triggers!.maxCron)).toBe(false);
    expect(Number.isNaN(granted.triggers!.maxWebhooks)).toBe(false);
    expect(Number.isNaN(granted.triggers!.maxRunsPerDay)).toBe(false);
  });

  test("the persisted grant keeps storage, filesystem, and the three workflow names", async () => {
    await ensureBundledExtensions();
    const granted = store.get("ez-factory")!.grantedPermissions;
    expect(granted.storage).toBe(true);
    expect(granted.filesystem).toEqual(["$CWD"]);
    expect(granted.workflows?.names).toEqual([
      "docs-factory",
      "etl-factory",
      "draft-and-verify",
    ]);
    expect(granted.workflows?.maxRunsPerHour).toBe(60);
    expect(Number.isNaN(granted.workflows?.maxRunsPerHour ?? NaN)).toBe(false);
  });

  test("the persisted grant gains nothing the manifest did not ask for", async () => {
    await ensureBundledExtensions();
    const granted = store.get("ez-factory")!.grantedPermissions;
    expect(granted.llm).toBeUndefined();
    expect(granted.shell).toBeUndefined();
    expect(granted.network).toBeUndefined();
    expect(granted.env).toBeUndefined();
    expect(granted.schedule).toBeUndefined();
  });

  test("the page action SURVIVES intersectPermissions — the grant, not just the manifest", async () => {
    // The one that matters at render time. `intersectPermissions` clamps the
    // install grant against the bundled ceiling, and a name missing from the
    // ceiling row is dropped HERE, silently — after which `allowedEvents`
    // loses it and `validatePageTree` deletes the job editor's form node
    // from the tree. Asserting the manifest alone would not have caught a
    // ceiling row that forgot the name.
    await ensureBundledExtensions();
    const granted = store.get("ez-factory")!.grantedPermissions;
    expect(granted.eventSubscriptions).toEqual(["ez-factory:job-save"]);
  });

  test("appears in the bundled (isBundled=true) list", async () => {
    await ensureBundledExtensions();
    const { listExtensions } = await import("../db/queries/extensions");
    const bundled = (await listExtensions()).filter((r) => r.isBundled === true);
    expect(bundled.some((r) => r.name === "ez-factory")).toBe(true);
  });

  test("second boot is a no-op and does not lose the trigger grant", async () => {
    // The refresh path is a separate code path from first install, and it
    // is where a stale/mismatched ceiling would bite on boot 2 rather
    // than boot 1.
    await ensureBundledExtensions();
    const firstId = store.get("ez-factory")!.id;
    await ensureBundledExtensions();
    expect(store.get("ez-factory")!.id).toBe(firstId);
    expect(store.get("ez-factory")!.enabled).toBe(true);
    expect(store.get("ez-factory")!.grantedPermissions.triggers).toEqual(TRIGGERS);
  });
});
