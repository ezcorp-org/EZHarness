import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { FactoryBroker, FactoryBrokerRequest } from "../../runtime/factory-execution";

/**
 * A provider double that replays a RECORDED transcript, and says so.
 *
 * It exists because the rest of the path — a sandboxed guest, the frame, the
 * one broker seam, the stream-to-one-hop adapter and the durable journal write
 * — can only be proved end to end against something that answers. It is not
 * evidence that a provider answered, and `label` is carried through so a
 * reader of the evidence cannot mistake it for one.
 *
 * It never invents a turn. A request it has no recording for is an error, so a
 * test that drifted off the transcript fails instead of quietly passing against
 * an answer nobody recorded.
 */

export interface FactoryRecordedTurn {
  readonly name: string;
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly message: AssistantMessage;
}

export interface FactoryRecordedTranscript {
  readonly label: "fixture";
  readonly isLiveProvider: false;
  readonly note: string;
  readonly recordedFor: string;
  readonly pin: { readonly provider: string; readonly model: string };
  readonly turns: readonly FactoryRecordedTurn[];
}

export async function loadFactoryRecordedTranscript(directory: string, name = "guest-model-transcript.json"): Promise<FactoryRecordedTranscript> {
  const transcript = JSON.parse(await readFile(join(directory, name), "utf8")) as FactoryRecordedTranscript;
  if (transcript.label !== "fixture" || transcript.isLiveProvider !== false) throw new Error("A recorded transcript must declare itself a fixture.");
  if (!transcript.turns.length) throw new Error("A recorded transcript with no turns can prove nothing.");
  return transcript;
}

/** The key a turn is found by: exactly the conversation that was recorded. */
function key(messages: readonly { readonly role: string; readonly text: string }[]): string {
  return canonicalJson(messages.map(message => ({ role: message.role, text: message.text })));
}

/** Rebuilds the guest-visible turns from what the adapter put on the wire. */
function asked(context: Context): { role: string; text: string }[] {
  const system = context.systemPrompt === undefined ? [] : [{ role: "system", text: context.systemPrompt }];
  const turns = context.messages.map(message => ({
    role: message.role,
    text: (message as { content?: unknown }).content instanceof Array
      ? ((message as { content: { type: string; text?: string }[] }).content.filter(part => part.type === "text").map(part => part.text ?? "").join(""))
      : String((message as { content?: unknown }).content ?? ""),
  }));
  return [...system, ...turns];
}

export interface FactoryTranscriptBroker extends FactoryBroker {
  /** Every turn replayed, in order, so a test can assert what was asked. */
  readonly replayed: readonly string[];
}

export function createFactoryTranscriptBroker(transcript: FactoryRecordedTranscript): FactoryTranscriptBroker {
  const byConversation = new Map(transcript.turns.map(turn => [key(turn.messages), turn]));
  const replayed: string[] = [];
  return Object.freeze({
    replayed,
    async stream(request: FactoryBrokerRequest) {
      if (request.model.provider !== transcript.pin.provider || request.model.id !== transcript.pin.model) {
        throw new Error(`The recorded transcript is for ${transcript.pin.provider}/${transcript.pin.model}, not ${request.model.provider}/${request.model.id}.`);
      }
      const turn = byConversation.get(key(asked(request.context)));
      if (!turn) throw new Error("No recorded turn matches this conversation; a double must never invent one.");
      replayed.push(turn.name);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: turn.message });
      stream.end(turn.message);
      return stream;
    },
  });
}

/** The pinned model object, built from the pin rather than a provider registry. */
export function factoryTranscriptModel(pin: { readonly provider: string; readonly model: string }): Model<Api> {
  return { id: pin.model, provider: pin.provider, api: "anthropic-messages" } as unknown as Model<Api>;
}
