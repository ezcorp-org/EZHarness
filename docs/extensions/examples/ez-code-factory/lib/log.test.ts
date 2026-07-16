import { test, expect, describe, spyOn, afterEach } from "bun:test";
import { logLine, _setLogSinkForTests } from "./log";

describe("logLine (sandbox-safe stderr sink)", () => {
  // Every test must leave the module-global sink back on its Bun.stderr default
  // so a swapped collector never leaks into another suite.
  afterEach(() => _setLogSinkForTests(null));

  test("routes each message through the injected sink with a trailing newline", () => {
    const lines: string[] = [];
    _setLogSinkForTests((line) => {
      lines.push(line);
    });
    logLine("hello");
    logLine("world");
    expect(lines).toEqual(["hello\n", "world\n"]);
  });

  test("_setLogSinkForTests(null) detaches the collector + restores the default", () => {
    const lines: string[] = [];
    _setLogSinkForTests((line) => {
      lines.push(line);
    });
    _setLogSinkForTests(null);
    // Back on the default Bun.stderr sink: no throw, and the collector is gone.
    expect(() => logLine("via the default sink")).not.toThrow();
    expect(lines).toEqual([]);
  });

  test("the default sink survives a poisoned process.stderr (B1 regression)", () => {
    // Simulate the Phase-3 sandbox: `process.stderr.write` lazily constructs a
    // poisoned `node:fs` WriteStream and THROWS. The default sink writes via
    // `Bun.stderr`, which is not gated by the fs poison, so logLine must NOT
    // throw — this is the exact crash that killed the subprocess on start
    // before the fix. Two calls exercise both the lazy writer-init branch and
    // the cached-writer branch.
    const spy = spyOn(process.stderr, "write").mockImplementation((() => {
      throw new Error("Extension sandbox: 'fs module' blocked");
    }) as typeof process.stderr.write);
    try {
      expect(() => {
        logLine("first line — exercises lazy writer init");
        logLine("second line — exercises the cached writer");
      }).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
