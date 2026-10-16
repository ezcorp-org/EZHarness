/**
 * An `![agent:Name]` mention opens a sub-conversation with that agent, and a
 * message sent in it is answered inside the sub-conversation.
 *
 * Real server, real routes, real PGlite: the request the chat page sends to
 * create the sub-conversation is validated by the server's own schema
 * (web/src/routes/api/conversations/schema.ts). Before W4H-33 the client sent
 * `agentConfigId: ""`, the server answered 400 "Invalid UUID", and the
 * sub-conversation never opened; the handler tests could not see it because
 * they mock `createSubConversation`. An interactive sub-conversation carries no
 * agent config id (the thread renders a block only for such a record).
 *
 * The only test-only step is the deterministic model: both conversations are
 * pinned to a scripted ezcorp-mock model (the isolated harness refuses real
 * providers); the mention, the create, the sub-conversation send and the
 * return all go through the real page and routes.
 */
import { test, expect } from "../fixtures/hydration.js";
import { sendComposerMessage } from "../fixtures/composer.js";

test("an agent mention opens a sub-conversation, and the agent answers inside it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const agentName = `subconvo-agent-${crypto.randomUUID().slice(0, 8)}`;
  const agent = await request.post("/api/agent-configs", {
    data: { name: agentName, prompt: "You answer briefly.", description: "W4H-33 sub-conversation agent" },
  });
  expect(agent.ok()).toBe(true);

  const scriptKey = `subconvo-${crypto.randomUUID()}`;
  const scripted = await request.post("/api/__test/mock-llm/script", {
    data: { scriptKey, turns: Array.from({ length: 8 }, () => ({ text: "Sub answer ready." })) },
  });
  expect(scripted.status(), await scripted.text()).toBe(201);
  const mockModel = { provider: "ezcorp-mock", model: `mock:${scriptKey}` };

  const parent = await request.post("/api/conversations", { data: { projectId: "global", title: "Sub-conversation parent" } });
  expect(parent.status()).toBe(201);
  const { id: parentId } = (await parent.json()) as { id: string };
  const pinnedParent = await request.put(`/api/conversations/${parentId}`, { data: mockModel });
  expect(pinnedParent.status(), await pinnedParent.text()).toBe(200);
  await page.goto(`/project/global/chat/${parentId}`);

  // The page creates the sub-conversation itself once the message is sent.
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/conversations",
  );
  await sendComposerMessage(page, `![agent:${agentName}] look into this`);
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const sub = (await response.json()) as { id: string; parentConversationId: string; agentConfigId: string | null };
  expect(sub.parentConversationId).toBe(parentId);
  expect(sub.agentConfigId ?? null).toBeNull();
  const pinnedSub = await request.put(`/api/conversations/${sub.id}`, { data: mockModel });
  expect(pinnedSub.status(), await pinnedSub.text()).toBe(200);

  const block = page.locator(".sub-convo-block").filter({ has: page.getByTestId("sub-convo-agent-name") });
  await expect(block.getByTestId("sub-convo-agent-name")).toHaveText(`@${agentName}`);

  // One exchange inside the sub-conversation.
  const input = block.locator(".sub-convo-input textarea");
  await input.fill("summarise it");
  await input.press("Enter");
  // The server answers inside the sub-conversation (its own messages).
  await expect.poll(async () => {
    const listed = await request.get(`/api/conversations/${sub.id}/messages`);
    const body = (await listed.json()) as Array<{ role: string; content: string }> | { messages?: Array<{ role: string; content: string }> };
    const messages = Array.isArray(body) ? body : body.messages ?? [];
    return messages.filter((message) => message.role === "assistant").map((message) => message.content);
  }, { timeout: 90_000 }).toContain("Sub answer ready.");
});
