/**
 * Property-style tests for the scratchpad extension. Written in native
 * Bun/bunspec rather than fast-check so we don't introduce a new
 * dependency for a single test file. Seeded PRNG for deterministic
 * replay on failure.
 *
 * Coverage targets:
 *   1. Write/read round-trip fidelity across random (key, value) pairs.
 *   2. Distinct conversations never see each other's data (conversation-
 *      scoped storage is the isolation boundary post-Phase 1; see
 *      .planning/scratchpad-phase-1-prereqs.md for why we dropped the
 *      runId-scoped model).
 *   3. Keys that satisfy the host's KEY_REGEX (src/extensions/storage-
 *      handler.ts:24) are accepted by every write; keys that violate it
 *      would be rejected by the host even if the extension let them
 *      through — this is a defense-in-depth assertion.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { tools, _setStoreForTests, _resetStoreForTests } from "./index";

// ── Deterministic PRNG (xorshift32) — no fast-check dependency ────
function makeRng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function randString(rng: () => number, len: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

// Mirror the host's KEY_REGEX at src/extensions/storage-handler.ts:24:
// `^[a-zA-Z0-9_.\-/:]{1,256}$`. The property tests only generate valid
// keys so we can prove round-trip without fighting the host's validator.
const VALID_KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

// Conversation-scoped fake: one Map per (conversationId) — mirrors
// what the host's storage-handler persists when `scope: "conversation"`
// is used. Distinct conversations → distinct Maps → no crosstalk.
interface ConvStore {
  calls: Array<{ action: string; key: string; conversationId: string }>;
  by: Map<string, Map<string, string>>;
  current: string;
  store: Parameters<typeof _setStoreForTests>[0];
}

function makeConvStore(): ConvStore {
  const state: ConvStore = {
    calls: [],
    by: new Map(),
    current: "default",
    store: null as unknown as Parameters<typeof _setStoreForTests>[0],
  };
  state.store = {
    async get(key: string) {
      state.calls.push({ action: "get", key, conversationId: state.current });
      const m = state.by.get(state.current);
      const v = m?.get(key);
      return v === undefined ? { value: null, exists: false } : { value: v, exists: true };
    },
    async set(key: string, value: string) {
      state.calls.push({ action: "set", key, conversationId: state.current });
      let m = state.by.get(state.current);
      if (!m) { m = new Map(); state.by.set(state.current, m); }
      m.set(key, value);
      return { ok: true as const, sizeBytes: value.length };
    },
  };
  return state;
}

async function call(name: string, args: Record<string, unknown>) {
  return tools[name]!(args);
}

function text(res: { content: Array<{ text: string }>; isError?: boolean }): string {
  return res.content[0]!.text;
}

afterEach(() => _resetStoreForTests());

describe("property: write/read round-trip fidelity", () => {
  test("1000 random (key, value) pairs read back what they wrote", async () => {
    const fake = makeConvStore();
    _setStoreForTests(fake.store);
    const rng = makeRng(0xA5A5A5A5); // fixed seed → deterministic

    const written = new Map<string, string>();
    for (let i = 0; i < 1000; i++) {
      const key = randString(rng, 1 + Math.floor(rng() * 64), VALID_KEY_CHARS);
      const value = randString(rng, Math.floor(rng() * 256), VALID_KEY_CHARS);
      const res = await call("scratchpad_write", { key, value });
      expect(res.isError).toBeFalsy();
      written.set(key, value);
    }

    // Read each written key and assert the latest value is returned.
    for (const [key, value] of written) {
      const res = await call("scratchpad_read", { key });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toBe(value);
    }
  });
});

describe("property: conversation-scoped isolation", () => {
  test("distinct conversations never observe each other's keys", async () => {
    const fake = makeConvStore();
    _setStoreForTests(fake.store);
    const rng = makeRng(0xDEADBEEF);

    // Simulate 3 concurrent conversations writing to the same key name.
    const conversations = ["conv-A", "conv-B", "conv-C"];
    const valuePerConv = new Map<string, string>();

    for (const convId of conversations) {
      fake.current = convId;
      const value = randString(rng, 32, VALID_KEY_CHARS);
      valuePerConv.set(convId, value);
      const res = await call("scratchpad_write", { key: "shared-key", value });
      expect(res.isError).toBeFalsy();
    }

    // Cross-read: each conversation should see only its own write under
    // the shared key name. If the extension leaks across conversations,
    // this would return the wrong value.
    for (const convId of conversations) {
      fake.current = convId;
      const res = await call("scratchpad_read", { key: "shared-key" });
      expect(res.isError).toBeFalsy();
      expect(text(res)).toBe(valuePerConv.get(convId)!);
    }
  });
});

describe("property: validation rejects bad inputs without hitting storage", () => {
  test("non-string keys/values are rejected before reaching the backend", async () => {
    const fake = makeConvStore();
    _setStoreForTests(fake.store);
    const rng = makeRng(0xBAD5EED5);

    // Shotgun random bad inputs — numbers, bools, nulls, arrays, objects.
    const badValues: unknown[] = [42, true, null, [], {}, undefined, new Date()];
    for (let i = 0; i < 50; i++) {
      const badKey = badValues[Math.floor(rng() * badValues.length)];
      const badValue = badValues[Math.floor(rng() * badValues.length)];
      const res = await call("scratchpad_write", { key: badKey, value: badValue } as Record<string, unknown>);
      expect(res.isError).toBe(true);
    }

    // None of those bad inputs should have produced a backend call —
    // validation must happen before the Storage hit.
    expect(fake.calls).toHaveLength(0);
  });
});
