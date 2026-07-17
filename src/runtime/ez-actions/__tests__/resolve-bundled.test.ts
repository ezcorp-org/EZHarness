/**
 * v1.4 — pure-function tests for `resolveBundledEzAction`.
 *
 * No DB, no async, no mock infrastructure beyond what the helper
 * itself imports (`isBundledExtensionName` reads a module-load-time
 * Set built from the literal `BUNDLED_EXTENSIONS` array — no I/O).
 * That means these tests run in a few ms each and exhaustively pin
 * every code path.
 *
 * Coverage matrix:
 *   - Legacy alias (`"distill"`) → expands to lessons-distiller.
 *   - `<bundled>:<tool>` shape → resolves; tool registry check
 *     happens in the route forwarder, NOT here.
 *   - `<non-bundled>:<tool>` shape → null (bundled-trust gate).
 *   - Malformed inputs (empty, single colon, dangling colon, multiple
 *     colons, whitespace, non-string types) → null.
 *   - The legacy alias is NOT also expanded as `<ext>:<tool>` —
 *     `"distill"` is the alias surface; `"lessons-distiller:distill_now"`
 *     is the canonical surface. Both work; only the alias has
 *     `legacyAlias: true`.
 */
import { test, expect, describe } from "bun:test";
import { resolveBundledExtensions } from "../../../extensions/bundled";
import { resolveBundledEzAction } from "../resolve-bundled";

describe("resolveBundledEzAction — legacy alias", () => {
  test("'distill' → lessons-distiller / distill_now, legacyAlias true", () => {
    const out = resolveBundledEzAction("distill");
    expect(out).toEqual({
      extensionName: "lessons-distiller",
      toolName: "distill_now",
      legacyAlias: true,
    });
  });

  test("trimmed whitespace still resolves the alias", () => {
    const out = resolveBundledEzAction("  distill  ");
    expect(out?.extensionName).toBe("lessons-distiller");
    expect(out?.legacyAlias).toBe(true);
  });

  test("alias is exact-match — 'distillify' / 'distill_now' don't alias", () => {
    expect(resolveBundledEzAction("distillify")).toBeNull();
    // 'distill_now' is the lessons-distiller TOOL name, not a top-
    // level alias. Without a colon, the resolver doesn't know which
    // extension to bind it to → null. The canonical form is
    // `lessons-distiller:distill_now`.
    expect(resolveBundledEzAction("distill_now")).toBeNull();
  });
});

describe("resolveBundledEzAction — canonical <ext>:<tool> form", () => {
  test("'lessons-distiller:distill_now' → resolves, legacyAlias false", () => {
    const out = resolveBundledEzAction("lessons-distiller:distill_now");
    expect(out).toEqual({
      extensionName: "lessons-distiller",
      toolName: "distill_now",
      legacyAlias: false,
    });
  });

  test("alias and canonical resolve to the SAME tool but with different legacyAlias flag", () => {
    const alias = resolveBundledEzAction("distill");
    const canonical = resolveBundledEzAction("lessons-distiller:distill_now");
    expect(alias?.extensionName).toBe(canonical?.extensionName);
    expect(alias?.toolName).toBe(canonical?.toolName);
    expect(alias?.legacyAlias).toBe(true);
    expect(canonical?.legacyAlias).toBe(false);
  });

  test("'memory-extractor:any-tool' → resolves (tool existence is the forwarder's job)", () => {
    // The resolver does NOT verify that `any-tool` is registered. The
    // bundled-trust check passes (memory-extractor is bundled), and
    // the forwarder will return a 404-ish minimal card if the tool
    // doesn't exist.
    const out = resolveBundledEzAction("memory-extractor:any-tool");
    expect(out).toEqual({
      extensionName: "memory-extractor",
      toolName: "any-tool",
      legacyAlias: false,
    });
  });

  test("every bundled extension currently in the list resolves", () => {
    // Derived from the REAL bundled list (empty env = no opt-outs), not a
    // hardcoded slice: the previous spot-check list rotted ("excel" left the
    // bundled set) because this file ran in no CI job. Iterating the source
    // list keeps the invariant — every bundled extension resolves through
    // the canonical `<ext>:<tool>` parse path — rot-proof.
    const cases = resolveBundledExtensions({}).map((e) => e.name);
    expect(cases.length).toBeGreaterThan(20);
    for (const ext of cases) {
      const out = resolveBundledEzAction(`${ext}:some-tool`);
      expect(out).not.toBeNull();
      expect(out?.extensionName).toBe(ext);
      expect(out?.toolName).toBe("some-tool");
    }
  });
});

