# Authoring with v4

```ts
import { defineExtension, serve } from "@ezcorp/sdk/v4";

const extension = defineExtension({
  manifest: {
    schemaVersion: 4,
    name: "hello",
    version: "1.0.0",
    description: "Returns a greeting",
    author: { name: "Example" },
    permissions: {},
    tools: [{
      name: "greet",
      description: "Return a greeting",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "string" },
    }],
  },
  tools: { greet: async () => "Hello" },
});

await serve(extension);
```

Handlers receive validated input and `ctx`. Use `ctx.signal` for cancellation and `ctx.call(method, input)` for host capabilities. Calls carry the exact host invocation context. They fail after completion, cancellation, or the deadline. A worker cannot switch release, principal, or scope. The host remains responsible for authorization.

Declare other runtime handlers in `manifest.methods` and provide their implementations in `methods`. Their input and output schemas are validated too. All registered tools and methods must appear in discovery metadata.

`defineRuntimeManifest` and `createRuntimeExtension({manifest, register})` retain existing SDK tool/page/event registration vocabulary. They install a channel that uses invocation-scoped context, without starting the legacy stdin loop. Tool results use `TOOL_RESULT_SCHEMA` by default. Host effects are forbidden during registration and discovery. Register all handlers before serving. Import registration modules inside `register` if they access the channel at module load time. Runtime helper notifications are also host calls and require an active invocation.

The SDK owns framing, concurrent dispatch, errors, and cancellation. Do not write to stdout or add a second stdin reader. Use stderr for bounded logs. The runner owns hard resource limits and process termination; abort signals alone cannot stop CPU-bound code.

`serve` replaces `fetch` with the host network broker for its lifetime. Responses use bounded chunks up to 32 MiB. Request bodies are limited to 256 KiB. Network access requires an active invocation and host approval. `getGrantedEnv(name)` returns an opaque credential handle or `null`, never a secret. Use the handle in a request header; only the host can replace it for an approved destination. Do not log handles.

`getInvocationContext()` exposes the host-owned invocation metadata. Filesystem helpers use `/project` and `/data`; relative paths resolve under `/project`. The current extension's old `.ezcorp/extension-data/<name>` prefix maps to `/data`. Host paths and other extensions' data are not granted by this mapping.

For a packaged stdio MCP server, use `await serve(await createMcpExtension({ manifest }))`. The bridge runs inside the isolated worker, discovers a bounded catalog, and checks that catalog again before each tool call. The command and dependencies must be in the sealed artifact or an approved image. No host command execution or unrestricted network fallback is available.
