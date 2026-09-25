import { defineExtension, type ExtensionContext } from "@ezcorp/sdk/v4";
import { parseInfisicalConnectionConfig } from "./config";
import { createHostInfisicalTransport } from "./host-transport";
import { infisicalManifest } from "./manifest";
import { InfisicalStaticSecretProvider } from "./provider";
import type { InfisicalHttpTransport } from "./transport";

export * from "./config";
export * from "./host-transport";
export * from "./manifest";
export * from "./provider";
export * from "./transport";

export interface InfisicalInvocationRuntime {
  config: ReturnType<typeof parseInfisicalConnectionConfig>;
  transport: InfisicalHttpTransport;
}

export type ResolveInfisicalInvocationRuntime = (
  context: ExtensionContext,
) => InfisicalInvocationRuntime | Promise<InfisicalInvocationRuntime>;

export function createInfisicalExtension(resolveRuntime: ResolveInfisicalInvocationRuntime) {
  const providers = new Map<string, { configJson: string; provider: InfisicalStaticSecretProvider }>();
  return defineExtension({
    manifest: infisicalManifest,
    providerCredentials: async (input, context) => {
      const runtime = await resolveRuntime(context);
      const configJson = JSON.stringify(runtime.config);
      const cached = providers.get(runtime.config.connectionId);
      const provider = cached?.configJson === configJson
        ? cached.provider
        : new InfisicalStaticSecretProvider(runtime.config);
      if (cached?.provider !== provider) {
        if (providers.size >= 32 && !providers.has(runtime.config.connectionId)) {
          throw new Error("Infisical provider connection limit reached");
        }
        providers.set(runtime.config.connectionId, { configJson, provider });
      }
      return provider.resolve(input, runtime.transport);
    },
  });
}

export function createHostInfisicalExtension() {
  return createInfisicalExtension(context => {
    const providerConfig = context.invocation.metadata?.providerConfig;
    return {
      config: parseInfisicalConnectionConfig(providerConfig),
      transport: createHostInfisicalTransport(context),
    };
  });
}
