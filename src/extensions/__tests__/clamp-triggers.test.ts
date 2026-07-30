/**
 * `clampTriggersPermission` (C2 build-order step 4) — the install-time
 * ceiling on the dynamic-trigger envelope.
 *
 * The load-bearing rule here is that `webhookPrefix` comes from the
 * MANIFEST ONLY. It names a slug namespace that every host-minted dynamic
 * slug derives from, so a submitted grant that could widen or redirect it
 * would let a user hand one extension another extension's namespace.
 */
import { test, expect, describe } from "bun:test";
import { clampTriggersPermission } from "../clamp-permissions";
import type { ExtensionManifestV2, ExtensionPermissions } from "../types";

type ManifestTriggers = ExtensionManifestV2["permissions"]["triggers"];
type GrantTriggers = ExtensionPermissions["triggers"];

const FULL: ManifestTriggers = {
  maxCron: 25,
  maxWebhooks: 25,
  webhookPrefix: "factory-",
  maxRunsPerDay: 500,
};

describe("clampTriggersPermission — presence", () => {
  test("no manifest declaration ⇒ no grant", () => {
    expect(clampTriggersPermission(undefined, undefined)).toBeUndefined();
    // A submitted grant cannot conjure a capability the author never asked
    // for, however complete it looks.
    expect(clampTriggersPermission(
      { maxCron: 5, maxWebhooks: 5, webhookPrefix: "evil-", maxRunsPerDay: 100 },
      undefined,
    )).toBeUndefined();
  });

  test("manifest with no submitted grant is approved as declared", () => {
    const g = clampTriggersPermission(undefined, FULL);
    expect(g).toEqual({
      maxCron: 25, maxWebhooks: 25, webhookPrefix: "factory-", maxRunsPerDay: 500,
    });
  });

  test("an envelope authorizing ZERO registrations is dropped, not stored", () => {
    // A `{maxCron: 0, maxWebhooks: 0}` husk would read as "granted" to any
    // presence check while authorizing nothing.
    expect(clampTriggersPermission(undefined, {
      ...FULL, maxCron: 0, maxWebhooks: 0,
    })).toBeUndefined();
    // Narrowed to zero by the SUBMITTED side is the same husk.
    expect(clampTriggersPermission(
      { maxCron: 0, maxWebhooks: 0, webhookPrefix: "factory-", maxRunsPerDay: 10 },
      FULL,
    )).toBeUndefined();
  });

  test("one non-zero cap keeps the grant alive", () => {
    const cronOnly = clampTriggersPermission(undefined, { ...FULL, maxWebhooks: 0 });
    expect(cronOnly).toMatchObject({ maxCron: 25, maxWebhooks: 0 });
    const hookOnly = clampTriggersPermission(undefined, { ...FULL, maxCron: 0 });
    expect(hookOnly).toMatchObject({ maxCron: 0, maxWebhooks: 25 });
  });
});

describe("clampTriggersPermission — webhookPrefix is manifest-only", () => {
  test("a submitted prefix is IGNORED, never adopted", () => {
    const g = clampTriggersPermission(
      { maxCron: 5, maxWebhooks: 5, webhookPrefix: "otherext-", maxRunsPerDay: 50 },
      FULL,
    );
    expect(g!.webhookPrefix).toBe("factory-");
  });

  test("a malformed MANIFEST prefix drops the whole grant", () => {
    // No safe default exists — silently substituting a namespace is worse
    // than refusing the capability.
    for (const bad of ["factory", "Factory-", "-factory-", "", "abcdefghijklmnopq-"]) {
      expect(clampTriggersPermission(undefined, { ...FULL, webhookPrefix: bad }))
        .toBeUndefined();
    }
  });

  test("a missing or non-string manifest prefix drops the grant", () => {
    expect(clampTriggersPermission(undefined, {
      maxCron: 5, maxWebhooks: 5, maxRunsPerDay: 50,
    })).toBeUndefined();
    expect(clampTriggersPermission(undefined, {
      ...FULL, webhookPrefix: 42 as unknown as string,
    })).toBeUndefined();
  });

  test("the shortest legal prefix is accepted", () => {
    expect(clampTriggersPermission(undefined, { ...FULL, webhookPrefix: "f-" })!
      .webhookPrefix).toBe("f-");
  });
});

describe("clampTriggersPermission — numeric clamps", () => {
  test("submitted narrows, never widens", () => {
    const narrowed = clampTriggersPermission(
      { maxCron: 3, maxWebhooks: 2, webhookPrefix: "factory-", maxRunsPerDay: 40 },
      FULL,
    );
    expect(narrowed).toMatchObject({ maxCron: 3, maxWebhooks: 2, maxRunsPerDay: 40 });

    const widened = clampTriggersPermission(
      { maxCron: 999, maxWebhooks: 999, webhookPrefix: "factory-", maxRunsPerDay: 9999 },
      { ...FULL, maxCron: 4, maxWebhooks: 4, maxRunsPerDay: 60 },
    );
    expect(widened).toMatchObject({ maxCron: 4, maxWebhooks: 4, maxRunsPerDay: 60 });
  });

  test("caps are bounded at 50 even when the manifest asks for more", () => {
    const g = clampTriggersPermission(undefined, {
      ...FULL, maxCron: 10_000, maxWebhooks: 10_000,
    });
    expect(g).toMatchObject({ maxCron: 50, maxWebhooks: 50 });
  });

  test("maxRunsPerDay is bounded to 1..2000", () => {
    expect(clampTriggersPermission(undefined, { ...FULL, maxRunsPerDay: 99_999 })!
      .maxRunsPerDay).toBe(2000);
    // Zero is not a legal envelope — it would deny every fire while the
    // grant still read as present.
    expect(clampTriggersPermission(undefined, { ...FULL, maxRunsPerDay: 0 })!
      .maxRunsPerDay).toBe(1);
  });

  test("negative caps clamp to zero, and two of them drop the grant", () => {
    expect(clampTriggersPermission(undefined, { ...FULL, maxCron: -5 })!.maxCron).toBe(0);
    expect(clampTriggersPermission(undefined, {
      ...FULL, maxCron: -5, maxWebhooks: -5,
    })).toBeUndefined();
  });

  test("absent numbers fall back to documented defaults", () => {
    const g = clampTriggersPermission(undefined, { webhookPrefix: "factory-" });
    expect(g).toEqual({
      maxCron: 10, maxWebhooks: 10, webhookPrefix: "factory-", maxRunsPerDay: 100,
    });
  });

  test("non-finite and non-numeric values fall back rather than producing NaN", () => {
    // `intersectPermissions` does Math.min over the grant, so a NaN here
    // would poison every downstream ceiling computation.
    const g = clampTriggersPermission(
      {
        maxCron: Number.NaN, maxWebhooks: Number.POSITIVE_INFINITY,
        webhookPrefix: "factory-", maxRunsPerDay: "80" as unknown as number,
      } as GrantTriggers,
      FULL,
    );
    expect(Number.isFinite(g!.maxCron)).toBe(true);
    expect(Number.isFinite(g!.maxWebhooks)).toBe(true);
    expect(Number.isFinite(g!.maxRunsPerDay)).toBe(true);
    expect(g).toEqual({
      maxCron: 10, maxWebhooks: 10, webhookPrefix: "factory-", maxRunsPerDay: 100,
    });
  });

  test("fractional caps floor rather than round", () => {
    const g = clampTriggersPermission(undefined, {
      ...FULL, maxCron: 7.9, maxRunsPerDay: 12.9,
    });
    expect(g).toMatchObject({ maxCron: 7, maxRunsPerDay: 12 });
  });
});
