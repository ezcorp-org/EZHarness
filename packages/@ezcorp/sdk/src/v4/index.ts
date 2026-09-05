import { ContractError, assertJson, compileValueSchema, validateInvocationContext, validateManifest } from "@ezcorp/extension-contract";
import type { ExtensionManifestV4, InvocationContext, ValueSchema } from "@ezcorp/extension-contract";
import { withExtensionContext } from "./context";

export * from "@ezcorp/extension-contract";
export { serve, createSession } from "./serve";
export type { ServeOptions, Session } from "./serve";
export { getInvocationContext, getGrantedEnv } from "./context";
export { createMcpExtension } from "./mcp";
export { createRuntimeExtension, defineRuntimeManifest, unwrapToolResponse, TOOL_RESULT_SCHEMA } from "./runtime";

export interface ExtensionContext {
  readonly invocation: Readonly<InvocationContext>;
  readonly signal: AbortSignal;
  call(method: string, input: unknown): Promise<unknown>;
}
export type ExtensionHandler = (input: unknown, context: ExtensionContext) => unknown | Promise<unknown>;
export interface MethodHandler {
  inputSchema: ValueSchema;
  outputSchema: ValueSchema;
  handle: ExtensionHandler;
}
export interface ExtensionDefinition {
  manifest: ExtensionManifestV4;
  tools?: Record<string, ExtensionHandler>;
  methods?: Record<string, MethodHandler>;
}
export interface DefinedExtension {
  readonly manifest: ExtensionManifestV4;
  invoke(name: string, input: unknown, context: ExtensionContext): Promise<unknown>;
  dispatch(method: string, input: unknown, context: ExtensionContext): Promise<unknown>;
}

export function defineExtension(definition: ExtensionDefinition): DefinedExtension {
  const manifest = structuredClone(validateManifest(definition.manifest));
  const tools = new Map<string, MethodHandler>();
  for (const tool of manifest.tools ?? []) {
    const handler = definition.tools?.[tool.name];
    if (typeof handler !== "function") throw new ContractError("MISSING_HANDLER", `Missing handler for ${tool.name}`);
    tools.set(tool.name, { inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, handle: handler });
  }
  if (Object.keys(definition.tools ?? {}).some(name => !tools.has(name))) throw new ContractError("UNDECLARED_HANDLER", "Every tool handler must be declared");
  const methods = new Map(Object.entries(definition.methods ?? {}));
  const declaredMethods = manifest.methods ?? [];
  if (methods.size !== declaredMethods.length || declaredMethods.some(method => !methods.has(method.name))) throw new ContractError("UNDECLARED_HANDLER", "Every method handler must be declared");
  function prepare(handlers: Map<string, MethodHandler>): Map<string, ExtensionHandler> {
    return new Map(Array.from(handlers, ([name, handler]) => {
      const checkInput = compileValueSchema(handler.inputSchema);
      const checkOutput = compileValueSchema(handler.outputSchema);
      return [name, async (input: unknown, context: ExtensionContext) => {
        validateInvocationContext(context.invocation);
        context.signal.throwIfAborted();
        checkInput(input);
        const output = await withExtensionContext(context, () => handler.handle(input, context));
        context.signal.throwIfAborted();
        checkOutput(output);
        return output;
      }];
    }));
  }
  const toolHandlers = prepare(tools);
  for (const metadata of declaredMethods) {
    const handler = methods.get(metadata.name)!;
    methods.set(metadata.name, { ...metadata, handle: handler.handle });
  }
  const methodHandlers = prepare(methods);
  function freeze(value: unknown): void {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(manifest);
  async function run(handlers: Map<string, ExtensionHandler>, name: string, input: unknown, context: ExtensionContext): Promise<unknown> {
    assertJson(input);
    const handler = handlers.get(name);
    if (!handler) throw new ContractError("METHOD_NOT_FOUND", "Unknown extension contribution");
    return handler(input, context);
  }
  const extension: DefinedExtension = { manifest, invoke: (name, input, context) => run(toolHandlers, name, input, context), dispatch: (name, input, context) => run(methodHandlers, name, input, context) };
  return Object.freeze(extension);
}
