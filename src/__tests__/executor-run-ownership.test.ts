/**
 * Run ownership attributes that /api/runs/[id] enforces per user
 * (`AgentExecutor.getRunOwnership` / `getRunConversationId`). An
 * unattributable run must report nulls so the route denies non-admins.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { createUser } from "../db/queries/users";
import type { AgentEvents } from "../types";

const agents = () => loadAgentsStatic([
  { name: "quick", description: "quick agent", capabilities: [], execute: async () => ({ success: true, output: "ok" }) },
]);

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  userId = (await createUser({ email: "run-owner@example.com", passwordHash: "h", name: "Owner", role: "member", status: "active" })).id;
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("AgentExecutor run ownership", () => {
  test("a persisted agent run reports its initiating user and no conversation", async () => {
    const exec = new AgentExecutor(agents(), new EventBus<AgentEvents>(), { persist: true });
    const run = await exec.runAgent("quick", {}, undefined, userId);

    expect(await exec.getRunOwnership(run.id)).toEqual({ userId, conversationId: null });
    expect(await exec.getRunConversationId(run.id)).toBeUndefined();
  });

  test("an unknown run is unattributable (both null), so the route fails closed", async () => {
    const exec = new AgentExecutor(agents(), new EventBus<AgentEvents>(), { persist: true });
    expect(await exec.getRunOwnership("no-such-run")).toEqual({ userId: null, conversationId: null });
    expect(await exec.getRunConversationId("no-such-run")).toBeUndefined();
  });

  test("without persistence there is no user to attribute", async () => {
    const exec = new AgentExecutor(agents(), new EventBus<AgentEvents>());
    const run = await exec.runAgent("quick", {}, undefined, userId);

    expect(await exec.getRunOwnership(run.id)).toEqual({ userId: null, conversationId: null });
    expect(await exec.getRunConversationId(run.id)).toBeUndefined();
  });

  test("a conversation with no waiting permission prompts reports none", () => {
    const exec = new AgentExecutor(agents(), new EventBus<AgentEvents>());
    expect(exec.getPendingPermissions("conv-1")).toEqual([]);
  });
});
