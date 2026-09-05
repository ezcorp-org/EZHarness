# @ezcorp/sdk

Authoring SDK for [ezcorp-ai](https://github.com/ezcorp-org/ezcorp) extensions —
shared manifest types, a `defineExtension` helper, and the runtime helpers used
by published extensions (fs, lock, rpc, channel, plus the Phase 2 wrappers for
http, invoke, panel, lifecycle, and storage).

## Version 4 authoring

Generate a complete tool, skill, agent, or combined extension:

```ts
import { scaffoldExtension } from "@ezcorp/sdk";

const { files } = scaffoldExtension({
  name: "my-extension",
  type: "tool",
  description: "My extension",
});
```

Write the returned files into a new directory. Every template includes a data-only
`ezcorp.config.ts`, an `extension.ts` SDK transport entrypoint, and executable
`extension.test.ts` tests. Tools declare input and output schemas and a smoke test.
Skills and agents also provide isolated metadata discovery.

The generated package has an exact SDK peer dependency for local editing. The
harness supplies its trusted SDK inside the build runner; do not add SDK or
contract packages to runtime dependencies. Use the matching SDK version locally
and run `bun test`.

Import the directory through **Extensions → Import Source**. The runner compiles,
type-checks, tests, and discovers the candidate in isolation. Review the results
and exact permissions, then obtain human approval before activation. A successful
local test does not approve a release.

Version 2/3 host-loaded configuration and manual stdin transports are not supported
by the active lifecycle. The legacy root `defineExtension` metadata helper is not
the version 4 runtime API: new entrypoints use `defineExtension` and `serve` from
`@ezcorp/sdk/v4`, as shown in the generated source.

## Exports map

Main public entry points:

| Specifier | Purpose |
|---|---|
| `@ezcorp/sdk/v4` | Validated definitions, `serve`, invocation context/cancellation, MCP adapters, and capability-bound network helpers. |
| `@ezcorp/sdk` | Manifest types (`ExtensionManifestV2`, `ToolDefinition`, `SkillDefinition`, …) and the `defineExtension` helper. |
| `@ezcorp/sdk/runtime` | Runtime helpers that speak the host protocol: fs (`atomicRead`, `atomicWrite`, `loadJSON`, `saveJSON`, `findProjectRoot`, `getExtensionDataDir`), lock (`withLock`, `createMutex`), rpc (`createToolDispatcher`, `toolResult`, `toolError`), channel (`getChannel`, `JsonRpcError`), plus Phase 2 wrappers `fetchPermitted`, `invoke`, `PanelBuilder`, `registerLifecycleHook`, and `Storage`. |
| `@ezcorp/sdk/entities` | Declarative-entity toolkit: the `EntityDeclaration` type, slug helpers (`isValidSlug`, `assertValidSlug`), record validation (`validateRecord`, `assertRecord`), KV-backed storage (`readEntityRecord`, `writeEntityRecord`, `listEntityRecords`), and tool builders (`buildEntityToolDefinitions`, `buildEntityToolHandlers`). |
| `@ezcorp/sdk/test` | Filesystem test harness, runtime reset helpers, mock restoration, and isolated entrypoint registration assertions. Test helpers do not approve releases. |

## Persistent extension data

Version 4 extensions use host-brokered virtual paths: `/data` for their own
persistent data and `/project` for explicitly granted project files. Use
`getExtensionDataDir()` and the SDK filesystem helpers; do not open host paths
or write the immutable release directory. Loop artifacts live under
`/data/loops/<loop-id>`. Each request is checked against the active invocation,
release grants, and project binding. See [version 4 imports](../../../docs/extensions/v4-imports.md).

## Documentation

- [Getting started](../../../docs/extensions/getting-started.md) — walkthrough from zero to a working extension.
- [API reference](../../../docs/extensions/api-reference.md) — every exported symbol with type signatures.
- [Version 4 lifecycle plan](../../../docs/extension-system-v4-plan.md) — isolated builds, immutable releases, and approval rules.
- [Data storage convention](../../../docs/extensions/data-storage.md) — where and how extensions persist state.

## License

MIT — see [LICENSE](./LICENSE).