describe("resolveBundledEzAction — non-bundled rejection", () => {
  test("user-installed extension name → null", () => {
    expect(resolveBundledEzAction("user-ext-fake:do-thing")).toBeNull();
    expect(resolveBundledEzAction("definitely-not-bundled:tool")).toBeNull();
  });

  test("non-ASCII (unicode) extension name → null (bundled-trust gate)", () => {
    // Bundled extension names are ASCII by construction (see
    // BUNDLED_EXTENSIONS in src/extensions/bundled.ts). A
    // non-ASCII left-side fails the bundled-trust check just like
    // any other non-bundled name. Pinned per spec — the prior
    // implicit behavior (fall through to the in-memory Set
    // membership check) is now load-bearing.
    expect(resolveBundledEzAction("日本:tool")).toBeNull();
    // Mixed ASCII + unicode also rejected.
    expect(resolveBundledEzAction("scratchpad日本:tool")).toBeNull();
  });

  test("'distill' alias does NOT bypass bundled-trust if lessons-distiller is uninstalled (still resolves on shape)", () => {
    // The alias resolves on its literal name — the bundled-trust
    // check is implicit in the alias map (the entry only exists for
    // bundled extensions). lessons-distiller IS bundled in the
    // current list. If a future change renames or removes it, the
    // alias map needs updating in lockstep.
    const out = resolveBundledEzAction("distill");
    expect(out?.extensionName).toBe("lessons-distiller");
  });
});

describe("resolveBundledEzAction — malformed input", () => {
  test("empty string → null", () => {
    expect(resolveBundledEzAction("")).toBeNull();
  });

  test("only whitespace → null", () => {
    expect(resolveBundledEzAction("   ")).toBeNull();
    expect(resolveBundledEzAction("\t\n")).toBeNull();
  });

  test("single colon → null", () => {
    expect(resolveBundledEzAction(":")).toBeNull();
  });

  test("dangling left colon → null", () => {
    expect(resolveBundledEzAction(":tool")).toBeNull();
  });

  test("dangling right colon → null", () => {
    expect(resolveBundledEzAction("ext:")).toBeNull();
    expect(resolveBundledEzAction("lessons-distiller:")).toBeNull();
  });

  test("multiple colons → null", () => {
    expect(resolveBundledEzAction("a:b:c")).toBeNull();
    expect(resolveBundledEzAction("lessons-distiller:distill_now:extra")).toBeNull();
  });

  test("non-string types → null (defensive against caller bugs)", () => {
    // The route handler types `actionName` as string, but the runtime
    // checks defensively because the popover search payload could
    // have leaked a non-string in past versions.
    expect(resolveBundledEzAction(null as unknown as string)).toBeNull();
    expect(resolveBundledEzAction(undefined as unknown as string)).toBeNull();
    expect(resolveBundledEzAction(42 as unknown as string)).toBeNull();
    expect(resolveBundledEzAction({} as unknown as string)).toBeNull();
  });
});

describe("resolveBundledEzAction — purity invariants", () => {
  test("does not mutate input or return aliased objects", () => {
    const a = resolveBundledEzAction("distill");
    const b = resolveBundledEzAction("distill");
    expect(a).toEqual(b);
    // Mutating one return value must not affect the next call.
    if (a) a.extensionName = "tampered";
    const c = resolveBundledEzAction("distill");
    expect(c?.extensionName).toBe("lessons-distiller");
  });

  test("synchronous — returns directly, no Promise leak", () => {
    const out = resolveBundledEzAction("distill");
    // Result is the plain object, never a thenable.
    expect(typeof (out as unknown as { then?: unknown })?.then).toBe("undefined");
  });
});
