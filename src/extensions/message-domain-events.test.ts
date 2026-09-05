import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { createMessage } from "../db/queries/conversations";
import { messages, toolCalls } from "../db/schema";
import { domainEventSourceFixture, fillDomainEventQueue } from "../__tests__/helpers/domain-event-source";
import { handleAppendMessageRpc } from "./append-message-handler";
import { ExtensionDeliveryQueue } from "./v4/deliveries";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { isPersistedDomainEvent } from "./domain-event-outbox";
import { backfillSessionForConversation } from "../db/session-backfill";
import { rewindSession } from "../db/session-sync";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const { database, owner, conversation, installationId, grantedPermissions } = await domainEventSourceFixture(["run:turn_saved", "conversation:tree-changed"]);
  const parent = await createMessage(conversation!.id, { role: "user", content: "Parent" });
  const context = { conversationId: conversation!.id, userId: owner!.id, grantedPermissions };
  const append = (bus?: EventBus<AgentEvents>) => handleAppendMessageRpc(installationId, { jsonrpc: "2.0", id: "append", method: "ezcorp/append-message", params: { parentMessageId: parent.id, role: "extension", content: "Saved extension result", toolCalls: [{ name: "probe", input: {}, output: { text: "result" }, status: "complete" }] } }, { ...context, bus });
  return { database, installationId, conversation: conversation!, parent, append, queue: new ExtensionDeliveryQueue(database) };
}

test("an extension append queues its saved-turn delivery without an in-memory bus", async () => {
  const context = await fixture();
  const response = await context.append();
  expect(response).toHaveProperty("result.messageId");
  const messageId = (response.result as { messageId: string }).messageId;
  expect((await context.database.select().from(messages).where(eq(messages.id, messageId)))[0]).toMatchObject({ role: "extension", excluded: true, parentMessageId: context.parent.id });
  const recovered = new ExtensionDeliveryQueue(context.database);
  const delivered = await recovered.dispatch(async delivery => {
    expect(delivery.input).toMatchObject({ method: "ezcorp/event/run:turn_saved", params: { messageId, content: "Saved extension result", final: true } });
  });
  expect(delivered?.state).toBe("delivered");
  expect(await recovered.claim()).toBeNull();
});

test("full durable delivery queue rolls back the message and anchored tool rows", async () => {
  const context = await fixture();
  await fillDomainEventQueue(context);
  await expect(context.append()).rejects.toMatchObject({ code: "event_queue_full" });
  expect((await context.database.select().from(messages).where(eq(messages.conversationId, context.conversation.id))).map(row => row.id)).toEqual([context.parent.id]);
  expect(await context.database.select().from(toolCalls).where(eq(toolCalls.conversationId, context.conversation.id))).toEqual([]);
});

test("postcommit bus failure cannot remove the stored turn or its delivery", async () => {
  const context = await fixture();
  const bus = new EventBus<AgentEvents>();
  const emit = spyOn(bus, "emit").mockImplementation((_type, payload) => {
    expect(isPersistedDomainEvent(payload)).toBe(true);
    throw new Error("process lost before UI delivery");
  });
  try {
    await expect(context.append(bus)).rejects.toThrow("process lost");
    expect((await context.queue.dispatch(async delivery => {
      const messageId = (delivery.input as { params: { messageId: string } }).params.messageId;
      expect((await context.database.select().from(messages).where(eq(messages.id, messageId)))[0]?.content).toBe("Saved extension result");
    }))?.state).toBe("delivered");
    expect(await context.queue.claim()).toBeNull();
  } finally { emit.mockRestore(); }
});

test("rewind commits its leaf and summary with one recoverable tree event", async () => {
  const context = await fixture();
  await createMessage(context.conversation.id, { role: "assistant", content: "Branch answer", parentMessageId: context.parent.id });
  await backfillSessionForConversation(context.conversation.id);
  const result = await rewindSession(context.conversation.id, context.parent.id, "Try another branch");
  expect(result.ok).toBe(true);
  expect(await (await backfillSessionForConversation(context.conversation.id)).getLeafId()).toBe(context.parent.id);
  expect((await context.queue.dispatch(async delivery => {
    expect(delivery.input).toMatchObject({ method: "ezcorp/event/conversation:tree-changed", params: { currentLeaf: context.parent.id } });
  }))?.state).toBe("delivered");
  expect(await context.queue.claim()).toBeNull();
});

test("rewind backpressure rolls back both its summary and new leaf", async () => {
  const context = await fixture();
  const answer = await createMessage(context.conversation.id, { role: "assistant", content: "Branch answer", parentMessageId: context.parent.id });
  const before = await backfillSessionForConversation(context.conversation.id);
  const entries = await before.getEntries();
  await fillDomainEventQueue(context);
  await expect(rewindSession(context.conversation.id, context.parent.id, "Must not commit")).rejects.toMatchObject({ code: "event_queue_full" });
  const recovered = await backfillSessionForConversation(context.conversation.id);
  expect(await recovered.getLeafId()).toBe(answer.id);
  expect(await recovered.getEntries()).toEqual(entries);
});
