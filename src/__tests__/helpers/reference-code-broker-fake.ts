import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, ToolCall } from "@earendil-works/pi-ai";
import type { FactoryBroker, FactoryBrokerRequest } from "../../runtime/factory-execution";

/**
 * A scripted stand-in for the provider, for driving generator and reviewer branches offline.
 *
 * C10 allows mocks for failure injection but never in place of the real provider leg, so this fake
 * exists to reach the paths a real model cannot be asked to produce on demand — a malformed rubric,
 * a transport error, an agent that never stops calling tools. The real provider journey is proven
 * separately, against the configured Anthropic credential.
 */

export interface FakeBrokerTurn {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }>;
  readonly stopReason?: AssistantMessage["stopReason"];
  readonly errorMessage?: string;
  readonly usage?: { readonly input: number; readonly output: number };
}

export interface FakeBroker extends FactoryBroker {
  readonly requests: FactoryBrokerRequest[];
  readonly contexts: Context[];
}

function assistantMessage(turn: FakeBrokerTurn, request: FactoryBrokerRequest): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (turn.text !== undefined) content.push({ type: "text", text: turn.text });
  for (const call of turn.toolCalls ?? []) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments } as ToolCall);
  return {
    role: "assistant",
    content,
    api: "anthropic-messages" as AssistantMessage["api"],
    provider: request.model.provider,
    model: request.model.id,
    usage: {
      input: turn.usage?.input ?? 0,
      output: turn.usage?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (turn.usage?.input ?? 0) + (turn.usage?.output ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as AssistantMessage["usage"],
    stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "toolUse" : "stop"),
    ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }),
    timestamp: 0,
  };
}

/** Answers each call with the next scripted turn, repeating the last one once the script runs out. */
export function fakeReferenceCodeBroker(turns: readonly FakeBrokerTurn[]): FakeBroker {
  const requests: FactoryBrokerRequest[] = [];
  const contexts: Context[] = [];
  let index = 0;
  return {
    requests,
    contexts,
    async stream(request: FactoryBrokerRequest): Promise<AssistantMessageEventStream> {
      requests.push(request);
      contexts.push(request.context);
      const turn = turns[Math.min(index, turns.length - 1)] ?? { text: "" };
      index += 1;
      const message = assistantMessage(turn, request);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.end(message);
      return stream;
    },
  };
}

/** A broker whose transport always fails, for the reviewer's and generator's error paths. */
export function failingReferenceCodeBroker(message: string): FactoryBroker {
  return { async stream(): Promise<AssistantMessageEventStream> { throw new Error(message); } };
}
