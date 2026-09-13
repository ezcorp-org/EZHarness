import { createHash } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  AfterToolCallContext,
  BeforeToolCallContext,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { canonicalJson, type JsonValue } from "@ezcorp/extension-contract";

export interface FactoryAttemptIdentity {
  attemptToken: string;
  runId: string;
  nodeInstanceId: string;
  candidateGeneration: number;
  nextOperationIndex: number;
}

export interface FactoryOperation {
  operationId: string;
  operationIndex: number;
  kind: "model" | "tool";
  requestDigest: string;
  /** The durable before-hook persists this before a broker or tool effect. */
  state: "prepared";
}

export interface FactoryOperationResult extends Omit<FactoryOperation, "state"> {
  /** `uncertain` is reserved for the gateway when it loses a remote receipt. */
  state: "completed" | "failed" | "uncertain";
  resultDigest?: string;
}

/** The runner sends this broker request instead of a host provider API key. */
export interface FactoryBrokerRequest {
  attemptToken: string;
  operation: FactoryOperation;
  model: Model<Api>;
  context: Context;
  options: Omit<SimpleStreamOptions, "apiKey">;
}

export interface FactoryBroker {
  stream(request: FactoryBrokerRequest): Promise<AssistantMessageEventStream>;
}

/** Every hook must durably settle before the runner advances the operation. */
export interface FactoryJournalHooks {
  before(operation: FactoryOperation): Promise<void>;
  after(operation: FactoryOperationResult): Promise<void>;
  checkpointWorkspace(operation: FactoryOperationResult): Promise<void>;
}

export interface FactoryExecutionContext {
  attempt: FactoryAttemptIdentity;
  /** The gateway-approved model configuration; never resolve it from host settings. */
  model: Model<Api>;
  broker: FactoryBroker;
  journal: FactoryJournalHooks;
}

export interface FactoryAgentRuntime {
  streamFn: StreamFn;
  beforeToolCall(context: BeforeToolCallContext): Promise<undefined>;
  afterToolCall(context: AfterToolCallContext): Promise<undefined>;
}

/**
 * Fail before a model or tool effect when a factory attempt was only partly
 * wired. Structural typing is not a runtime authority boundary.
 */
export function assertFactoryExecutionContext(value: FactoryExecutionContext): void {
  if (!value?.attempt?.attemptToken || !value.attempt.runId || !value.attempt.nodeInstanceId || !value.model?.id || !value.model.provider || !Number.isSafeInteger(value.attempt.candidateGeneration) || value.attempt.candidateGeneration < 0 || !Number.isSafeInteger(value.attempt.nextOperationIndex) || value.attempt.nextOperationIndex < 0) {
    throw new Error("Factory execution needs a complete attempt identity.");
  }
  if (typeof value.broker?.stream !== "function" || typeof value.journal?.before !== "function" || typeof value.journal?.after !== "function" || typeof value.journal?.checkpointWorkspace !== "function") {
    throw new Error("Factory execution needs a broker and all durable journal hooks.");
  }
}

/**
 * The broker contract is JSON.  Reject values which cannot cross that
 * boundary instead of assigning them a shared placeholder digest.
 */
function transportJson(value: unknown, path = "$"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`Factory broker payload contains a non-finite number at ${path}.`);
  }
  if (Array.isArray(value)) return value.map((entry, index) => transportJson(entry, `${path}[${index}]`));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`Factory broker payload contains a non-JSON value at ${path}.`);
  }
  const result: Record<string, JsonValue> = {};
  // This is the only JSON.stringify-compatible normalization: object fields
  // which are absent on the wire remain absent. Array entries still reject.
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = transportJson(entry, `${path}.${key}`);
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(transportJson(value))).digest("hex");
}

function factoryOperation(
  attempt: FactoryAttemptIdentity,
  operationIndex: number,
  kind: FactoryOperation["kind"],
  request: unknown,
): FactoryOperation {
  return {
    operationId: `${attempt.runId}:${attempt.nodeInstanceId}:${attempt.candidateGeneration}:${operationIndex}`,
    operationIndex,
    kind,
    requestDigest: digest(request),
    state: "prepared",
  };
}

function brokerOptions(options: SimpleStreamOptions | undefined): Omit<SimpleStreamOptions, "apiKey"> {
  const safe: Omit<SimpleStreamOptions, "apiKey"> = {};
  if (options?.toolChoice !== undefined) safe.toolChoice = options.toolChoice;
  if (options?.reasoning !== undefined) safe.reasoning = options.reasoning;
  if (options?.deferred !== undefined) safe.deferred = options.deferred;
  if (options?.thinkingBudgets !== undefined) safe.thinkingBudgets = options.thinkingBudgets;
  return safe;
}

