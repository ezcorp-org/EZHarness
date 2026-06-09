/**
 * Phase 4 (D) — conversations.extensionTools query round-trip.
 *
 * Verifies createConversation persists an extensionTools map, updateConversation
 * sets / clears it (null = inherit), and the column round-trips through the DB.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createConversation,
  updateConversation,
  getConversation,
} from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Conv ExtTools", path: "/tmp/conv-ext-tools" });
  projectId = project.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("conversations.extensionTools", () => {
  test("defaults to null when not supplied at create", async () => {
    const conv = await createConversation(projectId);
    expect(conv.extensionTools).toBeNull();
  });

  test("createConversation persists an extensionTools map", async () => {
    const conv = await createConversation(projectId, {
      extensionTools: { "ext-1": ["alpha", "beta"] },
    });
    expect(conv.extensionTools).toEqual({ "ext-1": ["alpha", "beta"] });
    const roundtrip = await getConversation(conv.id);
    expect(roundtrip?.extensionTools).toEqual({ "ext-1": ["alpha", "beta"] });
  });

  test("updateConversation sets the map on an existing row", async () => {
    const conv = await createConversation(projectId);
    const updated = await updateConversation(conv.id, {
      extensionTools: { "ext-2": ["only"] },
    });
    expect(updated?.extensionTools).toEqual({ "ext-2": ["only"] });
    const roundtrip = await getConversation(conv.id);
    expect(roundtrip?.extensionTools).toEqual({ "ext-2": ["only"] });
  });

  test("updateConversation with null clears the override (inherit)", async () => {
    const conv = await createConversation(projectId, {
      extensionTools: { "ext-3": ["x"] },
    });
    const cleared = await updateConversation(conv.id, { extensionTools: null });
    expect(cleared?.extensionTools).toBeNull();
    const roundtrip = await getConversation(conv.id);
    expect(roundtrip?.extensionTools).toBeNull();
  });

  test("updateConversation without extensionTools leaves it untouched", async () => {
    const conv = await createConversation(projectId, {
      extensionTools: { "ext-4": ["keep"] },
    });
    const updated = await updateConversation(conv.id, { title: "renamed" });
    expect(updated?.title).toBe("renamed");
    // The map is preserved (not nulled) when the key is absent from the patch.
    expect(updated?.extensionTools).toEqual({ "ext-4": ["keep"] });
  });
});
