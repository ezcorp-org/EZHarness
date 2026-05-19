// ── Phase 3 — entity tools dispatch through SDK, NOT subprocess ──
//
// Critical regression suite. The "ai-kit subprocess that throws on any
// tool call" pattern locks in the contract: entity tools live entirely
// on the host; the extension subprocess is never spawned for them.
//
// The test wires a real PGlite + a real ExtensionRegistry with an
// extension row that declares an entity, then injects a fake
// `ExtensionProcess` that throws on every `callTool` invocation. Each
// CRUD tool call must succeed despite that — proving the dispatcher
// branched into the SDK path.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { eq } from "drizzle-orm";
import { extensions, extensionStorage, users } from "../db/schema";
import {
  _resetToolCallsCounterForTests,
  ToolExecutor,
} from "../extensions/tool-executor";
import { ExtensionRegistry } from "../extensions/registry";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

const MANIFEST = {
  schemaVersion: 2,
  name: "test-ext",
  version: "1.0.0",
  description: "test",
  author: { name: "tester" },
  permissions: {},
  entities: [
    {
      type: "post-type",
      label: "Post Type",
      pluralLabel: "Post Types",
      scope: "user",
      schema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          cadence: { type: "string", enum: ["weekly", "monthly", "ad-hoc"] },
        },
        required: ["name", "cadence"],
        additionalProperties: false,
      },
    },
  ],
};

let userId: string;
let extId: string;

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
      email: "disp@example.com",
      passwordHash: "x",
      name: "X",
      role: "member",
    })
    .returning();
  userId = u!.id;
  const [e] = await db
    .insert(extensions)
    .values({
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      manifest: MANIFEST as never,
      source: "local:/tmp",
      installPath: "/tmp",
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
      checksumVerified: false,
      consecutiveFailures: 0,
    })
    .returning();
  extId = e!.id;
});

/**
 * Build a registry with a real ExtensionRegistry loaded from DB, then
 * monkey-patch `getProcess` to throw on every call. If the dispatcher
 * branches into the subprocess path for an entity tool, the throw
 * surfaces in the test response — proving the entity branch is broken.
 */
async function buildExecutor() {
  const registry = ExtensionRegistry.getInstance();
  await registry.loadFromDb();
  // Replace getProcess with a throwing stub. The registry is the
  // singleton instance; cast through unknown so TS lets us patch a
  // private method for the test boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (registry as any).getProcess = () => {
    throw new Error(
      "subprocess MUST NOT be spawned for SDK-served entity tools",
    );
  };
  const engine = createStubPermissionEngine("allow-all");
  const executor = new ToolExecutor(registry, engine);
  executor.setCurrentUserId(userId);
  return { executor, registry };
}

function parseToolResult(text: string): unknown {
  return JSON.parse(text);
}

describe("ToolExecutor — entity tools dispatch SDK-served", () => {
  test("create_post_type writes a record without spawning subprocess", async () => {
    const { executor } = await buildExecutor();
    const res = await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(false);
    const out = parseToolResult(res.content[0]!.text) as {
      slug: string;
      data: { name: string; cadence: string };
    };
    expect(out.slug).toBe("weekly");

    const db = getTestDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(eq(extensionStorage.extensionId, extId));
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(
      ["__entity-index:post-type", "__entity:post-type:weekly"].sort(),
    );
  });

  test("list_post_types returns the items array after create", async () => {
    const { executor } = await buildExecutor();
    await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
      "conv-1",
      "msg-1",
    );
    await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "monthly", data: { name: "Monthly", cadence: "monthly" } },
      "conv-1",
      "msg-2",
    );
    const res = await executor.executeToolCall(
      "test-ext__list_post_types",
      {},
      "conv-1",
      "msg-3",
    );
    expect(res.isError).toBe(false);
    const out = parseToolResult(res.content[0]!.text) as {
      items: Array<{ slug: string }>;
    };
    expect(out.items.map((r) => r.slug).sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );
  });

  test("get_post_type returns the record and update mutates it", async () => {
    const { executor } = await buildExecutor();
    await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
      "conv-1",
      "msg-1",
    );
    const got = await executor.executeToolCall(
      "test-ext__get_post_type",
      { slug: "weekly" },
      "conv-1",
      "msg-2",
    );
    const out = parseToolResult(got.content[0]!.text) as {
      slug: string;
      data: { name: string };
    };
    expect(out.data.name).toBe("Weekly");

    const upd = await executor.executeToolCall(
      "test-ext__update_post_type",
      { slug: "weekly", patch: { name: "Weekly Roundup" } },
      "conv-1",
      "msg-3",
    );
    expect(upd.isError).toBe(false);

    const got2 = await executor.executeToolCall(
      "test-ext__get_post_type",
      { slug: "weekly" },
      "conv-1",
      "msg-4",
    );
    const out2 = parseToolResult(got2.content[0]!.text) as {
      data: { name: string };
    };
    expect(out2.data.name).toBe("Weekly Roundup");
  });

  test("delete_post_type removes the record + updates the index", async () => {
    const { executor } = await buildExecutor();
    await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
      "conv-1",
      "msg-1",
    );
    const del = await executor.executeToolCall(
      "test-ext__delete_post_type",
      { slug: "weekly" },
      "conv-1",
      "msg-2",
    );
    expect(del.isError).toBe(false);
    const out = parseToolResult(del.content[0]!.text) as { deleted: boolean };
    expect(out.deleted).toBe(true);

    const db = getTestDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(eq(extensionStorage.extensionId, extId));
    // Index row remains with empty array; record is gone.
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["__entity-index:post-type"]);
    expect(rows[0]?.value).toEqual([]);
  });

  test("create with invalid data returns isError=true (validation gate)", async () => {
    const { executor } = await buildExecutor();
    const res = await executor.executeToolCall(
      "test-ext__create_post_type",
      // Missing required `cadence`
      { slug: "weekly", data: { name: "Weekly" } },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/cadence/);
  });

  test("create with invalid slug returns isError=true", async () => {
    const { executor } = await buildExecutor();
    const res = await executor.executeToolCall(
      "test-ext__create_post_type",
      {
        slug: "BAD SLUG",
        data: { name: "x", cadence: "weekly" },
      },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/invalid slug/);
  });

  test("dup create returns ALREADY_EXISTS", async () => {
    const { executor } = await buildExecutor();
    await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
      "conv-1",
      "msg-1",
    );
    const res = await executor.executeToolCall(
      "test-ext__create_post_type",
      { slug: "weekly", data: { name: "Weekly Again", cadence: "weekly" } },
      "conv-1",
      "msg-2",
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/already exists/);
  });

  test("get on missing slug returns NOT_FOUND", async () => {
    const { executor } = await buildExecutor();
    const res = await executor.executeToolCall(
      "test-ext__get_post_type",
      { slug: "missing" },
      "conv-1",
      "msg-1",
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not found/);
  });
});
