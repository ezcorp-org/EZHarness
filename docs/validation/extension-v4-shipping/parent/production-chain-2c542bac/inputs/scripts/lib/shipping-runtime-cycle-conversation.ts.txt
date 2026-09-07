import type { SessionRequest } from "./production-lifecycle-client";

type RuntimeCycleConversation = { id: string };

type RuntimeCycleClient = {
  createConversation(input: { title: string }): Promise<RuntimeCycleConversation>;
  wireExtensions(conversationId: string, names: string[]): Promise<{ wired: string[] }>;
  invokeExtensionTool(conversationId: string, extensionName: string, toolName: string, input: { text: string }): Promise<unknown>;
};

type SessionResponse = (path: string, options?: SessionRequest) => Promise<Response>;

async function responseStatus(response: Response): Promise<number> {
  try {
    return response.status;
  } finally {
    await response.body?.cancel();
  }
}

export async function invokeExtensionOnceInFreshConversation(input: {
  client: RuntimeCycleClient;
  sessionResponse: SessionResponse;
  extensionName: string;
  cycle: number;
  marker: string;
  outputText: (output: unknown) => string;
}): Promise<void> {
  const conversation = await input.client.createConversation({ title: `R4 repeat lifecycle ${input.cycle}` });
  let invocationFailure: unknown;
  let invocationFailed = false;
  try {
    const wired = await input.client.wireExtensions(conversation.id, [input.extensionName]);
    if (!wired.wired.includes(input.extensionName)) throw new Error(`Cycle ${input.cycle} extension was not wired to its owned conversation.`);
    const output = input.outputText(await input.client.invokeExtensionTool(conversation.id, input.extensionName, "echo", { text: input.marker }));
    if (output !== `cycle-${input.cycle}:${input.marker}`) throw new Error(`Cycle ${input.cycle} did not produce its real echo output.`);
  } catch (error) {
    invocationFailed = true;
    invocationFailure = error;
  }

  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    const deleted = await input.sessionResponse(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" });
    if (await responseStatus(deleted) !== 204) throw new Error(`Cycle ${input.cycle} conversation delete returned HTTP ${deleted.status}.`);
    const absent = await input.sessionResponse(`/api/conversations/${encodeURIComponent(conversation.id)}`);
    if (await responseStatus(absent) !== 404) throw new Error(`Cycle ${input.cycle} conversation remained reachable after delete: HTTP ${absent.status}.`);
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }

  if (invocationFailed && cleanupFailed) throw new AggregateError([invocationFailure, cleanupFailure], `Cycle ${input.cycle} invocation and conversation cleanup both failed.`);
  if (invocationFailed) throw invocationFailure;
  if (cleanupFailed) throw cleanupFailure;
}
