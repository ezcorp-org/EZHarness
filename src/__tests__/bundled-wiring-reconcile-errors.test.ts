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
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const warnings: { msg: string; fields: Record<string, unknown> }[] = [];

mock.module("../logger", () => {
  const child = () => ({
    error() {},
    warn(msg: string, fields: Record<string, unknown>) {
      warnings.push({ msg, fields });
    },
    info() {},
    debug() {},
    child,
  });
  return { logger: child(), extensionLogger: child };
});

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

beforeEach(() => {
  warnings.length = 0;
  lookups.length = 0;
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
    expect(warnings).toHaveLength(AUTO_WIRE_BUNDLED_EXTENSION_NAMES.length);
    for (const warning of warnings) {
      expect(warning.msg).toBe("reconcile failed for bundled extension");
      expect(warning.fields.error).toBe("registry unavailable");
    }
    expect(warnings.map((w) => w.fields.extensionName)).toEqual([
      ...AUTO_WIRE_BUNDLED_EXTENSION_NAMES,
    ]);
  });

  test("the create-time hook resolves to zero and names the conversation", async () => {
    expect(await autoWireBundledExtensions("conv-under-test")).toBe(0);

    expect(lookups).toEqual([...AUTO_WIRE_BUNDLED_EXTENSION_NAMES]);
    expect(warnings).toHaveLength(AUTO_WIRE_BUNDLED_EXTENSION_NAMES.length);
    for (const warning of warnings) {
      expect(warning.msg).toBe("auto-wire failed for bundled extension");
      // The conversation id is what makes the warning actionable.
      expect(warning.fields.conversationId).toBe("conv-under-test");
      expect(warning.fields.error).toBe("registry unavailable");
    }
  });
});
