/**
 * Failure semantics for the bundled conversation-wiring reconcile.
 *
 * Both entry points in `src/extensions/auto-wire-bundled.ts` run inside
 * hosts that must not fail on a wiring miss: `autoWireBundledExtensions`
 * runs inside `createConversation`, and
 * `reconcileBundledConversationWiring` runs inside boot
 * (`ensureBundledExtensions`) and inside release activation
 * (`publishExtensionGeneration`). A throw from either would take down
 * conversation creation, the whole boot, or an operator's activation.
 *
 * So: the registry lookup is forced to throw for every bundled name,
 * and both helpers must still resolve — returning 0 rows wired, having
 * logged one warning per name. No DB is involved; the throw happens
 * before the first query.
 *
 * The warnings are read off the REAL logger's stderr stream rather than
 * from a mocked `../logger`. A logger mock cannot work here: the module
 * binds `logger.child("auto-wire-bundled")` once at evaluation, and
 * `mock-cleanup`'s preload snapshot imports the module before any test
 * file runs, so the child logger is already captured. Spying on the
 * sink also makes the assertion stronger — it proves what an operator
 * would actually see in the log.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const lookups: string[] = [];
mock.module("../db/queries/extensions", () => ({
  async getExtensionByName(name: string) {
    lookups.push(name);
    throw new Error("registry unavailable");
  },
}));

const {
  AUTO_WIRE_BUNDLED_EXTENSION_NAMES,
  autoWireBundledExtensions,
  reconcileBundledConversationWiring,
} = await import("../extensions/auto-wire-bundled");

let stderrWrite: ReturnType<typeof spyOn<typeof process.stderr, "write">>;
let emitted: string[];

/** Warn lines this module emitted, decoded from the logger's JSON. */
function warnings(): Record<string, unknown>[] {
  return emitted
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.subsystem === "auto-wire-bundled" && entry.level === "warn");
}

beforeEach(() => {
  lookups.length = 0;
  emitted = [];
  stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    emitted.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrWrite.mockRestore();
});

afterAll(() => {
  restoreModuleMocks();
});

describe("auto-wire failures are logged and swallowed", () => {
  test("reconcile resolves to zero and warns once per bundled name", async () => {
    expect(await reconcileBundledConversationWiring()).toBe(0);

    // Every name is still attempted — one broken extension must not
    // stop the reconcile reaching its siblings.
    expect(lookups).toEqual([...AUTO_WIRE_BUNDLED_EXTENSION_NAMES]);

    const logged = warnings();
    expect(logged).toHaveLength(AUTO_WIRE_BUNDLED_EXTENSION_NAMES.length);
    for (const entry of logged) {
      expect(entry.msg).toBe("reconcile failed for bundled extension");
      expect(entry.error).toBe("registry unavailable");
    }
    expect(logged.map((entry) => entry.extensionName)).toEqual([
      ...AUTO_WIRE_BUNDLED_EXTENSION_NAMES,
    ]);
  });

  test("the create-time hook resolves to zero and names the conversation", async () => {
    expect(await autoWireBundledExtensions("conv-under-test")).toBe(0);

    expect(lookups).toEqual([...AUTO_WIRE_BUNDLED_EXTENSION_NAMES]);

    const logged = warnings();
    expect(logged).toHaveLength(AUTO_WIRE_BUNDLED_EXTENSION_NAMES.length);
    for (const entry of logged) {
      expect(entry.msg).toBe("auto-wire failed for bundled extension");
      // The conversation id is what makes the warning actionable.
      expect(entry.conversationId).toBe("conv-under-test");
      expect(entry.error).toBe("registry unavailable");
    }
  });
});
