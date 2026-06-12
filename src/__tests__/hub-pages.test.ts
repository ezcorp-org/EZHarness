/**
 * Extension Pages Hub — core provider registry tests.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  registerHubPageProvider,
  getHubPageProvider,
  listHubPageProviders,
  _resetHubPageProvidersForTests,
  HUB_PROVIDER_ID_REGEX,
  type HubPageProvider,
} from "../runtime/hub-pages";

function makeProvider(overrides: Partial<HubPageProvider> = {}): HubPageProvider {
  return {
    id: "demo",
    title: "Demo",
    render: async () => ({ title: "Demo", nodes: [] }),
    ...overrides,
  };
}

beforeEach(() => {
  _resetHubPageProvidersForTests();
});

describe("registerHubPageProvider", () => {
  test("registers and resolves by id", () => {
    const p = makeProvider();
    registerHubPageProvider(p);
    expect(getHubPageProvider("demo")).toBe(p);
  });

  test("unknown id resolves to undefined", () => {
    expect(getHubPageProvider("nope")).toBeUndefined();
  });

  test("re-registering the same id replaces the provider (HMR-safe)", () => {
    registerHubPageProvider(makeProvider({ title: "First" }));
    registerHubPageProvider(makeProvider({ title: "Second" }));
    expect(listHubPageProviders()).toHaveLength(1);
    expect(getHubPageProvider("demo")!.title).toBe("Second");
  });

  test("rejects malformed ids", () => {
    for (const bad of ["", "UPPER", "has space", "a".repeat(40), "-lead", "dots.bad", "slash/x"]) {
      expect(() => registerHubPageProvider(makeProvider({ id: bad }))).toThrow(/Invalid hub page provider id/);
    }
  });

  test("rejects malformed action names", () => {
    expect(() =>
      registerHubPageProvider(
        makeProvider({ actions: { "Bad Action": async () => undefined } }),
      ),
    ).toThrow(/Invalid hub page action name/);
  });

  test("accepts valid action names and exposes them", () => {
    registerHubPageProvider(
      makeProvider({ actions: { "run-now": async () => undefined } }),
    );
    expect(Object.keys(getHubPageProvider("demo")!.actions!)).toEqual(["run-now"]);
  });
});

describe("listHubPageProviders", () => {
  test("preserves registration order", () => {
    registerHubPageProvider(makeProvider({ id: "bravo", title: "B" }));
    registerHubPageProvider(makeProvider({ id: "alpha", title: "A" }));
    expect(listHubPageProviders().map((p) => p.id)).toEqual(["bravo", "alpha"]);
  });

  test("empty registry lists nothing", () => {
    expect(listHubPageProviders()).toEqual([]);
  });
});

describe("HUB_PROVIDER_ID_REGEX", () => {
  test("matches the documented slug shape", () => {
    expect(HUB_PROVIDER_ID_REGEX.test("briefing")).toBe(true);
    expect(HUB_PROVIDER_ID_REGEX.test("a1-b2")).toBe(true);
    expect(HUB_PROVIDER_ID_REGEX.test("x".repeat(32))).toBe(true);
    expect(HUB_PROVIDER_ID_REGEX.test("x".repeat(33))).toBe(false);
  });
});

describe("provider render contract", () => {
  test("render receives the userId context", async () => {
    let seen: string | undefined;
    registerHubPageProvider(
      makeProvider({
        render: async (ctx) => {
          seen = ctx.userId;
          return { title: "T", nodes: [] };
        },
      }),
    );
    await getHubPageProvider("demo")!.render({ userId: "user-7" });
    expect(seen).toBe("user-7");
  });
});
