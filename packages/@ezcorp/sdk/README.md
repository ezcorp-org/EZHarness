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

The package exposes four entry points:

| Specifier | Purpose |
|---|---|
| `@ezcorp/sdk` | Manifest types (`ExtensionManifestV2`, `ToolDefinition`, `SkillDefinition`, …) and the `defineExtension` helper. |
| `@ezcorp/sdk/runtime` | Runtime helpers that speak the host protocol: fs (`atomicRead`, `atomicWrite`, `loadJSON`, `saveJSON`, `findProjectRoot`, `getExtensionDataDir`), lock (`withLock`, `createMutex`), rpc (`createToolDispatcher`, `toolResult`, `toolError`), channel (`getChannel`, `JsonRpcError`), plus Phase 2 wrappers `fetchPermitted`, `invoke`, `PanelBuilder`, `registerLifecycleHook`, and `Storage`. |
| `@ezcorp/sdk/entities` | Declarative-entity toolkit: the `EntityDeclaration` type, slug helpers (`isValidSlug`, `assertValidSlug`), record validation (`validateRecord`, `assertRecord`), KV-backed storage (`readEntityRecord`, `writeEntityRecord`, `listEntityRecords`), and tool builders (`buildEntityToolDefinitions`, `buildEntityToolHandlers`). |
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
