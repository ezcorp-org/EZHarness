import { ContractError, TOOL_RESULT_SCHEMA, assertJson, validateManifest } from "@ezcorp/extension-contract";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { installInvocationChannel } from "../runtime/channel";
import type { HostChannel } from "../runtime/channel";
import { defineExtension } from "./index";
import type { DefinedExtension, ExtensionHandler, MethodHandler } from "./index";
import { getInvocationChannel } from "./invocation-channel";

export { TOOL_RESULT_SCHEMA };

export function unwrapToolResponse(response: unknown): unknown {
  assertJson(response);
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new ContractError("INVALID_RESPONSE", "Expected tool response");
  if ("error" in response) throw new ContractError("HANDLER_FAILED", "Tool request failed");
  if (!("result" in response)) throw new ContractError("INVALID_RESPONSE", "Tool response has no result");
  return response.result;
}

export function defineRuntimeManifest<Metadata>(metadata: Metadata): Metadata & ExtensionManifestV4 {
  assertJson(metadata);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new ContractError("INVALID_MANIFEST", "Manifest must be an object");
  const tools = (metadata as Record<string, unknown>).tools;
  if (tools !== undefined && !Array.isArray(tools)) throw new ContractError("INVALID_MANIFEST", "Tools must be an array");
  const manifest = { ...metadata, ...(tools ? { tools: tools.map(tool => ({ ...tool, outputSchema: tool.outputSchema ?? TOOL_RESULT_SCHEMA })) } : {}) };
  return validateManifest(manifest) as Metadata & ExtensionManifestV4;
}

export async function createRuntimeExtension(options: { manifest: unknown; register: () => unknown | Promise<unknown> }): Promise<DefinedExtension> {
  const manifest = defineRuntimeManifest(options.manifest);
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  let registering = true;
  function current(): HostChannel {
    const invocation = getInvocationChannel();
    if (!invocation) throw new ContractError("NO_INVOCATION", "Host capabilities require an active invocation");
    return invocation;
  }
  const channel: HostChannel = {
    request: async <Result>(method: string, params: unknown): Promise<Result> => {
      return current().request<Result>(method, params);
    },
    notify: (method, params) => {
      current().notify(method, params);
    },
    onRequest: (method, handler) => {
      if (!registering) throw new ContractError("REGISTRATION_CLOSED", "Handlers must be registered before serving");
      if (handlers.has(method)) throw new ContractError("DUPLICATE_HANDLER", `Handler already registered: ${method}`);
      handlers.set(method, handler);
    },
    start: () => {},
    stop: () => {},
  };
  const restore = installInvocationChannel(channel);
  try {
    await options.register();
    registering = false;
    const tools: Record<string, ExtensionHandler> = {};
    for (const tool of manifest.tools ?? []) {
      const handler = handlers.get("tools/call");
      if (!handler) throw new ContractError("MISSING_HANDLER", "Runtime tool dispatcher was not registered");
      tools[tool.name] = (input, invocation) => handler({ name: tool.name, arguments: input, _meta: { ...invocation.invocation.metadata, ezCallId: invocation.invocation.token, ezOnBehalfOf: invocation.invocation.principalId } });
    }
    const methods: Record<string, MethodHandler> = {};
    for (const [name, handler] of handlers) {
      if (["tools/call", "tools/list", "initialize"].includes(name)) continue;
      const inputSchema = {};
      const outputSchema = {};
      methods[name] = { inputSchema, outputSchema, handle: async (input) => {
        const result = await handler(input);
        return result === undefined ? null : result;
      } };
    }
    const declared = Object.entries(methods).map(([name, method]) => ({ name, inputSchema: method.inputSchema, outputSchema: method.outputSchema }));
    return defineExtension({ manifest: { ...manifest, ...(declared.length ? { methods: declared } : {}) }, tools, methods });
  } catch (error) {
    restore();
    throw error;
  }
}
