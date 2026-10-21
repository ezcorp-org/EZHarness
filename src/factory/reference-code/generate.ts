import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { FactoryBroker, FactoryOperation } from "../../runtime/factory-execution";
import { digestObject } from "../../extensions/v4/blobs";
import { digestBytes } from "../../extensions/v4/digest";
import { REFERENCE_CODE_MAX_WRITE_BYTES, referenceCodePathRefusal, referenceCodeRuleLines, referenceCodeWriteFile } from "./candidate-rules";
import { referenceCodeFilesDigest, type ReferenceCodeFile, type ReferenceCodeSnapshot } from "./snapshot";

/**
 * The native harness agent that writes a candidate.
 *
 * Its whole world is an in-memory copy of the pinned snapshot. There is no filesystem, no network,
 * no shell, and no way to reach the tenant's repository: the three tools below read and write paths
 * in that map and nothing else. A generator that cannot touch anything real is a generator whose
 * output is worth checking, because every effect it can have is a byte in a tree that the freeze
 * and the protected checks then measure.
 *
 * The iteration bound is enforced here, in the runner, because C10 states it about agent
 * iterations and nothing carries `TaskNode.maxIterations` down to a runner today. Reaching it is
 * an ordinary, recorded outcome: the tree produced so far is still frozen and still checked, and a
 * candidate that does not satisfy the contract is rejected by the contract rather than by a
 * generator that decided its own work was good enough.
 *
 * This generator does NOT enforce the request's allowed paths. That is a protected claim, and a
 * generator that quietly refused to write outside them would be certifying its own compliance —
 * exactly the "trusts generator accepted" defect C10 names. It refuses only what no tree can
 * represent: an escaping path, a path git cannot store, an oversized file.
 */

export const REFERENCE_CODE_MAX_AGENT_ITERATIONS = 12;
export { REFERENCE_CODE_MAX_WRITE_BYTES };

export type ReferenceCodeGenerationStop = "model-finished" | "iteration-bound" | "model-error";

export interface ReferenceCodeToolRecord {
  readonly iteration: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly path?: string;
  readonly outcome: "ok" | "refused";
  readonly detail: string;
}

