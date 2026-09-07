import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupPiAiMocks } from "./helpers/mock-pi-ai";

// Set up pi-ai mocks BEFORE any imports that trigger executor module loading
setupPiAiMocks({ textChunks: ["Hello", " world"] });

import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let bus: EventBus<AgentEvents>;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
  const project = await createProject({ name: "Tools Integration", path: "/tmp/tools-int" });
  projectId = project.id;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

async function createConvAndSend(title: string, content: string) {
  const createRes = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, title }),
  });
  const conv = (await createRes.json()) as any;
  const msgRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(msgRes.status).toBe(200);
  return conv;
}

const WAIT_TIMEOUT_MS = 4_000;

function abortError(description: string): Error {
  return new Error(`Stopped waiting for ${description}`);
}

function waitForBusEvent<K extends keyof AgentEvents & string>(
  event: K,
  signal: AbortSignal,
): Promise<AgentEvents[K]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${event}`))), WAIT_TIMEOUT_MS);
    const onAbort = () => finish(() => reject(abortError(event)));
    const off = bus.on(event, (data) => finish(() => resolve(data)));
    const finish = (settle: () => void) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      off();
      settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForTurnSummary(conversationId: string, signal: AbortSignal) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastEvents: Array<{ eventType: string; data: Pick<AgentEvents["obs:turn"], "tokenUsage"> }> = [];
  while (!signal.aborted && Date.now() < deadline) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    const res = await fetch(`${baseUrl}/api/observability/conversations/${conversationId}`, { signal: requestSignal });
    expect(res.status).toBe(200);
    lastEvents = await res.json() as typeof lastEvents;
    const turnSummary = lastEvents.find((event) => event.eventType === "turn_summary");
    if (turnSummary) return turnSummary;
    await Bun.sleep(10);
  }
  if (signal.aborted) throw abortError("the persisted turn summary");
  throw new Error(`Timed out waiting for the persisted turn summary; observed ${lastEvents.length} event(s).`);
}

describe("Chat observability integration", () => {
  test("obs:turn event is emitted during chat", async () => {
    const abort = new AbortController();
    try {
      const turn = waitForBusEvent("obs:turn", abort.signal);
      const [conv, turnEvent] = await Promise.all([
        createConvAndSend("Obs Turn Test", "hello obs"),
        turn,
      ]);
      expect(turnEvent.conversationId).toBe(conv.id);
      expect(turnEvent.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(turnEvent.tokenUsage).toEqual({ input: 10, output: 5 });
    } finally {
      abort.abort();
    }
  });

  test("run:usage event fires with correct token counts", async () => {
    const abort = new AbortController();
    try {
      const usageReady = waitForBusEvent("run:usage", abort.signal);
      const [, usageEvent] = await Promise.all([
        createConvAndSend("Usage Event Test", "check usage"),
        usageReady,
      ]);
      const usage = usageEvent.usage;
      // Usage from pi-ai format
      expect(usage.input).toBe(10);
      expect(usage.output).toBe(5);
    } finally {
      abort.abort();
    }
  });

  test("observability events are persisted and queryable via API", async () => {
    const abort = new AbortController();
    try {
      const conv = await createConvAndSend("Obs Persist Test", "persist check");
      const turnSummary = await waitForTurnSummary(conv.id, abort.signal);
      expect(turnSummary.data.tokenUsage.input).toBe(10);
      expect(turnSummary.data.tokenUsage.output).toBe(5);
    } finally {
      abort.abort();
    }
  });
});
