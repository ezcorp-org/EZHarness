// ── Phase 5 — host-store adapter unit coverage ──────────────────
//
// `src/extensions/entities/host-store.ts` is the bridge between the
// SDK's pure `EntityStoreLike` interface and the host's
// `extension_storage` queries. The adapter is small but
// load-bearing: every host-served entity tool dispatch (and every
// install-time seed / migrate) routes through it. Failures here are
// silent at runtime because the SDK keeps validating shapes upstream,
// so explicit coverage is required.
//
// This file mocks the three storage queries at the module boundary
// (`getStorageValue`, `setStorageValue`, `deleteStorageValue`) and
// asserts:
//   - `mapScope` routes "user" / "conversation" / "project" correctly
//   - `get` returns `{value, exists: true}` for plain rows
//   - `get` returns `{value: null, exists: false}` for encrypted rows
//     (defensive — host-served path never writes encrypted, but a
//     manually tampered DB shouldn't leak ciphertext)
//   - `set` JSON-serializes the value and reports the correct byte
//     length to the storage layer
//   - `delete` returns `{deleted}` reflecting the underlying boolean

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Capture every call so the assertions can read the exact args.
type SetCall = {
  extensionId: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: unknown;
  encrypted: boolean;
  sizeBytes: number;
  expiresAt?: Date;
};
type GetCall = {
  extensionId: string;
  scope: string;
  scopeId: string | null;
  key: string;
};
type DeleteCall = GetCall;

const calls = {
  set: [] as SetCall[],
  get: [] as GetCall[],
  delete: [] as DeleteCall[],
};

// Row to return on the next `get` call (per-test override).
let nextGetReturn: { value: unknown; encrypted: boolean; sizeBytes: number } | null = null;
let nextDeleteReturn = true;

mock.module("../db/queries/extension-storage", () => ({
  getStorageValue: async (
    extensionId: string,
    scope: string,
    scopeId: string | null,
    key: string,
  ) => {
    calls.get.push({ extensionId, scope, scopeId, key });
    return nextGetReturn;
  },
  setStorageValue: async (
    extensionId: string,
    scope: string,
    scopeId: string | null,
    key: string,
    value: unknown,
    encrypted: boolean,
    sizeBytes: number,
    expiresAt?: Date,
  ) => {
    calls.set.push({
      extensionId,
      scope,
      scopeId,
      key,
      value,
      encrypted,
      sizeBytes,
      ...(expiresAt ? { expiresAt } : {}),
    });
  },
  deleteStorageValue: async (
    extensionId: string,
    scope: string,
    scopeId: string | null,
    key: string,
  ) => {
    calls.delete.push({ extensionId, scope, scopeId, key });
    return nextDeleteReturn;
  },
}));

// Import AFTER mock.module so the host-store adapter binds to the
// mocked storage queries (bun's mock.module replaces the module in
// the registry; the import below resolves through that replacement).
import { createHostEntityStore } from "../extensions/entities/host-store";

beforeEach(() => {
  calls.set = [];
  calls.get = [];
  calls.delete = [];
  nextGetReturn = null;
  nextDeleteReturn = true;
});

afterEach(() => {
  // Defensive — bun mock.module persists across tests in a file, but
  // we reset the per-test state above so each test runs in isolation.
});

// Bun's `mock.module()` permanently rewrites the loader cache; without
// this `afterAll` cleanup the storage-query mock leaks into every
// subsequent test file in the run (the symptom is seed/index tests
// thinking the DB has no prior state because every read returns null).
// See `helpers/mock-cleanup.ts` for the full pattern.
afterAll(() => {
  restoreModuleMocks();
});

describe("createHostEntityStore — scope mapping", () => {
  test("scope=user routes through with the user id as scopeId", async () => {
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "user-abc",
    });
    await store.get("k");
    expect(calls.get[0]).toEqual({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "user-abc",
      key: "k",
    });
  });

  test("scope=conversation routes through with the conversation id", async () => {
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "conversation",
      scopeId: "conv-xyz",
    });
    await store.get("k");
    expect(calls.get[0]).toEqual({
      extensionId: "ext-1",
      scope: "conversation",
      scopeId: "conv-xyz",
      key: "k",
    });
  });

  test("scope=project falls back to conversation storage tier (v1 has no project tier)", async () => {
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "project",
      scopeId: "proj-id",
    });
    await store.get("k");
    // The adapter maps `project` → `conversation` until v1.X ships a
    // dedicated project-scoped storage tier (see host-store.ts).
    expect(calls.get[0]?.scope).toBe("conversation");
    expect(calls.get[0]?.scopeId).toBe("proj-id");
  });
});

describe("createHostEntityStore.get", () => {
  test("returns {value, exists: true} for a plain row", async () => {
    nextGetReturn = {
      value: { name: "Weekly", cadence: "weekly" },
      encrypted: false,
      sizeBytes: 32,
    };
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const res = await store.get<{ name: string }>("__entity:post-type:weekly");
    expect(res.exists).toBe(true);
    expect(res.value).toEqual({ name: "Weekly", cadence: "weekly" } as never);
  });

  test("returns {value: null, exists: false} when the row is missing", async () => {
    nextGetReturn = null;
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const res = await store.get("__entity:post-type:missing");
    expect(res.exists).toBe(false);
    expect(res.value).toBeNull();
  });

  test("encrypted rows surface as {value: null, exists: false} (no ciphertext leak)", async () => {
    // Host-served path NEVER writes encrypted entity records, but a
    // manually tampered DB row shouldn't bleed ciphertext into the
    // soft-read path. The adapter is the chokepoint that masks it.
    nextGetReturn = {
      value: "ciphertext-here",
      encrypted: true,
      sizeBytes: 16,
    };
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const res = await store.get("__entity:post-type:weekly");
    expect(res.exists).toBe(false);
    expect(res.value).toBeNull();
  });
});

describe("createHostEntityStore.set", () => {
  test("serializes the value to JSON and computes byte length", async () => {
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const value = { name: "Weekly", cadence: "weekly", emoji: "🚀" };
    await store.set("__entity:post-type:weekly", value);
    expect(calls.set.length).toBe(1);
    const expected = Buffer.byteLength(JSON.stringify(value), "utf-8");
    // The rocket emoji is multi-byte, so this catches naive .length
    // implementations that would report char count rather than bytes.
    expect(calls.set[0]?.sizeBytes).toBe(expected);
    expect(calls.set[0]?.value).toEqual(value);
    // Host-served path never encrypts entity records.
    expect(calls.set[0]?.encrypted).toBe(false);
    expect(calls.set[0]?.key).toBe("__entity:post-type:weekly");
  });

  test("returns {ok: true, sizeBytes} so callers can log writes", async () => {
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const res = (await store.set("k", { a: 1 })) as {
      ok: boolean;
      sizeBytes: number;
    };
    expect(res.ok).toBe(true);
    expect(res.sizeBytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }), "utf-8"));
  });
});

describe("createHostEntityStore.delete", () => {
  test("returns {deleted: true} when the underlying query removed a row", async () => {
    nextDeleteReturn = true;
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const res = await store.delete("__entity:post-type:weekly");
    expect(res).toEqual({ deleted: true });
    expect(calls.delete[0]?.key).toBe("__entity:post-type:weekly");
  });

  test("returns {deleted: false} when there was no matching row", async () => {
    nextDeleteReturn = false;
    const store = createHostEntityStore({
      extensionId: "ext-1",
      scope: "user",
      scopeId: "u",
    });
    const res = await store.delete("__entity:post-type:nope");
    expect(res).toEqual({ deleted: false });
  });
});
