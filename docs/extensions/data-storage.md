# Extension data

## Choose the correct store

- Use host storage with `user` scope for private user data.
- Use `conversation` scope for state belonging to the host-bound conversation.
- Use `global` scope only for data intentionally shared within the installation.
- Use declared settings for visible configuration, not credentials.
- Use the credential broker for secrets. Do not copy secrets into files, source, settings, logs, or ordinary storage.

The host binds the installation and scope IDs. Extension-supplied user or conversation IDs do not grant access. Inactive users and revoked bindings cannot use the broker.

## Storage operations

Use `Storage` from `@ezcorp/sdk/runtime` during an active v4 invocation, for example `new Storage("user")`. Its `get`, `set`, `delete`, `list`, and `batch` methods call the host's bounded storage API. The host enforces value limits, installation quotas, and scope checks.

Write batches commit together. A separate `get` followed by `set` is not an atomic update. Process-local state and mutexes do not coordinate separate workers. Use SDK `withLock(key, action)` or `createMutex(key)` for shared read-modify-write operations. Keys are installation-scoped; include the logical record or conversation in a stable key when those records can change independently. Keep the critical section bounded. Do not perform an automatic callback retry around non-idempotent external effects.

Expired locks are not stolen. Uncertain effects quarantine the key. Recovery requires a disabled installation, human administrator, exact fence, and no admitted effects. A crash with an unresolved effect count remains blocked rather than releasing ownership by time alone. See [Runtime locks](../extension-runtime-locks.md) for limits and recovery.

## Files

Use host-mediated filesystem helpers such as `fsRead`, `fsWrite`, and `fsList` with virtual paths:

- `/project`: the current approved project binding.
- `/data`: this installation's extension-data namespace.

Relative paths resolve under `/project`. The current extension's historical `.ezcorp/extension-data/<name>` prefix maps to `/data` for migrated code. This mapping grants neither host paths nor another extension's data.

`/data` is installation-shared, not a private user vault. Put private state in user-scoped storage. Host data routes retain their own access checks; a filesystem path is not an authorization token.

Do not walk for `.git`, infer the host root from `cwd`, or use `EZCORP_PROJECT_ROOT` as authority. Direct worker filesystem access sees only its restricted environment; it does not expose persistent host data. Do not run a postinstall script on the host to create directories.

## Source assets are separate

Source files belong to immutable workspace revisions and sealed releases. Binary assets use the canonical base64 envelope and explicit executable bit. Code and control files remain text. Uploading an executable asset does not run it on the host. See [Imports](v4-imports.md).

## Upgrade and recovery

Uninstall retains data and history. Rollback changes active code only; it does not silently undo data writes. A storage schema change needs an explicit migration plan and a tested rollback policy.

The current migration facility covers the supported extension-storage rows. It is not an automatic converter for arbitrary filesystem trees, settings, or encrypted legacy state. Do not delete old data to make an upgrade pass.
