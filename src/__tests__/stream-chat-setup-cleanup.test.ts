import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentEvents } from "../types";

mockDbConnection();
let blockedSetup: {
  entered: Promise<void>;
  signalEntered: () => void;
  released: Promise<void>;
  release: () => void;
  settled: boolean;
} | undefined;
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => {
    const pending = blockedSetup;
    if (pending) {
      pending.signalEntered();
      await pending.released;
      pending.settled = true;
    }
    return [];
  },
}));
mock.module("../providers/router", () => ({
  resolveModel: async () => {
    await blockedSetup?.entered;
    throw new Error("Provider credentials unavailable");
  },
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

test("setup failure settles pending tool loading before the terminal event", async () => {
  let signalEntered = () => {};
  let release = () => {};
  blockedSetup = {
    entered: new Promise<void>(resolve => { signalEntered = resolve; }),
    released: new Promise<void>(resolve => { release = resolve; }),
    signalEntered: () => signalEntered(),
    release: () => release(),
    settled: false,
  };
  const project = await createProject({ name: "Pending setup", path: "/tmp/pending-setup-audit" });
  const conversation = await createConversation(project.id);
  const bus = new EventBus<AgentEvents>();
  const settledAtError: boolean[] = [];
  bus.on("run:error", () => settledAtError.push(blockedSetup?.settled === true));
  const executor = new AgentExecutor(new Map(), bus, { persist: false });
  const running = executor.streamChat(conversation.id, "Hello", { model: "missing", provider: "anthropic" });
  try {
    await blockedSetup.entered;
    // Drain the current turn's promise reactions; no elapsed-time budget.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settledAtError).toEqual([]);
    blockedSetup.release();
    expect((await running).status).toBe("error");
    expect(settledAtError).toEqual([true]);
  } finally {
    blockedSetup.release();
    await running;
    blockedSetup = undefined;
    bus.clear();
  }
});

test("a failed chat setup releases its permission listener and persists one error", async () => {
  const project = await createProject({ name: "Setup cleanup", path: "/tmp/setup-cleanup-audit" });
  const conversation = await createConversation(project.id);
  const bus = new EventBus<AgentEvents>();
  const on = spyOn(bus, "on");
  const off = spyOn(bus, "off");
  const errors: string[] = [];
  bus.on("run:error", ({ error }) => errors.push(error));
  const executor = new AgentExecutor(new Map(), bus, { persist: true });

  try {
    const run = await executor.streamChat(conversation.id, "Hello", { model: "missing", provider: "anthropic" });
    expect(run.status).toBe("error");
    expect(errors).toEqual(["Provider credentials unavailable"]);
    const subscribed = on.mock.calls.filter(([type]) => type === "tool:permission_mode_change");
    expect(subscribed).toHaveLength(1);
    for (const [type, listener] of subscribed) {
      expect(off.mock.calls.some(([removedType, removed]) => removedType === type && removed === listener)).toBe(true);
    }
    expect((await getRunWithLogs(run.id))?.status).toBe("error");
    const messages = await getMessages(conversation.id);
    expect(messages.filter(message => message.role === "assistant" && message.content.includes("Provider credentials unavailable"))).toHaveLength(1);
  } finally {
    on.mockRestore();
    off.mockRestore();
    bus.clear();
  }
});
