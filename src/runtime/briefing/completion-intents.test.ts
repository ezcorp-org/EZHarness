import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { domainEventSourceFixture } from "../../__tests__/helpers/domain-event-source";
import { createMessage } from "../../db/queries/conversations";
import { conversations, runs, runDomainEventIntents, users, conversationExtensions } from "../../db/schema";
import { up } from "../../db/migrations/add-run-domain-event-intents";
import { briefingCompletionEvents, registerBriefingCompletionIntent, consumeRunCompletionIntent, recoverRunCompletionIntents } from "./completion-intents";
import { runBriefingForUser } from "./run";
import { upsertBriefingConfig } from "../../db/queries/briefing-configs";
import { insertRun, updateRun } from "../../db/queries/runs";
import { EventBus } from "../events";
import type { AgentEvents, AgentRun } from "../../types";
import type { BriefingExecutor } from "./runtime-registry";
import { isPersistedDomainEvent } from "../../extensions/domain-event-outbox";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const context = await domainEventSourceFixture(["conversation:created", "briefing:delivered"]);
  const intent = { runId: crypto.randomUUID(), conversationId: context.conversation.id, userId: context.owner.id, projectId: context.project.id };
  return { ...context, intent };
}

test("migration is idempotent and registration is host-bound, bounded, and immutable", async () => {
  const context = await fixture();
  await up(context.database);
  await up(context.database);
  await expect(registerBriefingCompletionIntent({ ...context.intent, runId: "../forged" })).rejects.toMatchObject({ code: "invalid_event" });
  await expect(registerBriefingCompletionIntent({ ...context.intent, runId: undefined } as unknown as Parameters<typeof registerBriefingCompletionIntent>[0])).rejects.toMatchObject({ code: "invalid_event" });
  await expect(registerBriefingCompletionIntent({ ...context.intent, userId: "foreign" })).rejects.toMatchObject({ code: "invalid_event" });
  await registerBriefingCompletionIntent(context.intent);
  await registerBriefingCompletionIntent(context.intent);
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(1);
  const second = await fixture();
  await expect(registerBriefingCompletionIntent({ ...second.intent, runId: context.intent.runId })).rejects.toMatchObject({ code: "invalid_event" });
  await context.database.execute(sql`INSERT INTO run_domain_event_intents(run_id,conversation_id,user_id,project_id) SELECT 'capacity-' || generate_series, ${context.conversation.id}, ${context.owner.id}, ${context.project.id} FROM generate_series(1,127)`);
  await expect(registerBriefingCompletionIntent({ ...context.intent, runId: "overflow" })).rejects.toMatchObject({ code: "event_queue_full" });
  expect(briefingCompletionEvents(context.intent).map(event => event.id)).toEqual([`${context.intent.runId}:created`, `${context.intent.runId}:delivered`]);
});

test("success consumes only its exact conversation intent and commits both deliveries once", async () => {
  const context = await fixture();
  await registerBriefingCompletionIntent(context.intent);
  await createMessage(context.conversation.id, { role: "assistant", content: "Daily briefing" });
  await expect(context.database.transaction(transaction => consumeRunCompletionIntent(transaction, { runId: context.intent.runId, status: "success", conversationId: "foreign" }))).rejects.toMatchObject({ code: "invalid_event" });
  await context.database.transaction(transaction => consumeRunCompletionIntent(transaction, { ...context.intent, status: "running" }));
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(1);
  await expect(context.database.transaction(async transaction => {
    await consumeRunCompletionIntent(transaction, { ...context.intent, status: "success" });
    throw new Error("crash before commit");
  })).rejects.toThrow("crash before commit");
  expect(await context.queue.claim()).toBeNull();
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(1);
  await context.database.transaction(transaction => consumeRunCompletionIntent(transaction, { ...context.intent, status: "success" }));
  await context.database.transaction(transaction => consumeRunCompletionIntent(transaction, { ...context.intent, status: "success" }));
  const observed: string[] = [];
  while (await context.queue.dispatch(async delivery => { observed.push((delivery.input as { method: string }).method); })) {}
  expect(observed.sort()).toEqual(["ezcorp/event/briefing:delivered", "ezcorp/event/conversation:created"]);
  expect(await context.database.select().from(runDomainEventIntents)).toEqual([]);
});

