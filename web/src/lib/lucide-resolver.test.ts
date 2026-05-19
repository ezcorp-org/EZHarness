/**
 * Unit tests for the lucide-resolver memoization + fallback path.
 *
 * The resolver is the seam between the manifest's icon string and the
 * actual lucide-svelte component, so the rules that need to stay
 * locked down are:
 *   - PascalCase → kebab-case translation matches what lucide-svelte
 *     actually publishes
 *   - Memoization: each name resolves to a single in-flight Promise,
 *     and once resolved subsequent calls return the same component
 *     (no re-imports).
 *   - Unknown names: the loader's rejection collapses to the
 *     fallback (HelpCircle) component, NOT a thrown error.
 *   - Unsafe names: refused without ever invoking the loader, falling
 *     back immediately.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  __resetIconCache,
  __setIconLoader,
  FALLBACK_ICON_NAME,
  isSafeIconName,
  pascalToKebab,
  resolveLucideIcon,
} from "./lucide-resolver.js";

beforeEach(() => {
  __setIconLoader(null);
  __resetIconCache();
});

describe("pascalToKebab", () => {
  test("plain alpha PascalCase: 'Volume' → 'volume'", () => {
    expect(pascalToKebab("Volume")).toBe("volume");
  });

  test("digits: 'Volume2' → 'volume-2' (lucide convention)", () => {
    expect(pascalToKebab("Volume2")).toBe("volume-2");
  });

  test("multi-word PascalCase: 'ArrowUpRight' → 'arrow-up-right'", () => {
    expect(pascalToKebab("ArrowUpRight")).toBe("arrow-up-right");
  });

  test("trailing digit cluster: 'AlignCenter2' → 'align-center-2'", () => {
    expect(pascalToKebab("AlignCenter2")).toBe("align-center-2");
  });

  test("known-good fallback name resolves: 'HelpCircle' → 'help-circle'", () => {
    expect(pascalToKebab("HelpCircle")).toBe("help-circle");
  });
});

describe("isSafeIconName", () => {
  test("accepts PascalCase alphanumeric names", () => {
    expect(isSafeIconName("Volume2")).toBe(true);
    expect(isSafeIconName("ArrowUpRight")).toBe(true);
    expect(isSafeIconName("HelpCircle")).toBe(true);
  });

  test("rejects names with spaces, slashes, or dots (path-traversal shapes)", () => {
    expect(isSafeIconName("Volume 2")).toBe(false);
    expect(isSafeIconName("../etc/passwd")).toBe(false);
    expect(isSafeIconName("Vol.ume")).toBe(false);
    expect(isSafeIconName("Vol-ume")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isSafeIconName("")).toBe(false);
  });

  test("rejects names that don't start with a letter", () => {
    expect(isSafeIconName("2Volume")).toBe(false);
  });
});

describe("resolveLucideIcon — memoization", () => {
  test("two calls for the same name return the same Promise (single import)", async () => {
    let calls = 0;
    __setIconLoader(async () => {
      calls++;
      const stub = (() => null) as unknown as Parameters<
        typeof Object.assign
      >[0];
      return { default: stub as never };
    });
    const a = resolveLucideIcon("Volume2");
    const b = resolveLucideIcon("Volume2");
    expect(a).toBe(b); // same Promise instance
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  test("different names trigger separate imports", async () => {
    const seen: string[] = [];
    __setIconLoader(async (kebab: string) => {
      seen.push(kebab);
      const stub = (() => null) as unknown as never;
      return { default: stub };
    });
    await Promise.all([
      resolveLucideIcon("Volume2"),
      resolveLucideIcon("Sparkles"),
      resolveLucideIcon("Volume2"), // cached
    ]);
    expect(seen.sort()).toEqual(["sparkles", "volume-2"]);
  });

  test("returns the loader's `default` export verbatim", async () => {
    const fakeComponent = { __test: "fake" } as unknown as never;
    __setIconLoader(async () => ({ default: fakeComponent }));
    const resolved = await resolveLucideIcon("Volume2");
    expect(resolved).toBe(fakeComponent);
  });
});

describe("resolveLucideIcon — fallback path", () => {
  test("unknown icon (loader rejects) falls back to FALLBACK_ICON_NAME", async () => {
    const fallbackComponent = { __test: "fallback" } as unknown as never;
    __setIconLoader(async (kebab: string) => {
      if (kebab === "definitely-not-real") {
        throw new Error("404");
      }
      // Treat anything else as the fallback.
      return { default: fallbackComponent };
    });
    const resolved = await resolveLucideIcon("DefinitelyNotReal");
    expect(resolved).toBe(fallbackComponent);
  });

  test("unsafe name short-circuits to fallback without invoking the loader for the unsafe name", async () => {
    const seen: string[] = [];
    const fallbackComponent = { __test: "fallback" } as unknown as never;
    __setIconLoader(async (kebab: string) => {
      seen.push(kebab);
      // Always succeed — only the fallback path should ever be reached.
      return { default: fallbackComponent };
    });
    const resolved = await resolveLucideIcon("../../../etc/passwd");
    expect(resolved).toBe(fallbackComponent);
    // The unsafe name should not have been kebabed and passed in.
    expect(seen).not.toContain("../../../etc/passwd");
    // The fallback name should have been requested.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toContain("help-circle");
  });

  test("FALLBACK_ICON_NAME is the documented default", () => {
    expect(FALLBACK_ICON_NAME).toBe("HelpCircle");
  });

  test("fallback is itself memoized — repeated unknowns don't re-import the fallback", async () => {
    let fallbackLoads = 0;
    const fallbackComponent = { __test: "fallback" } as unknown as never;
    __setIconLoader(async (kebab: string) => {
      if (kebab === "help-circle") {
        fallbackLoads++;
        return { default: fallbackComponent };
      }
      throw new Error("404");
    });
    await resolveLucideIcon("UnknownA");
    await resolveLucideIcon("UnknownB");
    await resolveLucideIcon("UnknownC");
    expect(fallbackLoads).toBe(1);
  });
});
