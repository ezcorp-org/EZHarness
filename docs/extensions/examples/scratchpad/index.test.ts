import { test, expect, describe, afterEach } from "bun:test";

// Import the extension's tools map + test-injection hooks. The `store`
// binding inside index.ts is swapped via `_setStoreForTests` so these
// unit tests run without any JSON-RPC / host-channel plumbing; the
// integration tests at src/__tests__/scratchpad-extension.integration.test.ts
// exercise the real storage pipeline.
import { tools, _setStoreForTests, _resetStoreForTests } from "./index";

interface FakeStoreCall {
  action: "get" | "set";
  key: string;
  value?: string;
  ttlSeconds?: number;
}

function makeFakeStore(): {
  calls: FakeStoreCall[];
  map: Map<string, string>;
  throwOnSet?: Error;
  throwOnGet?: Error;
  store: Parameters<typeof _setStoreForTests>[0];
} {
  const state = {
    calls: [] as FakeStoreCall[],
    map: new Map<string, string>(),
    throwOnSet: undefined as Error | undefined,
    throwOnGet: undefined as Error | undefined,
    store: null as unknown as Parameters<typeof _setStoreForTests>[0],
  };
  state.store = {
    async get(key: string) {
      state.calls.push({ action: "get", key });
      if (state.throwOnGet) throw state.throwOnGet;
      const v = state.map.get(key);
      return v === undefined
        ? { value: null, exists: false }
        : { value: v, exists: true };
    },
    async set(key: string, value: string, opts?: { ttlSeconds?: number }) {
      state.calls.push({ action: "set", key, value, ttlSeconds: opts?.ttlSeconds });
      if (state.throwOnSet) throw state.throwOnSet;
      state.map.set(key, value);
      return { ok: true as const, sizeBytes: value.length };
    },
  };
  return state;
}

async function call(name: string, args: Record<string, unknown>) {
  const handler = tools[name];
  if (!handler) throw new Error(`test bug: unknown tool ${name}`);
  return handler(args);
}

function text(res: { content: Array<{ text: string }>; isError?: boolean }): string {
  return res.content[0]!.text;
}

afterEach(() => {
  _resetStoreForTests();
});

describe("scratchpad_write — positive cases", () => {
  test("stores a value and returns confirmation with length", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_write", { key: "a", value: "v1" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('Stored key "a" (2 chars)');
    expect(fake.map.get("a")).toBe("v1");
  });

  test("second write to same key overwrites first", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    await call("scratchpad_write", { key: "a", value: "v1" });
    await call("scratchpad_write", { key: "a", value: "v2" });

    const readRes = await call("scratchpad_read", { key: "a" });
    expect(text(readRes)).toBe("v2");
  });

  test("writes include a 24h TTL so stale pads expire via storage-handler", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    await call("scratchpad_write", { key: "a", value: "v" });
    const setCall = fake.calls.find((c) => c.action === "set");
    expect(setCall?.ttlSeconds).toBe(86400);
  });
});

describe("scratchpad_read — positive cases", () => {
  test("returns stored value after a write", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    await call("scratchpad_write", { key: "foo", value: "bar" });
    const res = await call("scratchpad_read", { key: "foo" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe("bar");
  });

  test("returns not-found message for missing key", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_read", { key: "missing" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('Key "missing" not found in scratchpad');
  });
});

describe("argument validation", () => {
  test("scratchpad_write rejects missing key", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_write", { value: "v" } as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("requires string 'key' and 'value'");
    expect(fake.map.size).toBe(0); // never reached the backend
  });

  test("scratchpad_write rejects non-string value", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_write", { key: "a", value: 123 } as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(fake.map.size).toBe(0);
  });

  test("scratchpad_read rejects missing key", async () => {
    const fake = makeFakeStore();
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_read", {} as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("requires a string 'key'");
  });
});

describe("error surfacing", () => {
  test("storage-backend rejections surface as tool errors, not uncaught throws", async () => {
    const fake = makeFakeStore();
    fake.throwOnSet = new Error("mock permission denied");
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_write", { key: "a", value: "v" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("mock permission denied");
  });

  test("read failures also surface as tool errors", async () => {
    const fake = makeFakeStore();
    fake.throwOnGet = new Error("mock RPC timeout");
    _setStoreForTests(fake.store);

    const res = await call("scratchpad_read", { key: "a" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("mock RPC timeout");
  });
});
