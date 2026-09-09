import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sha256 } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { acceptAskUserAnswer } from "../runtime/ask-user-answer";
import { clearPendingAskUser, registerPendingAskUser, _resetPendingAskUserForTests } from "../runtime/ask-user-registry";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { conversations, projects, projectMembers, users } from "../db/schema";
import { getEventReceipt } from "../db/queries/extension-event-receipts";
import { isPersistedDomainEvent } from "../extensions/domain-event-outbox";

mockDbConnection();
beforeEach(async () => { await setupTestDb(); _resetPendingAskUserForTests(); });
afterAll(closeTestDb);

async function fixture() {
  const database = getTestDb();
  const [owner] = await database.insert(users).values({ email: "answer@example.test", passwordHash: "unused", name: "Answer owner", status: "active", role: "member" }).returning();
  const [project] = await database.insert(projects).values({ name: "Question project", path: "/tmp/question-project" }).returning();
  await database.insert(projectMembers).values({ projectId: project!.id, userId: owner!.id, role: "member" });
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id }).returning();
  registerPendingAskUser("question", conversation!.id, owner!.id);
  const bus = new EventBus<AgentEvents>();
  const seen: AgentEvents["ask-user:answer"][] = [];
  bus.on("ask-user:answer", event => { expect(isPersistedDomainEvent(event)).toBe(true); seen.push(event); });
  const identity = { principalId: owner!.id, namespace: "ask-user:answer", key: await sha256("question") };
  return { database, owner: owner!, conversation: conversation!, project: project!, bus, seen, identity };
}

test("answer commits before bus delivery and repeated answers remain one admitted action", async () => {
  const context = await fixture();
  expect(await acceptAskUserAnswer(context.owner.id, "question", "yes", context.bus)).toBe(true);
  const receipt = await getEventReceipt(context.database, context.identity);
  expect(receipt?.scope).toBe(context.conversation.id);
  expect(receipt?.deliveryIds).toEqual([]);
  expect(context.seen).toEqual([{ toolCallId: "question", conversationId: context.conversation.id, answer: "yes" }]);
  clearPendingAskUser("question");
  expect(await acceptAskUserAnswer(context.owner.id, "question", "yes", context.bus)).toBe(false);
  await expect(acceptAskUserAnswer(context.owner.id, "question", "no", context.bus)).rejects.toHaveProperty("code", "event_conflict");
  expect(context.seen).toHaveLength(1);
});

test("unknown collapsed questions remain no-op without inventing durable pending state", async () => {
  const context = await fixture();
  clearPendingAskUser("question");
  expect(await acceptAskUserAnswer(context.owner.id, "question", "yes", context.bus)).toBe(false);
  expect(await getEventReceipt(context.database, context.identity)).toBeNull();
  expect(context.seen).toEqual([]);
});

test("foreign users, changed owners, revoked membership and inactive owners cannot admit answers", async () => {
  const context = await fixture();
  await expect(acceptAskUserAnswer("other", "question", "yes", context.bus)).rejects.toHaveProperty("code", "event_not_found");
  registerPendingAskUser("orphaned-question", context.conversation.id, null);
  await expect(acceptAskUserAnswer(context.owner.id, "orphaned-question", "yes", context.bus)).rejects.toHaveProperty("code", "event_not_found");
  await context.database.delete(projectMembers).where(eq(projectMembers.userId, context.owner.id));
  await expect(acceptAskUserAnswer(context.owner.id, "question", "yes", context.bus)).rejects.toHaveProperty("code", "event_not_found");
  await context.database.insert(projectMembers).values({ projectId: context.project.id, userId: context.owner.id, role: "member" });
  await context.database.update(users).set({ status: "inactive" }).where(eq(users.id, context.owner.id));
  await expect(acceptAskUserAnswer(context.owner.id, "question", "yes", context.bus)).rejects.toHaveProperty("code", "event_not_found");
  await context.database.update(users).set({ status: "active" }).where(eq(users.id, context.owner.id));
  await context.database.update(conversations).set({ userId: null }).where(eq(conversations.id, context.conversation.id));
  await expect(acceptAskUserAnswer(context.owner.id, "question", "yes", context.bus)).rejects.toHaveProperty("code", "event_not_found");
  expect(await getEventReceipt(context.database, context.identity)).toBeNull();
  expect(context.seen).toEqual([]);
});

test("invalid answers cannot create receipts or bus events", async () => {
  const context = await fixture();
  for (const answer of ["", "x".repeat(64 * 1024 + 1)]) await expect(acceptAskUserAnswer(context.owner.id, "question", answer, context.bus)).rejects.toHaveProperty("code", "invalid_answer");
  await expect(acceptAskUserAnswer(context.owner.id, "x".repeat(257), "yes", context.bus)).rejects.toHaveProperty("code", "invalid_answer");
  expect(context.seen).toEqual([]);
});
