# @ezcorp/sdk

Authoring SDK for [ezcorp-ai](https://github.com/ezcorp-org/ezcorp) extensions —
shared manifest types, a `defineExtension` helper, and the runtime helpers used
by published extensions (fs, lock, rpc, channel, plus the Phase 2 wrappers for
http, invoke, panel, lifecycle, and storage).

## Install

```sh
bun add @ezcorp/sdk
```

Bun is the only supported runtime. The package ships `"type": "module"` and a
`"bun"` export condition so in-repo development resolves source directly; npm
consumers import from the compiled `dist/` output.

## Quick start

Create `index.ts` in your extension directory:

```ts
#!/usr/bin/env bun
import { defineExtension } from "@ezcorp/sdk";
import {
  createToolDispatcher,
  getChannel,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const greet: ToolHandler = async ({ name }) =>
  toolResult(`Hello, ${name ?? "world"}.`);

const dispatcher = createToolDispatcher({ greet });
const channel = getChannel();
channel.onRequest(dispatcher);

export default defineExtension({
  manifestVersion: 2,
  name: "hello",
  version: "0.1.0",
  description: "Minimal extension showing tool dispatch.",
  tools: [
    {
      name: "greet",
      description: "Greet someone by name.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  ],
});
```

Run the extension host with your extension registered. Every request routed to
`greet` will land in the dispatcher and reply via `toolResult` / `toolError`.

## Exports map

The package exposes three entry points:

| Specifier | Purpose |
|---|---|
| `@ezcorp/sdk` | Manifest types (`ExtensionManifestV2`, `ToolDefinition`, `SkillDefinition`, …) and the `defineExtension` helper. |
| `@ezcorp/sdk/runtime` | Runtime helpers that speak the host protocol: fs (`atomicRead`, `atomicWrite`, `loadJSON`, `saveJSON`, `findProjectRoot`, `getExtensionDataDir`), lock (`withLock`, `createMutex`), rpc (`createToolDispatcher`, `toolResult`, `toolError`), channel (`getChannel`, `JsonRpcError`), plus Phase 2 wrappers `fetchPermitted`, `invoke`, `PanelBuilder`, `registerLifecycleHook`, and `Storage`. |
| `@ezcorp/sdk/test` | Reserved for a test-harness barrel. Empty today; populated in a follow-up release — import from `@ezcorp/sdk/runtime` for now. |

## Persistent extension data

Extensions store user-visible state under
`<projectRoot>/.ezcorp/extension-data/<extension-name>/`. Use
`getExtensionDataDir()` from `@ezcorp/sdk/runtime` to resolve that path
portably. See [docs/extensions/data-storage.md](../../../docs/extensions/data-storage.md).

## Documentation

- [Getting started](../../../docs/extensions/getting-started.md) — walkthrough from zero to a working extension.
- [API reference](../../../docs/extensions/api-reference.md) — every exported symbol with type signatures.
- [Manifest schema](../../../docs/extensions/manifest-schema.md) — the v2 manifest format and validation rules.
- [Data storage convention](../../../docs/extensions/data-storage.md) — where and how extensions persist state.

## License

MIT — see [LICENSE](./LICENSE).
