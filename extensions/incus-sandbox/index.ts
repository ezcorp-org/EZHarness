import {
  ContractError,
  SANDBOX_PROVIDER_OPERATIONS,
  type ExtensionContext,
  type SandboxProtocolOperation,
  validateSandboxProviderMethodExchange,
} from "@ezcorp/sdk/v4";
import { defineExtension, type MethodHandler } from "@ezcorp/sdk/v4";
import { describeIncusProvider, IncusSandboxAdapter } from "./adapter";
import { parseIncusConnectionConfig, type IncusConnectionConfig } from "./config";
import { createHostIncusTransport } from "./host-transport";
import { incusManifest, incusMethodName } from "./manifest";
import type { IncusTransport } from "./transport";

export * from "./adapter";
export * from "./config";
export * from "./host-transport";
export * from "./manifest";
export * from "./transport";

export interface IncusInvocationRuntime {
  config: IncusConnectionConfig;
  transport: IncusTransport;
}

export type ResolveIncusInvocationRuntime = (
  context: ExtensionContext,
) => IncusInvocationRuntime | Promise<IncusInvocationRuntime>;

export function resolveHostIncusInvocationRuntime(context: ExtensionContext): IncusInvocationRuntime {
  const providerConfig = context.invocation.metadata?.providerConfig;
  if (providerConfig === undefined) {
    throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus connection configuration is unavailable");
  }
  return {
    config: parseIncusConnectionConfig(providerConfig),
    transport: createHostIncusTransport(context),
  };
}

export function createIncusExtension(resolveRuntime: ResolveIncusInvocationRuntime) {
  const methods: Record<string, MethodHandler> = {};
  for (const operation of SANDBOX_PROVIDER_OPERATIONS) {
    const declaration = incusManifest.methods!.find(
      (method) => method.name === incusMethodName(operation),
    )!;
    methods[declaration.name] = {
      inputSchema: declaration.inputSchema,
      outputSchema: declaration.outputSchema,
      handle: async (input: unknown, context: ExtensionContext) => {
        if (operation === "describe") {
          return validateSandboxProviderMethodExchange("describe", input, describeIncusProvider()).result;
        }
        const runtime = await resolveRuntime(context);
        return new IncusSandboxAdapter(runtime.config, runtime.transport).invoke(
          operation as SandboxProtocolOperation,
          input,
        );
      },
    };
  }
  return defineExtension({ manifest: incusManifest, methods });
}
