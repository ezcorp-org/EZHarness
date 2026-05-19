// rpc.test.ts — 100% line + branch coverage for runtime/rpc.ts
//
// Strategy: rpc.ts is a pure-data + module-level register-hook module.
// Channel-side dispatcher behavior (Unknown tool, opts.onError fallback,
// async handler awaiting) lives in channel.ts and is covered there.
//
// Test ordering matters: the "channel not ready" default-throw test must
// run BEFORE anything imports channel.ts (which would overwrite _register
// at module-load via _setDispatcherRegister). We use only static imports
// of rpc.ts and never import channel.ts in this file.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  _setDispatcherRegister,
  createToolDispatcher,
  toolError,
  toolResult,
  type ToolDispatcherOptions,
  type ToolHandler,
} from "../src/runtime/rpc";

// ── toolResult ─────────────────────────────────────────────────────

describe("toolResult", () => {
  test("returns the canonical text-content envelope", () => {
    expect(toolResult("hi")).toEqual({
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
  });

  test("merges meta keys onto the top-level object", () => {
    const result = toolResult("payload", { foo: 1, cardType: "fancy" });
    expect(result).toEqual({
      content: [{ type: "text", text: "payload" }],
      isError: false,
      foo: 1,
      cardType: "fancy",
    } as unknown as ReturnType<typeof toolResult>);
  });

  test("meta can override isError", () => {
    const result = toolResult("override", { isError: true }) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  test("empty meta object still goes through the merge branch", () => {
    // Hits the `if (!meta) return base` FALSE branch with no extra keys.
    const result = toolResult("plain", {});
    expect(result).toEqual({
      content: [{ type: "text", text: "plain" }],
      isError: false,
    });
  });
});

// ── toolError ──────────────────────────────────────────────────────

describe("toolError", () => {
  test("returns isError: true with no code when code is omitted", () => {
    const result = toolError("nope") as { code?: string; isError: boolean };
    expect(result).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    } as typeof result);
    expect(result.code).toBeUndefined();
  });

  test("attaches code when supplied", () => {
    const result = toolError("nope", "ERR_X") as { code?: string };
    expect(result.code).toBe("ERR_X");
  });
});

// ── default _register: "channel not ready" ─────────────────────────
//
// Runs first (declaration order). Once we call _setDispatcherRegister
// in the suite below, this branch becomes unreachable for the rest of
// the file — which is why it lives at the top.

describe("createToolDispatcher (default state)", () => {
  test("throws 'channel not ready' before channel.ts is loaded", () => {
    expect(() =>
      createToolDispatcher({
        hello: () => toolResult("hi"),
      }),
    ).toThrow(/channel not ready/);
  });
});

// ── _setDispatcherRegister + createToolDispatcher branches ─────────

describe("_setDispatcherRegister + createToolDispatcher", () => {
  // We swap _register out for a recording mock fn so we can inspect the
  // shape of registrations forwarded by createToolDispatcher.
  type Recorded = {
    handlers: Record<string, ToolHandler>;
    opts?: ToolDispatcherOptions;
  };
  let registerSpy: ReturnType<typeof mock>;
  let recorded: Recorded[];

  beforeEach(() => {
    recorded = [];
    registerSpy = mock((reg: Recorded) => {
      recorded.push(reg);
    });
    _setDispatcherRegister(registerSpy);
  });

  afterEach(() => {
    // Re-install a no-op so a stray createToolDispatcher() in a later
    // suite doesn't accidentally hit recorded[] from this suite.
    _setDispatcherRegister(() => {});
  });

  test("forwards handlers without opts when none supplied", () => {
    const handlers = { foo: () => toolResult("ok") };
    createToolDispatcher(handlers);
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.handlers).toBe(handlers);
    // Branch: `...(opts ? {opts} : {})` with opts=undefined → no `opts` key.
    expect("opts" in (recorded[0] ?? {})).toBe(false);
  });

  test("forwards opts when supplied", () => {
    const handlers = { foo: () => toolResult("ok") };
    const onError: NonNullable<ToolDispatcherOptions["onError"]> = (_err, name) =>
      toolError(`fallback for ${name}`);
    createToolDispatcher(handlers, { onError });
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(recorded[0]?.handlers).toBe(handlers);
    expect(recorded[0]?.opts?.onError).toBe(onError);
  });

  test("the registered onError can be invoked from outside (smoke)", () => {
    // Confirms ToolDispatcherOptions.onError is exposed as a callable, not
    // mangled. (No coverage gain in rpc.ts itself, but cheap insurance.)
    const onError: NonNullable<ToolDispatcherOptions["onError"]> = (err, tool) =>
      toolError(`${tool}: ${(err as Error).message}`, "WRAPPED");
    createToolDispatcher({}, { onError });
    const opts = recorded[0]?.opts;
    if (!opts?.onError) throw new Error("expected onError to be recorded");
    const result = opts.onError(new Error("boom"), "demo") as { code?: string; content: { text: string }[] };
    expect(result.code).toBe("WRAPPED");
    expect(result.content[0]?.text).toBe("demo: boom");
  });
});
