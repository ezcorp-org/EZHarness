import { defineExtension, providerMethodSchemas, validateProviderMethodExchange, validateProviderMethodValue, type ExtensionDefinition, type ProviderCall, type SandboxProviderGroup, type SandboxProviderMethodGroup } from "@ezcorp/sdk/v4";

const groups: SandboxProviderMethodGroup[] = [
  { name: "sandbox.lifecycle.v1", methods: { create: "sandbox/create", inspect: "sandbox/inspect", start: "sandbox/start", stop: "sandbox/stop", destroy: "sandbox/destroy" } },
  { name: "sandbox.process.v1", methods: { start: "process/start", inspect: "process/inspect", readOutput: "process/output", cancel: "process/cancel" } },
  { name: "sandbox.files.v1", methods: { stat: "files/stat", list: "files/list", read: "files/read", write: "files/write", mkdir: "files/mkdir", remove: "files/remove", chmod: "files/chmod" } },
];

/** No backend connection or paths are accepted here. The host executes only
 * the immutable operation admitted for the active principal and release. */
export function localSandboxDefinition(): ExtensionDefinition {
  const methods: NonNullable<ExtensionDefinition["methods"]> = {};
  for (const group of groups) for (const [operation, name] of Object.entries(group.methods)) {
    const groupName: SandboxProviderGroup = group.name;
    methods[name] = {
      ...providerMethodSchemas(groupName, operation as never),
      async handle(input, context) {
        validateProviderMethodValue(groupName, operation as never, "input", input);
        const { call } = input as { call: ProviderCall };
        const response = await context.call("ezcorp/api.request", { method: "POST", path: `/api/local-sandbox/operations/${call.operationId}/execute` }) as { status?: number; body?: unknown } | null;
        if (response?.status !== 200 || typeof response.body !== "string" || Buffer.byteLength(response.body) > 512 * 1024) throw new Error("Local sandbox operation is unavailable");
        const result: unknown = JSON.parse(response.body);
        validateProviderMethodExchange(groupName, operation as never, input, result);
        return result;
      },
    };
  }
  return {
    manifest: {
      schemaVersion: 4, name: "local-sandbox", version: "1.0.0", description: "Persistent local workspaces for native EZHarness tools.", author: { name: "EZCorp" },
      permissions: { hostApi: { events: false, routes: [{ method: "POST", path: "/api/local-sandbox/operations/:id/execute" }] } },
      methods: Object.entries(methods).map(([name, method]) => ({ name, inputSchema: method.inputSchema, outputSchema: method.outputSchema, sensitivity: "ordinary" })),
      providers: [{ id: "local", kind: "sandbox", protocolMajor: 1, minimumHostContract: { major: 4, minor: 0 }, profiles: ["linux-exec.v1"], capabilities: [], configSchema: { type: "object", additionalProperties: false }, requiredPermissions: ["hostApi"], methodGroups: structuredClone(groups) }],
    },
    methods,
  };
}

export const localSandboxExtension = defineExtension(localSandboxDefinition());