export interface ReferenceCodeGeneration {
  /** The complete candidate tree, snapshot plus whatever the agent changed. */
  readonly files: readonly ReferenceCodeFile[];
  readonly filesDigest: string;
  readonly iterations: number;
  readonly stopReason: ReferenceCodeGenerationStop;
  /** Every tool call the agent made, in order. Auditable without replaying the model. */
  readonly toolCalls: readonly ReferenceCodeToolRecord[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Identity of the exact conversation that produced this tree. */
  readonly transcriptDigest: string;
  readonly model: { readonly provider: string; readonly model: string };
  readonly errorMessage?: string;
}

export interface ReferenceCodeGenerateInput {
  readonly snapshot: ReferenceCodeSnapshot;
  readonly issue: string;
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  /** W06's repairable input. Empty on the first generation. */
  readonly remediation: string;
  readonly candidateGeneration: number;
  readonly broker: FactoryBroker;
  readonly attemptToken: string;
  readonly model: { readonly provider: string; readonly model: string };
  readonly maxIterations?: number;
  readonly operationPrefix?: string;
  readonly signal?: AbortSignal;
}

const READ_FILE: Tool = {
  name: "read_file",
  description: "Reads one file from the candidate tree. Use it before editing a file you have not seen.",
  parameters: Type.Object({ path: Type.String({ description: "Repository-relative path." }) }),
};

const WRITE_FILE: Tool = {
  name: "write_file",
  description: "Replaces one file in the candidate tree with the exact text given. Creates it when absent.",
  parameters: Type.Object({
    path: Type.String({ description: "Repository-relative path." }),
    content: Type.String({ description: "The file's complete new text." }),
  }),
};

const FINISH: Tool = {
  name: "finish",
  description: "Declares the candidate complete. Call it once, after every edit the request needs.",
  parameters: Type.Object({ summary: Type.String({ description: "One sentence on what changed." }) }),
};

export const REFERENCE_CODE_GENERATOR_TOOLS: readonly Tool[] = Object.freeze([READ_FILE, WRITE_FILE, FINISH]);

/**
 * The instructions the agent works under.
 *
 * They state the protected rules rather than enforcing them, on purpose: the agent is told which
 * paths it was approved for and which assets are protected, and the protected checks then decide
 * whether it listened. Telling it the rules improves the first candidate; trusting it to follow
 * them would replace the contract.
 */
export function referenceCodeSystemPrompt(input: {
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly scripts: ReferenceCodeSnapshot["scripts"];
}): string {
  return [
    "You are the EZCorp reference code factory's generator. You edit one small Bun and TypeScript package to satisfy one request.",
    "",
    ...referenceCodeRuleLines(input),
    "- Write complete file contents with write_file. There is no patch tool.",
    "",
    "Read what you need, make the smallest change that satisfies the request, then call finish.",
  ].join("\n");
}

function firstMessage(input: ReferenceCodeGenerateInput): string {
  const listing = input.snapshot.files.map(file => `- ${file.path} (${file.content.byteLength} bytes)`).join("\n");
  const remediation = input.remediation.trim().length === 0
    ? ""
    : `\n\nA previous candidate was rejected. Fix exactly these findings:\n${input.remediation.trim()}`;
  return `Request:\n${input.issue}\n\nThe repository at base commit ${input.snapshot.baseSha} contains:\n${listing}${remediation}`;
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

function toolCallsOf(message: AssistantMessage): readonly ToolCall[] {
  return message.content.filter((entry): entry is ToolCall => entry.type === "toolCall");
}

function textOf(message: AssistantMessage): string {
  return message.content.filter(entry => entry.type === "text").map(entry => (entry as { text: string }).text).join("\n");
}

function argumentsOf(call: ToolCall): Record<string, unknown> {
  const args = (call as { arguments?: unknown }).arguments;
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

/**
 * Applies one tool call to the working tree, or refuses it with a reason the model can act on.
 *
 * A refusal is returned to the agent as an ordinary tool result rather than raised, because a model
 * that asked for an impossible path should correct itself inside its own bounded budget.
 */
function applyToolCall(
  call: ToolCall,
  files: Map<string, ReferenceCodeFile>,
  iteration: number,
): { readonly record: ReferenceCodeToolRecord; readonly text: string; readonly finished: boolean; readonly isError: boolean } {
  const args = argumentsOf(call);
  const name = call.name;
  const refuse = (detail: string, path?: string) => ({
    record: { iteration, toolCallId: call.id, name, path, outcome: "refused" as const, detail },
    text: `Refused: ${detail}`,
    finished: false,
    isError: true,
  });

  if (name === FINISH.name) {
    const summary = typeof args.summary === "string" ? args.summary : "";
    return { record: { iteration, toolCallId: call.id, name, outcome: "ok", detail: summary.slice(0, 512) }, text: "Candidate recorded.", finished: true, isError: false };
  }

  const path = args.path;
  const unstorable = referenceCodePathRefusal(path);
  if (unstorable !== undefined) return refuse(unstorable, typeof path === "string" && path.length > 0 ? path : undefined);

  if (name === READ_FILE.name) {
    const file = files.get(path as string);
    if (!file) return refuse(`'${path as string}' is not in the candidate tree`, path as string);
    return { record: { iteration, toolCallId: call.id, name, path: path as string, outcome: "ok", detail: `${file.content.byteLength} bytes` }, text: decoder.decode(file.content), finished: false, isError: false };
  }

  if (name === WRITE_FILE.name) {
    const written = referenceCodeWriteFile(files, path, args.content);
    if (!written.ok) return refuse(written.detail, path as string);
    return { record: { iteration, toolCallId: call.id, name, path: path as string, outcome: "ok", detail: written.detail }, text: `Wrote ${path as string} (${written.bytes} bytes).`, finished: false, isError: false };
  }

  return refuse(`'${name}' is not a tool this generator offers`);
}

/**
 * Runs the bounded agent loop and returns the tree it produced.
 *
 * The model is reached only through the broker, which holds the credential the runner never sees.
 * Every model call is one journaled C02 operation; the operation id is stable per iteration so a
 * resumed attempt names the same operation rather than opening a new one.
 */
export async function generateReferenceCodeCandidate(input: ReferenceCodeGenerateInput): Promise<ReferenceCodeGeneration> {
  const maxIterations = input.maxIterations ?? REFERENCE_CODE_MAX_AGENT_ITERATIONS;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new TypeError("a generator needs at least one iteration");
  const files = new Map(input.snapshot.files.map(file => [file.path, file]));
  // A fixed timestamp, because the transcript digest must identify the conversation's CONTENT.
  // A wall clock in a message would give the same candidate a different identity on every run.
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: firstMessage(input) }], timestamp: 0 }];
  const systemPrompt = referenceCodeSystemPrompt({ allowedPaths: input.allowedPaths, protectedPaths: input.protectedPaths, scripts: input.snapshot.scripts });
  const toolCalls: ReferenceCodeToolRecord[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let iterations = 0;
  let stopReason: ReferenceCodeGenerationStop = "iteration-bound";
  let errorMessage: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    input.signal?.throwIfAborted();
    iterations = iteration;
    const operation: FactoryOperation = {
      operationId: `${input.operationPrefix ?? "reference-code"}:${input.candidateGeneration}:${iteration}`,
      operationIndex: iteration,
      kind: "model",
      requestDigest: digestObject({ systemPrompt, messages, iteration }),
      state: "prepared",
    };
    const stream = await input.broker.stream({
      attemptToken: input.attemptToken,
      operation,
      model: { id: input.model.model, provider: input.model.provider } as never,
      context: { systemPrompt, messages, tools: [...REFERENCE_CODE_GENERATOR_TOOLS] },
      options: {},
    });
    const message = await stream.result();
    inputTokens += message.usage?.input ?? 0;
    outputTokens += message.usage?.output ?? 0;
    messages.push(message);

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stopReason = "model-error";
      errorMessage = message.errorMessage ?? message.stopReason;
      break;
    }

    const calls = toolCallsOf(message);
    if (calls.length === 0) {
      stopReason = "model-finished";
      break;
    }

    let finished = false;
    for (const call of calls) {
      const applied = applyToolCall(call, files, iteration);
      toolCalls.push(applied.record);
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: applied.text }], isError: applied.isError, timestamp: 0 });
      finished ||= applied.finished;
    }
    if (finished) { stopReason = "model-finished"; break; }
  }

  const produced = [...files.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    files: produced,
    filesDigest: referenceCodeFilesDigest(produced),
    iterations,
    stopReason,
    toolCalls,
    usage: { inputTokens, outputTokens },
    transcriptDigest: `sha256:${digestBytes(encoder.encode(JSON.stringify(messages.map(entry => (entry.role === "assistant" ? { role: entry.role, text: textOf(entry), calls: toolCallsOf(entry).map(call => ({ name: call.name, arguments: argumentsOf(call) })) } : entry)))))}`,
    model: input.model,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}
