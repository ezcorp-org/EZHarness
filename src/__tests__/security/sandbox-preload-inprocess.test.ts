// In-process load of the sandbox preload.
//
// Every other spec drives `sandbox-preload.ts` through `bun --preload` in a
// spawned subprocess. That is the right shape for behavioural assertions — it
// is how the preload really runs — but the coverage collector only sees the
// process it runs IN, so the preload lands in no lcov leg at all and its
// changed lines are invisible to the patch-coverage gate.
//
// Importing it here fixes that, at the cost of neutralizing THIS process's own
// globals (`fetch`, `Bun.file`, `node:fs`, …). That is contained: `bun run
// test` and the coverage shards both give every test FILE its own process, so
// nothing outside this file sees the poisoned namespace. Keep this file free
// of anything that needs real filesystem or network access — the imports below
// are the last ones that can rely on an unpoisoned runtime.

import { test, expect, describe, beforeAll } from "bun:test";

// Captured BEFORE the preload replaces them, so the assertions can prove a
// swap actually happened rather than comparing a value to itself.
const pristineGlob = Bun.Glob;
const pristineFetch = globalThis.fetch;

beforeAll(async () => {
  await import("../../extensions/runtime/sandbox-preload");
});

const FS_DENY = /requires 'filesystem' permission/;

describe("sandbox-preload: in-process load", () => {
  test("replaces the fs + network primitives it is responsible for", () => {
    expect(Bun.Glob).not.toBe(pristineGlob);
    expect(globalThis.fetch).not.toBe(pristineFetch);
    expect(() => (Bun.file as unknown as () => void)()).toThrow(FS_DENY);
    expect(() => (Bun.write as unknown as () => void)()).toThrow(FS_DENY);
  });

  test("adds no property the real Bun namespace lacks", () => {
    // The phantom-denier guard, asserted directly against the live namespace
    // this time: `Bun.glob` and `Bun.dlopen` never existed, and assigning to
    // them created properties instead of blocking anything.
    expect(Object.hasOwn(Bun, "glob")).toBe(false);
    expect(Object.hasOwn(Bun, "dlopen")).toBe(false);
  });

  test("Bun.Glob#match still works; scan/scanSync deny", () => {
    const g = new Bun.Glob("**/*.ts");
    expect(g.match("a/b.ts")).toBe(true);
    expect(g.match("a/b.js")).toBe(false);
    expect(() => g.scanSync({ cwd: "/etc" })).toThrow(FS_DENY);
    expect(() => g.scan({ cwd: "/etc" })).toThrow(FS_DENY);
  });

  test("blocked require ids throw; unblocked ones pass through", () => {
    // Exercises both arms of the patched `require`: a hit in the blocked-id
    // map, and the early return for everything else.
    expect(() => require("node:fs")).toThrow(FS_DENY);
    expect(() => require("bun:ffi")).toThrow(/requires 'native' permission/);
    expect(typeof (require("node:path") as { join: unknown }).join).toBe(
      "function",
    );
  });

  test("process.binding denylist blocks fs, passes other names through", () => {
    expect(() =>
      (process as unknown as { binding: (n: string) => unknown }).binding("fs"),
    ).toThrow(/process\.binding/);
  });
});
