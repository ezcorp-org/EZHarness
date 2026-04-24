/**
 * Thin wrapper around pi-ai stream()/complete() with credential resolution.
 * Replaces ~500 lines of hand-rolled HTTP/SSE code with pi-ai calls.
 */

import {
  stream,
  complete,
  type Api,
  type Model,
  type Context,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { getCredential } from "./credentials";

// Re-export for downstream usage
export type { AssistantMessageEventStream };
export { getApiKey } from "./credentials";

export async function streamLLM(
  model: Model<Api>,
  context: Context,
  opts?: { signal?: AbortSignal; conversationId?: string },
): Promise<AssistantMessageEventStream> {
  const cred = await getCredential(model.provider, opts?.conversationId);
  return stream(model, context, {
    apiKey: cred.token,
    signal: opts?.signal,
  });
}

export async function completeLLM(
  model: Model<Api>,
  context: Context,
  opts?: { conversationId?: string },
): Promise<AssistantMessage> {
  const cred = await getCredential(model.provider, opts?.conversationId);
  return complete(model, context, { apiKey: cred.token });
}