/** Remove host-only tool implementations before a request reaches the broker. */
function brokerContext(context: Context): Context {
  const wire = {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: context.messages,
    ...(context.tools === undefined ? {} : {
      tools: context.tools.map(({ name, description, parameters, constrainedSampling }) => ({
        name,
        description,
        parameters,
        ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
      })),
    }),
  };
  return transportJson(wire) as unknown as Context;
}

function brokerModel(model: Model<Api>): Model<Api> {
  return transportJson(model) as unknown as Model<Api>;
}

function messageResultDigest(message: AssistantMessage): string {
  return digest({ content: message.content, model: message.model, provider: message.provider, stopReason: message.stopReason, usage: message.usage });
}

function errorDigest(error: unknown): string {
  return digest(error instanceof Error ? { name: error.name, message: error.message } : String(error));
}

function journaledStream(
  stream: AssistantMessageEventStream,
  operation: FactoryOperation,
  journal: FactoryJournalHooks,
): AssistantMessageEventStream {
  let settlement: Promise<void> | undefined;
  const settle = async (result: FactoryOperationResult): Promise<void> => {
    settlement ??= journal.after(result);
    await settlement;
  };

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      try {
        for await (const event of stream) yield event;
      } catch (error) {
        await settle({ ...operation, state: "failed", resultDigest: errorDigest(error) });
        throw error;
      }
    },
    async result(): Promise<AssistantMessage> {
      try {
        const message = await stream.result();
        await settle({ ...operation, state: "completed", resultDigest: messageResultDigest(message) });
        return message;
      } catch (error) {
        await settle({ ...operation, state: "failed", resultDigest: errorDigest(error) });
        throw error;
      }
    },
  } as AssistantMessageEventStream;
}

/**
 * Adapt pi-agent-core to a factory broker. It allocates one stable operation
 * ID per model or tool effect and deliberately has no retry loop or key lookup.
 */
export function createFactoryAgentRuntime(execution: FactoryExecutionContext): FactoryAgentRuntime {
  assertFactoryExecutionContext(execution);
  let nextOperationIndex = execution.attempt.nextOperationIndex;
  const toolOperations = new Map<string, FactoryOperation>();
  const allocate = (kind: FactoryOperation["kind"], request: unknown): FactoryOperation => {
    // Reserve a valid successor before touching a durable hook. This keeps a
    // resumed attempt from silently wrapping its stable operation namespace.
    if (!Number.isSafeInteger(nextOperationIndex) || nextOperationIndex < 0 || nextOperationIndex >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Factory attempt operation index is exhausted.");
    }
    const operation = factoryOperation(execution.attempt, nextOperationIndex, kind, request);
    nextOperationIndex += 1;
    return operation;
  };

  return {
    streamFn: async (model, context, options) => {
      if (options?.signal?.aborted) throw new Error("Factory attempt is aborted.");
      if (options?.apiKey) throw new Error("Factory provider transport rejects host API keys.");
      const safeOptions = brokerOptions(options);
      const wireModel = brokerModel(model);
      const wireContext = brokerContext(context);
      const operation = allocate("model", { model: wireModel, context: wireContext, options: safeOptions });
      await execution.journal.before(operation);
      try {
        const stream = await execution.broker.stream({
          attemptToken: execution.attempt.attemptToken,
          operation,
          model: wireModel,
          context: wireContext,
          options: safeOptions,
        });
        return journaledStream(stream, operation, execution.journal);
      } catch (error) {
        await execution.journal.after({ ...operation, state: "failed", resultDigest: errorDigest(error) });
        throw error;
      }
    },
    beforeToolCall: async (context) => {
      const operation = allocate("tool", {
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.args,
      });
      await execution.journal.before(operation);
      toolOperations.set(context.toolCall.id, operation);
      return undefined;
    },
    afterToolCall: async (context) => {
      const operation = toolOperations.get(context.toolCall.id);
      if (!operation) throw new Error("Factory tool result has no prepared journal operation.");
      toolOperations.delete(context.toolCall.id);
      const result: FactoryOperationResult = {
        ...operation,
        state: context.isError ? "failed" : "completed",
        resultDigest: digest({ content: context.result.content, details: context.result.details, isError: context.isError }),
      };
      await execution.journal.after(result);
      await execution.journal.checkpointWorkspace(result);
      return undefined;
    },
  };
}
