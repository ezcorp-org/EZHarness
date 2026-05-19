/**
 * Phase 4 — Installer-time consent for deputy + escalation flags.
 *
 * Coverage matrix (spec items h-k):
 *   (h) Manifest declares acceptsCallerCaps: true → install API
 *       surfaces it as a separate consent item; user opt-in persists
 *       on extensions.grantedPermissions.
 *   (i) Manifest declares escalateChildCaps: true → independent
 *       checkbox / consent item; user opt-in persists.
 *   (j) Both flags declared → user can decline one and accept the
 *       other; the clamp respects each independently.
 *   (k) Manifest declares the flag but user DECLINES at install →
 *       grant is `false` (effectively absent), runtime treats as
 *       opted-out.
 *
 * Drives `clampExtensionPermissions` directly. The HTTP-level surface
 * is identical because both `/api/extensions/[id]/permissions` PUT and
 * `/api/extensions/[id]/activate` POST funnel through this helper.
 */

import { describe, expect, test } from "vitest";
import { clampExtensionPermissions } from "$lib/server/extension-helpers";
import type { ExtensionManifestV2, ExtensionPermissions } from "$server/extensions/types";

const EMPTY_MANIFEST_PERMS: ExtensionManifestV2["permissions"] = {};

// ── (h) acceptsCallerCaps — manifest declares + user accepts ─────────

describe("(h) installer surfaces acceptsCallerCaps consent independently", () => {
  test("manifest acceptsCallerCaps: true + user opts in → grant has it", () => {
    const submitted: Partial<ExtensionPermissions> = {
      acceptsCallerCaps: true,
    };
    const out = clampExtensionPermissions(submitted, EMPTY_MANIFEST_PERMS, {
      acceptsCallerCaps: true,
    });
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.escalateChildCaps).toBeUndefined();
  });

  test("manifest acceptsCallerCaps: true + user OMITS the flag → grant is absent", () => {
    const out = clampExtensionPermissions({}, EMPTY_MANIFEST_PERMS, {
      acceptsCallerCaps: true,
    });
    expect(out.acceptsCallerCaps).toBeUndefined();
  });

  test("manifest acceptsCallerCaps: undefined + user submits true → grant blocked at clamp", () => {
    // Closes the elevation path: an admin submitting the flag against
    // an extension that did NOT declare it is silently dropped.
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: true },
      EMPTY_MANIFEST_PERMS,
      { acceptsCallerCaps: undefined },
    );
    expect(out.acceptsCallerCaps).toBeUndefined();
  });
});

// ── (i) escalateChildCaps — independent consent ──────────────────────

describe("(i) installer surfaces escalateChildCaps consent independently", () => {
  test("manifest escalateChildCaps: true + user opts in → grant has it", () => {
    const out = clampExtensionPermissions(
      { escalateChildCaps: true },
      EMPTY_MANIFEST_PERMS,
      { escalateChildCaps: true },
    );
    expect(out.escalateChildCaps).toBe(true);
    expect(out.acceptsCallerCaps).toBeUndefined();
  });

  test("manifest escalateChildCaps: undefined + user submits true → blocked", () => {
    const out = clampExtensionPermissions(
      { escalateChildCaps: true },
      EMPTY_MANIFEST_PERMS,
      { escalateChildCaps: undefined },
    );
    expect(out.escalateChildCaps).toBeUndefined();
  });
});

// ── (j) Both flags — user can accept one and decline the other ──────

describe("(j) Both flags declared — user can accept ONE and decline the other", () => {
  test("user accepts deputy only", () => {
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: true, escalateChildCaps: false },
      EMPTY_MANIFEST_PERMS,
      { acceptsCallerCaps: true, escalateChildCaps: true },
    );
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.escalateChildCaps).toBeUndefined();
  });

  test("user accepts escalation only", () => {
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: false, escalateChildCaps: true },
      EMPTY_MANIFEST_PERMS,
      { acceptsCallerCaps: true, escalateChildCaps: true },
    );
    expect(out.acceptsCallerCaps).toBeUndefined();
    expect(out.escalateChildCaps).toBe(true);
  });

  test("user accepts both", () => {
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: true, escalateChildCaps: true },
      EMPTY_MANIFEST_PERMS,
      { acceptsCallerCaps: true, escalateChildCaps: true },
    );
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.escalateChildCaps).toBe(true);
  });

  test("user accepts neither (both decline)", () => {
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: false, escalateChildCaps: false },
      EMPTY_MANIFEST_PERMS,
      { acceptsCallerCaps: true, escalateChildCaps: true },
    );
    expect(out.acceptsCallerCaps).toBeUndefined();
    expect(out.escalateChildCaps).toBeUndefined();
  });
});

// ── (k) Decline persists regardless of manifest declaration ─────────

describe("(k) Manifest declares but user declined → runtime sees opted-out", () => {
  test("submitted explicitly false → not in grant", () => {
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: false, escalateChildCaps: false },
      EMPTY_MANIFEST_PERMS,
      { acceptsCallerCaps: true, escalateChildCaps: true },
    );
    // Field absent from grant — runtime check is `=== true`, so false
    // and undefined both behave as opted-out.
    expect(out.acceptsCallerCaps).toBeUndefined();
    expect(out.escalateChildCaps).toBeUndefined();
  });

  test("third-arg manifestTopLevel omitted entirely → flags can never be granted", () => {
    // Older callers (pre-Phase-4) that don't supply the third arg
    // should still see the existing perm-tier fields work, AND not
    // accidentally promote the new flags. Defensive: even if the
    // submission has both flags as true, the manifestTopLevel arg
    // being undefined gates them out.
    const out = clampExtensionPermissions(
      { acceptsCallerCaps: true, escalateChildCaps: true },
      EMPTY_MANIFEST_PERMS,
      // intentionally omitting third arg to simulate old callers
    );
    expect(out.acceptsCallerCaps).toBeUndefined();
    expect(out.escalateChildCaps).toBeUndefined();
  });
});

// ── Existing perm-tier semantics still work alongside the new flags ─

describe("New flags coexist with existing perm-tier semantics", () => {
  test("acceptsCallerCaps + network are clamped independently", () => {
    const out = clampExtensionPermissions(
      {
        acceptsCallerCaps: true,
        network: ["api.foo.com"],
      },
      { network: ["api.foo.com"] },
      { acceptsCallerCaps: true },
    );
    expect(out.acceptsCallerCaps).toBe(true);
    expect(out.network).toEqual(["api.foo.com"]);
  });

  test("escalateChildCaps + spawnAgents are clamped independently", () => {
    const out = clampExtensionPermissions(
      {
        escalateChildCaps: true,
        spawnAgents: { maxPerHour: 5, maxConcurrent: 1 },
      },
      { spawnAgents: { maxPerHour: 10, maxConcurrent: 2 } },
      { escalateChildCaps: true },
    );
    expect(out.escalateChildCaps).toBe(true);
    expect(out.spawnAgents).toEqual({ maxPerHour: 5, maxConcurrent: 1 });
  });
});
