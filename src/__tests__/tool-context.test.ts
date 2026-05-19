/**
 * AsyncLocalStorage sanity tests for `@ezcorp/sdk/runtime/tool-context`.
 *
 * Risk flagged in the Phase 2 spec ("ALS context propagation through
 * Bun's Promise scheduler"): if any of these fail, the in-sandbox fetch
 * wrapper's per-tool override degrades to extension-wide-only — we'd
 * fall back to the request-id-keyed Map alternative documented in the
 * spec.
 *
 * Day-1 result (commit message of feat(sdk): add AsyncLocalStorage…):
 * sync read, Promise.resolve, setTimeout, concurrent isolation, and
 * outside-undefined all pass on Bun. ALS is the primary path.
 */
import { test, expect, describe } from "bun:test";
import {
  withToolContext,
  getToolContext,
  type ToolContext,
} from "@ezcorp/sdk/runtime";

const CTX = (toolName: string, extra: Partial<ToolContext> = {}): ToolContext => ({
  toolName,
  conversationId: "c-1",
  ...extra,
});

describe("tool-context (AsyncLocalStorage)", () => {
  test("synchronous read inside withToolContext returns the bound ctx", async () => {
    const seen = await withToolContext(CTX("t1"), () => {
      return getToolContext();
    });
    expect(seen).toEqual(CTX("t1"));
  });

  test("ALS propagates across await Promise.resolve()", async () => {
    const seen = await withToolContext(CTX("p1"), async () => {
      await Promise.resolve();
      return getToolContext();
    });
    expect(seen?.toolName).toBe("p1");
  });

  test("ALS propagates across await setTimeout(0)", async () => {
    const seen = await withToolContext(CTX("st0"), async () => {
      await new Promise((r) => setTimeout(r, 0));
      return getToolContext();
    });
    expect(seen?.toolName).toBe("st0");
  });

  test("ALS propagates across await setTimeout(N>0)", async () => {
    const seen = await withToolContext(CTX("st10"), async () => {
      await new Promise((r) => setTimeout(r, 10));
      return getToolContext();
    });
    expect(seen?.toolName).toBe("st10");
  });

  test("nested withToolContext overrides the inner scope", async () => {
    const seen = await withToolContext(CTX("outer"), async () => {
      return withToolContext(CTX("inner"), async () => {
        return getToolContext();
      });
    });
    expect(seen?.toolName).toBe("inner");
  });

  test("nested context restores the outer scope after inner returns", async () => {
    const seen = await withToolContext(CTX("outer"), async () => {
      await withToolContext(CTX("inner"), async () => {
        // do nothing — verify outer survives the inner scope
      });
      return getToolContext();
    });
    expect(seen?.toolName).toBe("outer");
  });

  test("concurrent withToolContext runs are isolated", async () => {
    // Two scopes interleave: A waits longer than B, but each must read
    // its own ctx, never the other's.
    const [a, b] = await Promise.all([
      withToolContext(CTX("A"), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getToolContext();
      }),
      withToolContext(CTX("B"), async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getToolContext();
      }),
    ]);
    expect(a?.toolName).toBe("A");
    expect(b?.toolName).toBe("B");
  });

  test("getToolContext outside any withToolContext returns undefined", () => {
    expect(getToolContext()).toBeUndefined();
  });

  test("withToolContext supports a synchronous handler", async () => {
    const seen = await withToolContext(CTX("sync"), () => {
      return getToolContext();
    });
    expect(seen?.toolName).toBe("sync");
  });

  test("ctx fields survive a long await chain", async () => {
    const seen = await withToolContext(
      CTX("chained", { callerExtensionId: "caller" }),
      async () => {
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 2));
        await Promise.resolve();
        return getToolContext();
      },
    );
    expect(seen).toEqual({
      toolName: "chained",
      conversationId: "c-1",
      callerExtensionId: "caller",
    });
  });

  test("sequential withToolContext calls don't leak between scopes", async () => {
    const a = await withToolContext(CTX("a"), async () => getToolContext());
    const b = await withToolContext(CTX("b"), async () => getToolContext());
    expect(a?.toolName).toBe("a");
    expect(b?.toolName).toBe("b");
    expect(getToolContext()).toBeUndefined();
  });
});
