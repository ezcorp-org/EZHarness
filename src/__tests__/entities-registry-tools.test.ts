// ── Phase 3 — registry merges auto-generated entity tools ──────
//
// Validates that `ExtensionRegistry.loadFromDb()` produces the 5
// CRUD tool entries per declared entity, and that the entries carry
// the `entityKind` + `entityType` discriminators the dispatcher uses
// to route to the SDK handler instead of the subprocess.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { extensions } from "../db/schema";
import { ExtensionRegistry } from "../extensions/registry";
import { buildEntityRegisteredTools } from "../extensions/registry";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(extensions);
  ExtensionRegistry.resetInstance();
});

describe("buildEntityRegisteredTools (pure helper)", () => {
  test("returns 5 tools per declaration with correct kinds + types", () => {
    const tools = buildEntityRegisteredTools(
      [
        {
          type: "post-type",
          label: "Post Type",
          pluralLabel: "Post Types",
          schema: { type: "object" },
        },
      ],
      "ext-1",
      "test-ext",
      "test-ext",
    );
    expect(tools.length).toBe(5);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "test-ext__create_post_type",
        "test-ext__delete_post_type",
        "test-ext__get_post_type",
        "test-ext__list_post_types",
        "test-ext__update_post_type",
      ].sort(),
    );
    // Every tool carries the entity discriminators.
    for (const t of tools) {
      expect(t.entityType).toBe("post-type");
      expect(t.extensionId).toBe("ext-1");
      expect(t.originalName).toMatch(/_post_types?$/);
      expect(["list", "get", "create", "update", "delete"]).toContain(
        t.entityKind!,
      );
    }
  });

  test("returns empty array on undefined or empty entities", () => {
    expect(buildEntityRegisteredTools(undefined, "ext-1", "x", "x")).toEqual([]);
    expect(buildEntityRegisteredTools([], "ext-1", "x", "x")).toEqual([]);
  });

  test("handles multiple entity declarations", () => {
    const tools = buildEntityRegisteredTools(
      [
        {
          type: "post-type",
          label: "Post Type",
          pluralLabel: "Post Types",
          schema: { type: "object" },
        },
        {
          type: "character",
          label: "Character",
          pluralLabel: "Characters",
          schema: { type: "object" },
        },
      ],
      "ext-1",
      "x",
      "x",
    );
    expect(tools.length).toBe(10);
    const types = new Set(tools.map((t) => t.entityType));
    expect([...types].sort()).toEqual(["character", "post-type"]);
  });
});

describe("ExtensionRegistry.loadFromDb — auto-tool merge", () => {
  test("entity declarations produce tools in the registry's toolMap", async () => {
    const db = getTestDb();
    await db.insert(extensions).values({
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      manifest: {
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
            schema: { type: "object" },
          },
        ],
      } as never,
      source: "local:/tmp",
      installPath: "/tmp",
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
      checksumVerified: false,
      consecutiveFailures: 0,
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const allTools = registry.getAllTools();
    const names = allTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "test-ext__create_post_type",
        "test-ext__delete_post_type",
        "test-ext__get_post_type",
        "test-ext__list_post_types",
        "test-ext__update_post_type",
      ].sort(),
    );

    const listTool = registry.getRegisteredTool("test-ext__list_post_types")!;
    expect(listTool.entityKind).toBe("list");
    expect(listTool.entityType).toBe("post-type");
  });

  test("hand-rolled tools and auto-tools coexist when names don't collide", async () => {
    const db = getTestDb();
    await db.insert(extensions).values({
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      manifest: {
        schemaVersion: 2,
        name: "test-ext",
        version: "1.0.0",
        description: "test",
        author: { name: "tester" },
        permissions: {},
        entrypoint: "./index.ts",
        tools: [
          {
            name: "hand_rolled_helper",
            description: "x",
            inputSchema: { type: "object" },
          },
        ],
        entities: [
          {
            type: "post-type",
            label: "Post Type",
            pluralLabel: "Post Types",
            schema: { type: "object" },
          },
        ],
      } as never,
      source: "local:/tmp",
      installPath: "/tmp",
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
      checksumVerified: false,
      consecutiveFailures: 0,
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    expect(registry.getRegisteredTool("test-ext__hand_rolled_helper")?.entityKind).toBeUndefined();
    expect(registry.getRegisteredTool("test-ext__create_post_type")?.entityKind).toBe("create");
  });
});
