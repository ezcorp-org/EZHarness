// settings.test.ts — coverage for runtime/settings.ts (Phase B).
//
// Validates the read-only `getSetting` / `getAllSettings` helpers that
// extensions call from inside a tool handler to read the resolved
// per-extension settings the host attached to
// `ctx.invocationMetadata.settings`.
//
// The host clamps values against the manifest schema before they reach
// the subprocess, so these helpers do zero validation — they're a thin
// typed accessor over the metadata channel.

import { describe, expect, test } from "bun:test";
import { getAllSettings, getSetting } from "../src/runtime/settings";
import type { ToolHandlerContext } from "../src/runtime/rpc";

describe("getSetting", () => {
  test("returns the value when present", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: { settings: { voice: "af_bella", speed: 1.2 } },
    };
    expect(getSetting<string>(ctx, "voice")).toBe("af_bella");
    expect(getSetting<number>(ctx, "speed")).toBe(1.2);
  });

  test("returns undefined when the key is absent", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: { settings: { voice: "af_bella" } },
    };
    expect(getSetting(ctx, "missing")).toBeUndefined();
  });

  test("returns undefined when no settings attached", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: {},
    };
    expect(getSetting(ctx, "voice")).toBeUndefined();
  });

  test("returns undefined when ctx has no invocationMetadata", () => {
    const ctx: ToolHandlerContext = {};
    expect(getSetting(ctx, "voice")).toBeUndefined();
  });

  test("returns undefined when ctx itself is undefined", () => {
    expect(getSetting(undefined, "voice")).toBeUndefined();
  });

  test("type narrowing flows through the generic", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: { settings: { speed: 1.5 } },
    };
    const speed = getSetting<number>(ctx, "speed");
    // No runtime cast — purely a compile-time witness. The `?? 0` proves
    // that the inferred type is `number | undefined`.
    expect((speed ?? 0).toFixed(1)).toBe("1.5");
  });

  test("settings holding falsy primitives (false, 0, '') round-trip", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: {
        settings: { enabled: false, count: 0, label: "" },
      },
    };
    expect(getSetting<boolean>(ctx, "enabled")).toBe(false);
    expect(getSetting<number>(ctx, "count")).toBe(0);
    expect(getSetting<string>(ctx, "label")).toBe("");
  });
});

describe("getAllSettings", () => {
  test("returns the full settings map when present", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: { settings: { voice: "af_bella", speed: 1.2 } },
    };
    expect(getAllSettings(ctx)).toEqual({ voice: "af_bella", speed: 1.2 });
  });

  test("returns {} when no settings attached", () => {
    const ctx: ToolHandlerContext = { invocationMetadata: {} };
    expect(getAllSettings(ctx)).toEqual({});
  });

  test("returns {} when ctx has no invocationMetadata", () => {
    const ctx: ToolHandlerContext = {};
    expect(getAllSettings(ctx)).toEqual({});
  });

  test("returns {} when ctx itself is undefined", () => {
    expect(getAllSettings(undefined)).toEqual({});
  });

  test("returns a fresh copy (mutation is isolated)", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: { settings: { voice: "af_bella", speed: 1.2 } },
    };
    const first = getAllSettings(ctx);
    (first as Record<string, unknown>).voice = "mutated";
    (first as Record<string, unknown>).newKey = "leaked";

    expect(getAllSettings(ctx)).toEqual({ voice: "af_bella", speed: 1.2 });
    expect(getSetting<string>(ctx, "voice")).toBe("af_bella");
    expect(getSetting(ctx, "newKey")).toBeUndefined();
  });

  test("second call returns a different reference", () => {
    const ctx: ToolHandlerContext = {
      invocationMetadata: { settings: { voice: "af_bella" } },
    };
    const a = getAllSettings(ctx);
    const b = getAllSettings(ctx);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
