// ── Phase 8 — entity lifecycle end-to-end ───────────────────────
//
// Drives the full path through `installFromLocal` →
// `runEntityNamespaceMigration` (no-op for the fixture) →
// `runEntitySeed` (inserts 2 records via {file:...} placeholders) →
// `ExtensionRegistry.loadFromDb` → `ToolExecutor.executeToolCall`
// for each of the 5 auto-generated CRUD tools.
//
// The fixture extension lives at
// `src/__tests__/helpers/test-entities-fixture/` — one `note` entity
// declaration, two seed records, no LLM/MCP/tools[]. This isolates
// SDK behavior from substack-pilot's surface so a regression here
// pinpoints "the SDK or its host wiring" without ambiguity.
//
// Coverage in this single test file:
//   - Install side: fixture installs cleanly, seeds populate 2
//     records under the managed namespace at the installing user
//   - Dispatch side: list_notes returns the 2 seeds, get_note reads
//     one, create_note adds a third (validates), update_note shallow-
//     merges, delete_note removes a record
//   - Validation: a create with bad data returns isError=true with
//     a structured validation message
//   - The subprocess is NEVER spawned (the fixture has no entrypoint
//     and the test would error if any path tried to launch it)

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { eq } from "drizzle-orm";
import { extensions, extensionStorage, users } from "../db/schema";
import { installFromLocal } from "../extensions/installer";
import { ExtensionRegistry } from "../extensions/registry";
import {
  _resetToolCallsCounterForTests,
  ToolExecutor,
} from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

const FIXTURE_PATH = join(import.meta.dir, "helpers", "test-entities-fixture");

let extId: string;
let userId: string;
let executor: ToolExecutor;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(extensions);
  await db.delete(users);
  ExtensionRegistry.resetInstance();
  _resetToolCallsCounterForTests();

  const [u] = await db
    .insert(users)
    .values({
      email: "e2e@example.com",
      passwordHash: "x",
      name: "E2E",
      role: "member",
    })
    .returning();
  userId = u!.id;

  // Install the fixture extension. `userId` is supplied so seed runs
  // synchronously into the user's scope — matching what the
  // user-driven install path does in production.
  const installed = await installFromLocal(
    FIXTURE_PATH,
    {
      storage: true,
      grantedAt: { storage: Date.now() },
    },
    /* enabled */ true,
    { userId },
  );
  extId = installed.id;

  const registry = ExtensionRegistry.getInstance();
  await registry.loadFromDb();
  // Defense-in-depth: a fresh executor with allow-all PDP. Same
  // shape as `entities-dispatcher.test.ts` but goes through the
  // real install path rather than a manually-seeded extensions row.
  executor = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));
  executor.setCurrentUserId(userId);
});

function parse(text: string): unknown {
  return JSON.parse(text);
}

describe("entities — install → seed → dispatch end-to-end", () => {
  test("seed populated 2 records under the managed namespace", async () => {
    const db = getTestDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(eq(extensionStorage.extensionId, extId));
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(
      [
        "__entity-index:note",
        "__entity:note:first",
        "__entity:note:second",
      ].sort(),
    );

    // {file:...} placeholders resolved at install time.
    const first = rows.find((r) => r.key === "__entity:note:first")!;
    expect(
      (first.value as { title: string; body: string }).body,
    ).toMatch(/^First seed body/);
  });

  test("list_notes through the dispatcher returns the 2 seeds", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__list_notes",
      {},
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);
    const out = parse(res.content[0]!.text) as {
      items: Array<{ slug: string }>;
    };
    expect(out.items.map((r) => r.slug).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  test("get_note returns the requested record", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__get_note",
      { slug: "first" },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);
    const out = parse(res.content[0]!.text) as {
      slug: string;
      data: { title: string; pinned?: boolean };
    };
    expect(out.slug).toBe("first");
    expect(out.data.title).toBe("First Note");
    expect(out.data.pinned).toBe(true);
  });

  test("create_note adds a third record", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__create_note",
      {
        slug: "third",
        data: { title: "Third Note", body: "From the test." },
      },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);

    const list = await executor.executeToolCall(
      "test-entities-fixture__list_notes",
      {},
      "conv-1",
      "msg-2",
    );
    const out = parse(list.content[0]!.text) as {
      items: Array<{ slug: string }>;
    };
    expect(out.items.map((r) => r.slug).sort()).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("create_note with invalid data returns isError", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__create_note",
      {
        slug: "fourth",
        data: { title: "" /* fails minLength: 1 */, body: "x" },
      },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/minLength|required/);
  });

  test("update_note shallow-merges patch onto existing record", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__update_note",
      {
        slug: "second",
        patch: { title: "Second Note (edited)" },
      },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);

    const got = await executor.executeToolCall(
      "test-entities-fixture__get_note",
      { slug: "second" },
      "conv-1",
      "msg-2",
    );
    const out = parse(got.content[0]!.text) as {
      data: { title: string; body: string };
    };
    expect(out.data.title).toBe("Second Note (edited)");
    // body preserved (shallow merge)
    expect(out.data.body).toMatch(/^Second seed body/);
  });

  test("update_note with invalid data returns isError", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__update_note",
      {
        slug: "first",
        patch: { title: "" /* fails minLength */ },
      },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(true);
  });

  test("delete_note removes the record", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__delete_note",
      { slug: "first" },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);
    const out = parse(res.content[0]!.text) as { deleted: boolean };
    expect(out.deleted).toBe(true);

    const list = await executor.executeToolCall(
      "test-entities-fixture__list_notes",
      {},
      "conv-1",
      "msg-2",
    );
    const listOut = parse(list.content[0]!.text) as {
      items: Array<{ slug: string }>;
    };
    expect(listOut.items.map((r) => r.slug)).toEqual(["second"]);
  });

  test("delete_note on missing slug returns deleted: false (no-op)", async () => {
    const res = await executor.executeToolCall(
      "test-entities-fixture__delete_note",
      { slug: "ghost" },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);
    const out = parse(res.content[0]!.text) as { deleted: boolean };
    expect(out.deleted).toBe(false);
  });

  test("full lifecycle: create → update → delete → list shows expected state", async () => {
    // Create
    await executor.executeToolCall(
      "test-entities-fixture__create_note",
      {
        slug: "draft",
        data: { title: "Draft", body: "scratch", pinned: false },
      },
      "conv-1",
      "msg-1",
    );
    // Update
    await executor.executeToolCall(
      "test-entities-fixture__update_note",
      {
        slug: "draft",
        patch: { pinned: true },
      },
      "conv-1",
      "msg-2",
    );
    const got = await executor.executeToolCall(
      "test-entities-fixture__get_note",
      { slug: "draft" },
      "conv-1",
      "msg-3",
    );
    expect((parse(got.content[0]!.text) as { data: { pinned: boolean } }).data.pinned).toBe(true);

    // Delete two records (one of the seeds + the new draft).
    await executor.executeToolCall(
      "test-entities-fixture__delete_note",
      { slug: "first" },
      "conv-1",
      "msg-4",
    );
    await executor.executeToolCall(
      "test-entities-fixture__delete_note",
      { slug: "draft" },
      "conv-1",
      "msg-5",
    );

    const list = await executor.executeToolCall(
      "test-entities-fixture__list_notes",
      {},
      "conv-1",
      "msg-6",
    );
    const listOut = parse(list.content[0]!.text) as {
      items: Array<{ slug: string }>;
    };
    expect(listOut.items.map((r) => r.slug)).toEqual(["second"]);
  });
});