for (const reason of ["error", "cancelled", "empty", "owner-changed", "owner-inactive"] as const) test(`briefing ${reason} clears its intent without a delivery`, async () => {
  const context = await fixture();
  await registerBriefingCompletionIntent(context.intent);
  await createMessage(context.conversation.id, { role: "assistant", content: reason === "empty" ? " \n\t" : "Daily briefing" });
  if (reason === "owner-changed") await context.database.update(conversations).set({ userId: null }).where(eq(conversations.id, context.conversation.id));
  if (reason === "owner-inactive") await context.database.update(users).set({ status: "inactive" }).where(eq(users.id, context.owner.id));
  await context.database.transaction(transaction => consumeRunCompletionIntent(transaction, { ...context.intent, status: reason === "error" || reason === "cancelled" ? reason : "success" }));
  expect(await context.queue.claim()).toBeNull();
  expect(await context.database.select().from(runDomainEventIntents)).toEqual([]);
});

test("recovery replays terminal intents and expires pre-run orphans, but retains live and recent work", async () => {
  const context = await fixture();
  await registerBriefingCompletionIntent(context.intent);
  await context.database.insert(runs).values({ id: context.intent.runId, conversationId: context.conversation.id, agentName: "briefing", status: "success", startedAt: new Date() });
  await createMessage(context.conversation.id, { role: "assistant", content: "Recovered briefing" });
  await registerBriefingCompletionIntent({ ...context.intent, runId: "orphan" });
  await context.database.update(runDomainEventIntents).set({ createdAt: new Date(0) }).where(eq(runDomainEventIntents.runId, "orphan"));
  await registerBriefingCompletionIntent({ ...context.intent, runId: "recent" });
  await registerBriefingCompletionIntent({ ...context.intent, runId: "running" });
  await context.database.insert(runs).values({ id: "running", conversationId: context.conversation.id, agentName: "briefing", status: "running", startedAt: new Date() });
  expect(await recoverRunCompletionIntents()).toBe(2);
  expect((await context.database.select().from(runDomainEventIntents)).map(row => row.runId).sort()).toEqual(["recent", "running"]);
  expect(await recoverRunCompletionIntents()).toBe(0);
  expect((await context.queue.dispatch(async () => {}))?.state).toBe("delivered");
  expect((await context.queue.dispatch(async () => {}))?.state).toBe("delivered");
});

test("real briefing pipeline registers before execution and terminal commit owns both events before UI delivery", async () => {
  const context = await fixture();
  const config = await upsertBriefingConfig(context.owner.id, { enabled: true, projectId: context.project.id });
  const bus = new EventBus<AgentEvents>();
  const emitted: object[] = [];
  bus.on("conversation:created", payload => emitted.push(payload));
  bus.on("briefing:delivered", payload => emitted.push(payload));
  const executor: BriefingExecutor = {
    cancelRun: () => true,
    async streamChat(conversationId, _message, options = {}) {
      expect((await context.database.select().from(runDomainEventIntents))[0]).toMatchObject({ runId: options.runId, conversationId, userId: context.owner.id });
      await context.database.insert(conversationExtensions).values({ conversationId, extensionId: context.installationId });
      const run: AgentRun = { id: options.runId!, agentName: "briefing", status: "running", startedAt: Date.now(), logs: [] };
      await insertRun(run, context.project.id, undefined, conversationId, context.owner.id);
      await createMessage(conversationId, { role: "assistant", content: "Durable daily briefing", runId: run.id });
      const completed: AgentRun = { ...run, status: "success", finishedAt: Date.now() };
      await updateRun(completed);
      expect(await context.database.select().from(runDomainEventIntents)).toEqual([]);
      expect(emitted).toEqual([]);
      return completed;
    },
  };
  const result = await runBriefingForUser(config, {}, { executor, bus });
  expect(result.status).toBe("ok");
  expect(emitted).toHaveLength(2);
  expect(emitted.every(isPersistedDomainEvent)).toBe(true);
  const methods: string[] = [];
  while (await context.queue.dispatch(async delivery => { methods.push((delivery.input as { method: string }).method); })) {}
  expect(methods.sort()).toEqual(["ezcorp/event/briefing:delivered", "ezcorp/event/conversation:created"]);
});
