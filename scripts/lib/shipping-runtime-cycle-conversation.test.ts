import { expect, test } from "bun:test";
import { invokeExtensionOnceInFreshConversation } from "./shipping-runtime-cycle-conversation";

function cycleClient(invoke: (id: string, input: { text: string }) => Promise<unknown> = async (_id, input) => `cycle-1:${input.text}`) {
  let next = 0;
  const conversations = new Set<string>();
  const invocations: string[] = [];
  return {
    conversations,
    invocations,
    client: {
      async createConversation(): Promise<{ id: string }> {
        const id = `conversation-${++next}`;
        conversations.add(id);
        return { id };
      },
      async wireExtensions(id: string, names: string[]) {
        expect(conversations.has(id)).toBe(true);
        return { wired: names };
      },
      async invokeExtensionTool(id: string, name: string, tool: string, input: { text: string }) {
        expect(name).toBe("r4-echo");
        expect(tool).toBe("echo");
        invocations.push(id);
        return invoke(id, input);
      },
    },
  };
}

function cycleInput(client: ReturnType<typeof cycleClient>["client"], sessionResponse: (path: string, options?: { method?: string }) => Promise<Response>, cycle = 1) {
  return { client, sessionResponse, extensionName: "r4-echo", cycle, marker: `marker-${cycle}`, outputText: String };
}

test("R4 uses a distinct real turn boundary and proves each cycle conversation is deleted", async () => {
  const { client, conversations, invocations } = cycleClient(async (_id, input) => `cycle-${invocations.length}:${input.text}`);
  const deletions: string[] = [];
  const reads: string[] = [];
  const sessionResponse = async (path: string, options?: { method?: string }): Promise<Response> => {
    const id = decodeURIComponent(path.split("/").at(-1)!);
    if (options?.method === "DELETE") {
      expect(conversations.delete(id)).toBe(true);
      deletions.push(id);
      return new Response(null, { status: 204 });
    }
    reads.push(id);
    return new Response(null, { status: conversations.has(id) ? 200 : 404 });
  };

  for (let cycle = 1; cycle <= 101; cycle++) await invokeExtensionOnceInFreshConversation(cycleInput(client, sessionResponse, cycle));

  expect(invocations).toHaveLength(101);
  expect(new Set(invocations).size).toBe(101);
  expect(deletions).toEqual(invocations);
  expect(reads).toEqual(invocations);
  expect(conversations.size).toBe(0);
});

test("R4 cleans a conversation after an invoke error", async () => {
  const invokeError = new Error("invoke failed");
  const { client, conversations } = cycleClient(async () => { throw invokeError; });
  const calls: string[] = [];
  const sessionResponse = async (path: string, options?: { method?: string }) => {
    calls.push(`${options?.method ?? "GET"}:${path}`);
    const id = path.split("/").at(-1)!;
    if (options?.method === "DELETE") conversations.delete(id);
    return new Response(null, { status: options?.method === "DELETE" ? 204 : 404 });
  };
  await expect(invokeExtensionOnceInFreshConversation(cycleInput(client, sessionResponse))).rejects.toBe(invokeError);
  expect(calls).toEqual(["DELETE:/api/conversations/conversation-1", "GET:/api/conversations/conversation-1"]);
  expect(conversations.size).toBe(0);
});

test("R4 rejects a delete that leaves a conversation reachable", async () => {
  const { client } = cycleClient();
  const sessionResponse = async (_path: string, options?: { method?: string }) => new Response(null, { status: options?.method === "DELETE" ? 204 : 200 });
  await expect(invokeExtensionOnceInFreshConversation(cycleInput(client, sessionResponse))).rejects.toThrow("remained reachable after delete: HTTP 200");
});

test("R4 rejects a non-204 delete response", async () => {
  const { client } = cycleClient();
  const sessionResponse = async () => new Response(null, { status: 500 });
  await expect(invokeExtensionOnceInFreshConversation(cycleInput(client, sessionResponse))).rejects.toThrow("conversation delete returned HTTP 500");
});

test("R4 retains both invocation and cleanup failures", async () => {
  const invokeError = new Error("invoke failed");
  const cleanupError = new Error("delete transport failed");
  const { client } = cycleClient(async () => { throw invokeError; });
  const sessionResponse = async () => { throw cleanupError; };
  let failure: unknown;
  try {
    await invokeExtensionOnceInFreshConversation(cycleInput(client, sessionResponse));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  const aggregate = failure as AggregateError;
  expect(aggregate.errors).toEqual([invokeError, cleanupError]);
});
