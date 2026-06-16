/**
 * `intersectPermissions` — the `search` tier (used by the bundled-ceiling
 * clamp). "More restrictive wins" across the §3.1 three-state grant.
 */
import { test, expect, describe } from "bun:test";
import { intersectPermissions } from "../extensions/capability-types";
import type { ExtensionPermissions } from "../extensions/types";

function perms(search: ExtensionPermissions["search"]): ExtensionPermissions {
  return { search, grantedAt: { search: 1000 } };
}

describe("intersectPermissions — search tier", () => {
  test("inherit ∩ inherit → inherit (the bundled web-search happy path)", () => {
    const out = intersectPermissions(perms("inherit"), perms("inherit"));
    expect(out.search).toBe("inherit");
  });

  test("false on either side → false (disabled)", () => {
    expect(intersectPermissions(perms(false), perms("inherit")).search).toBe(false);
    expect(intersectPermissions(perms("inherit"), perms(false)).search).toBe(false);
    expect(intersectPermissions(perms(false), perms({ quota: 5 })).search).toBe(false);
  });

  test("object ∩ object → field-level MIN + provider intersection", () => {
    const a = perms({ quota: 100, maxResults: 10, providers: ["searxng", "tavily", "brave"] });
    const b = perms({ quota: 50, maxResults: 5, providers: ["tavily", "brave", "exa"] });
    const out = intersectPermissions(a, b);
    expect(out.search).toEqual({ quota: 50, maxResults: 5, providers: ["tavily", "brave"] });
  });

  test("inherit ∩ object → the object's bounds (concrete narrower than inherit)", () => {
    const out = intersectPermissions(perms("inherit"), perms({ quota: 20 }));
    expect(out.search).toEqual({ quota: 20 });
  });

  test("explicit provider list wins over an inherit list", () => {
    const a = perms({ providers: "inherit" });
    const b = perms({ providers: ["searxng"] });
    expect(intersectPermissions(a, b).search).toEqual({ providers: ["searxng"] });
    expect(intersectPermissions(b, a).search).toEqual({ providers: ["searxng"] });
  });

  test("both inherit providers → inherit providers", () => {
    const out = intersectPermissions(perms({ providers: "inherit" }), perms({ providers: "inherit" }));
    expect(out.search).toEqual({ providers: "inherit" });
  });

  test("neither side declares search → search omitted from the result", () => {
    const out = intersectPermissions({ grantedAt: {} }, { grantedAt: {} });
    expect(out.search).toBeUndefined();
  });

  test("grantedAt keeps the `search` key when search survives the intersection", () => {
    const out = intersectPermissions(perms("inherit"), perms("inherit"));
    expect(out.grantedAt.search).toBe(1000);
  });

  test("grantedAt drops the `search` key when intersected to a falsy-but-present state stays present", () => {
    // `false` is a present search state → grantedAt.search survives.
    const out = intersectPermissions(perms(false), perms("inherit"));
    expect(out.search).toBe(false);
    expect(out.grantedAt.search).toBe(1000);
  });
});
