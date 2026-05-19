# Changelog

All notable changes to `@ezcorp/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-17

Initial public release. Extracts the authoring surface used by in-repo
extensions into a standalone package that third-party authors can install with
`bun add @ezcorp/sdk`.

### Added

- **Manifest types** (`@ezcorp/sdk`): `ExtensionManifestV2`, `ToolDefinition`,
  `SkillDefinition`, and supporting JSON-RPC / tool-call types.
- **`defineExtension` helper** (`@ezcorp/sdk`): identity-function helper
  providing type inference for extension config objects, following the
  ecosystem convention (Vite `defineConfig`, Drizzle `defineConfig`).
- **Runtime entry** (`@ezcorp/sdk/runtime`):
  - `fs`: `findProjectRoot`, `getExtensionDataDir`, `atomicRead`,
    `atomicWrite`, `loadJSON`, `saveJSON`.
  - `lock`: `withLock`, `createMutex`.
  - `rpc`: `createToolDispatcher`, `toolResult`, `toolError`, plus
    `ToolHandler` / `ToolDispatcherOptions` types.
  - `channel`: `getChannel`, `JsonRpcError`, `HostChannel` type, and
    `__resetChannelForTests` / `createHostChannelForTests` test hooks.
  - `http`: `fetchPermitted`.
  - `invoke`: `invoke` + `InvokeOptions`.
  - `panel`: `PanelBuilder` + `PanelColor`, `PanelTextVariant`,
    `PanelStatusState`, `PanelListItemStatus`, `PanelBuilderListItem`,
    `PanelBuilderAction` types.
  - `lifecycle`: `registerLifecycleHook` + `LifecycleEvent`.
  - `storage`: `Storage` + `StorageScope`, `StorageGetResult`,
    `StorageSetResult`, `StorageSetOptions`, `StorageListOptions`,
    `StorageListResult`, `StorageDeleteResult`, `StorageBatchOp` types.
- **`./test` entry point** reserved in the exports map; the barrel is
  intentionally empty pending a follow-up release that ships the test harness.
- **Bun-first exports map** with a `"bun"` condition resolving to TypeScript
  source for in-repo development, and `"import"` resolving to compiled
  `dist/` output for published consumers.
- **Package metadata** for npm publish: `MIT` license, provenance enabled,
  `publishConfig.access: "public"`, repository / homepage / bugs links, and
  a trimmed `files` allow-list (`dist`, `src`, `README.md`, `CHANGELOG.md`).

[Unreleased]: https://github.com/ezcorp-org/ezcorp/compare/sdk-v0.1.0...HEAD
[0.1.0]: https://github.com/ezcorp-org/ezcorp/releases/tag/sdk-v0.1.0
