import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentEvents } from "../types";

mockDbConnection();
// A stalled tool dependency must never start when credentials fail.
const loadExtensions = mock(() => new Promise<string[]>(() => {}));
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: loadExtensions,
}));
mock.module("../providers/router", () => ({
  resolveModel: async () => { throw new Error("Provider credentials unavailable"); },
  ProviderUnavailableError: class extends Error {},
}));

const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createConversation, getMessages } = await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");
const { getRunWithLogs } = await import("../db/queries/runs");

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

test("a failed chat setup does not start uncancellable tool loading and persists one error", async () => {
  const project = await createProject({ name: "Setup cleanup", path: "/tmp/setup-cleanup-audit" });
  const conversation = await createConversation(project.id);
  const bus = new EventBus<AgentEvents>();
  const on = spyOn(bus, "on");
  const errors: string[] = [];
  bus.on("run:error", ({ error }) => errors.push(error));
  const executor = new AgentExecutor(new Map(), bus, { persist: true });

  try {
    const run = await executor.streamChat(conversation.id, "Hello", { model: "missing", provider: "anthropic" });
    expect(run.status).toBe("error");
    expect(errors).toEqual(["Provider credentials unavailable"]);
    const subscribed = on.mock.calls.filter(([type]) => type === "tool:permission_mode_change");
    expect(subscribed).toHaveLength(0);
    expect(loadExtensions).not.toHaveBeenCalled();
    expect((await getRunWithLogs(run.id))?.status).toBe("error");
    const messages = await getMessages(conversation.id);
    expect(messages.filter(message => message.role === "assistant" && message.content.includes("Provider credentials unavailable"))).toHaveLength(1);
  } finally {
    on.mockRestore();
    bus.clear();
  }
});
