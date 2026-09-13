import type { Api, Model } from "@earendil-works/pi-ai";
import type { FactoryRunnerRequest, FactoryRunnerResult, FactoryUsage, JsonValue } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { createFactoryAgentRuntime, type FactoryBroker, type FactoryJournalHooks } from "../../runtime/factory-execution";

export interface NativeFactoryRunnerOptions {
  model(request: FactoryRunnerRequest): Promise<Model<Api>>;
  input(request: FactoryRunnerRequest): Promise<JsonValue>;
  broker(request: FactoryRunnerRequest): FactoryBroker;
  journal(request: FactoryRunnerRequest): FactoryJournalHooks;
  execute(input: { request: FactoryRunnerRequest; value: JsonValue; runtime: ReturnType<typeof createFactoryAgentRuntime> }): Promise<FactoryRunnerResult>;
}

function requireValid(result: { ok: boolean; issues?: readonly { code: string; message: string }[] }, name: string): void {
  if (!result.ok) throw new Error(`${name} is invalid: ${result.issues?.[0]?.code ?? "unknown"}.`);
}

/**
 * The Bun native entrypoint. It accepts only the generated C02 wire request,
 * then gives the shared executor factory transport rather than a host key.
 */
export async function runNativeFactoryRunner(value: unknown, options: NativeFactoryRunnerOptions): Promise<FactoryRunnerResult> {
  requireValid(validateFactoryRunnerRequest(value), "Factory runner request");
  const request = value as FactoryRunnerRequest;
  const [model, input] = await Promise.all([options.model(request), options.input(request)]);
  const runtime = createFactoryAgentRuntime({
    attempt: {
      attemptToken: request.broker.attemptToken,
      runId: request.authority.runId,
      nodeInstanceId: request.authority.nodeInstanceId,
      candidateGeneration: request.authority.candidateGeneration,
      nextOperationIndex: request.authority.nextOperationIndex,
    },
    model,
    broker: options.broker(request),
    journal: options.journal(request),
  });
  const result = await options.execute({ request, value: input, runtime });
  requireValid(validateFactoryRunnerResult(result), "Factory runner result");
  return result;
}

export type { FactoryUsage };
