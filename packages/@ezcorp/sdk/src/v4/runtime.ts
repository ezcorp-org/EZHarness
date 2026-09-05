import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { ContractError, TOOL_RESULT_SCHEMA, assertJson, validateManifest } from "@ezcorp/extension-contract";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { installInvocationChannel } from "../runtime/channel";
import type { HostChannel } from "../runtime/channel";
import { withToolContext } from "../runtime/tool-context";
import { defineExtension } from "./index";
import type { DefinedExtension, ExtensionContext, ExtensionHandler, MethodHandler } from "./index";

export { TOOL_RESULT_SCHEMA };

export function unwrapToolResponse(response: unknown): unknown {
  assertJson(response);
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new ContractError("INVALID_RESPONSE", "Expected tool response");
  if ("error" in response) throw new ContractError("HANDLER_FAILED", "Tool request failed");
  if (!("result" in response)) throw new ContractError("INVALID_RESPONSE", "Tool response has no result");
  return response.result;
}

export function defineRuntimeManifest<Metadata extends Record<string, unknown>>(metadata: Metadata): Metadata & ExtensionManifestV4 {
  const tools = metadata.tools;
  if (tools !== undefined && !Array.isArray(tools)) throw new ContractError("INVALID_MANIFEST", "Tools must be an array");
  const manifest = { ...metadata, ...(tools ? { tools: tools.map(tool => ({ ...tool, outputSchema: tool.outputSchema ?? TOOL_RESULT_SCHEMA })) } : {}) };
  return validateManifest(manifest) as Metadata & ExtensionManifestV4;
}

export async function createRuntimeExtension(options: { manifest: Record<string, unknown>; register: () => unknown | Promise<unknown> }): Promise<DefinedExtension> {
  const manifest = defineRuntimeManifest(options.manifest);
  const context = new AsyncLocalStorage<ExtensionContext>();
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  let registering = true;
  function current(): ExtensionContext {
    const invocation = context.getStore();
    if (!invocation) throw new ContractError("NO_INVOCATION", "Host capabilities require an active invocation");
    invocation.signal.throwIfAborted();
    return invocation;
  }
  const channel: HostChannel = {
    request: async <Result>(method: string, params: unknown): Promise<Result> => {
      const invocation = current();
      if (method.startsWith("ezcorp/fs.") && params && typeof params === "object" && "path" in params && typeof params.path === "string") {
        const path = params.path;
        if (path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) throw new ContractError("INVALID_PATH", "Invalid virtual filesystem path");
        const absolute = posix.resolve("/project", path);
        const ownData = `/project/.ezcorp/extension-data/${manifest.name}`;
        params = { ...params, path: absolute === ownData || absolute.startsWith(`${ownData}/`) ? `/data${absolute.slice(ownData.length)}` : absolute };
      }
      return invocation.call(method, params) as Promise<Result>;
    },
    notify: (method, params) => {
      const invocation = current();
      void invocation.call(method, params).catch(() => { process.stderr.write("Extension host notification failed\n"); });
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
    function scoped(handler: (params: unknown) => unknown, input: unknown, invocation: ExtensionContext, toolName?: string): Promise<unknown> {
      const conversationId = invocation.invocation.metadata?.ezConversationId;
      return context.run(invocation, () => withToolContext({ invocation: invocation.invocation, extensionName: manifest.name, callId: invocation.invocation.token, conversationId: typeof conversationId === "string" ? conversationId : "", projectRoot: "/project", ...(toolName ? { toolName } : {}) }, () => handler(input)));
    }
    for (const tool of manifest.tools ?? []) {
      const handler = handlers.get("tools/call");
      if (!handler) throw new ContractError("MISSING_HANDLER", "Runtime tool dispatcher was not registered");
      tools[tool.name] = (input, invocation) => scoped(handler, { name: tool.name, arguments: input, _meta: { ...invocation.invocation.metadata, ezCallId: invocation.invocation.token, ezOnBehalfOf: invocation.invocation.principalId } }, invocation, tool.name);
    }
    const methods: Record<string, MethodHandler> = {};
    for (const [name, handler] of handlers) {
      if (["tools/call", "tools/list", "initialize"].includes(name)) continue;
      const inputSchema = {};
      const outputSchema = {};
      methods[name] = { inputSchema, outputSchema, handle: async (input, invocation) => {
        const result = await scoped(handler, input, invocation);
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
