/**
 * `clampSearchPermission` — install/grant-time clamp for the §3.1
 * three-state `search` grant. Mirrors the LLM/memory clamp test style.
 */
import { test, expect, describe } from "bun:test";
import { clampSearchPermission, KNOWN_SEARCH_PROVIDERS } from "../extensions/clamp-permissions";
import type { ExtensionManifestV2 } from "../extensions/types";

type ManifestSearch = ExtensionManifestV2["permissions"]["search"];

describe("clampSearchPermission", () => {
  test("undefined manifest → undefined (extension can't self-grant)", () => {
    expect(clampSearchPermission("inherit", undefined)).toBeUndefined();
    expect(clampSearchPermission({ quota: 5 }, undefined)).toBeUndefined();
  });

  test("a `false` ceiling forces `false` regardless of submission", () => {
    expect(clampSearchPermission("inherit", false as never)).toBe(false);
    expect(clampSearchPermission({ quota: 100 }, false as never)).toBe(false);
  });

  test("submitted false → false (disabled stays disabled)", () => {
    expect(clampSearchPermission(false, {} as ManifestSearch)).toBe(false);
  });

  test("submitted inherit (or undefined) → inherit", () => {
    expect(clampSearchPermission("inherit", {} as ManifestSearch)).toBe("inherit");
    expect(clampSearchPermission(undefined, {} as ManifestSearch)).toBe("inherit");
  });

  test("an `\"inherit\"` ceiling normalizes to unrestricted (object override clamps to defaults)", () => {
    const out = clampSearchPermission({ quota: 50, maxResults: 3 }, "inherit" as never);
    expect(out).toEqual({ quota: 50, maxResults: 3 });
  });

  test("numeric override clamps to the narrower of submitted and manifest", () => {
    const manifest: ManifestSearch = { quota: 100, maxResults: 10 };
    expect(clampSearchPermission({ quota: 500, maxResults: 20 }, manifest)).toEqual({ quota: 100, maxResults: 10 });
    expect(clampSearchPermission({ quota: 30, maxResults: 4 }, manifest)).toEqual({ quota: 30, maxResults: 4 });
  });

  test("providers intersect submitted ∩ manifest ∩ KNOWN", () => {
    const manifest: ManifestSearch = { providers: ["searxng", "duckduckgo", "tavily"] };
    const out = clampSearchPermission({ providers: ["tavily", "brave", "bogus"] }, manifest);
    // brave is KNOWN but NOT in the manifest; bogus is unknown → both dropped.
    expect(out).toEqual({ providers: ["tavily"] });
  });

  test("empty provider intersection omits the providers field", () => {
    const manifest: ManifestSearch = { providers: ["searxng"] };
    const out = clampSearchPermission({ providers: ["tavily"] }, manifest);
    expect(out).toEqual({});
  });

  test("submitted providers \"inherit\" passes through", () => {
    const out = clampSearchPermission({ providers: "inherit", quota: 10 }, { quota: 100 } as ManifestSearch);
    expect(out).toEqual({ quota: 10, providers: "inherit" });
  });

  test("manifest providers \"inherit\" allows any KNOWN provider", () => {
    const manifest: ManifestSearch = { providers: "inherit" };
    const out = clampSearchPermission({ providers: [...KNOWN_SEARCH_PROVIDERS, "bogus"] }, manifest);
    expect(out).toEqual({ providers: [...KNOWN_SEARCH_PROVIDERS] });
  });

  test("manifest with no provider field allows any KNOWN provider", () => {
    const out = clampSearchPermission({ providers: ["jina", "exa"] }, {} as ManifestSearch);
    expect(out).toEqual({ providers: ["jina", "exa"] });
  });
});
