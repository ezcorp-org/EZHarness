# Extension authoring

Use the v4 lifecycle. Do not load extension configuration in the host, write a transport loop, or approve your own build.

## Build through the harness

1. Call `extensions_describe`. Use its current template and feature list instead of copying an old example.
2. Call `extensions_workspace` with `action: "create"`. Keep the returned installation ID, workspace ID, and revision.
3. Read before editing. Submit related writes and deletions in one `edit` with the observed `expectedRevision`. On a revision conflict, read again and reconcile; do not overwrite another edit.
4. Implement the requested behavior and feature tests. Use `@ezcorp/sdk/v4`; let the SDK manage framing, registration, cancellation, and error replies. Keep host access behind `ctx.call` or the supported runtime helpers.
5. After changing dependencies, call `resolveDependencies`. Build the returned locked revision, not the preceding revision.
6. Call `extensions_build` with the exact revision and a new idempotency key. Reuse that key only when retrying the same request.
7. Call `extensions_inspect` with the operation ID. `waitMs` can wait up to five minutes. A submitted operation is not a passing build. Read diagnostics, fix source in a new revision, and rebuild until the operation is verified.
8. Request approval for that exact release with `extensions_release`. A human administrator reviews source, tests, capabilities, and any project-write proposal. The harness cannot approve code or permissions, including through an API key or CLI flag.
9. Activate the approved release with the returned approval ID and expected active release. Inspect the installation, then invoke the actual feature through the harness and UI.

Done means the requested behavior works on the active release, including failure and recovery cases. An installation row, a passing builder-owned test, or an HTTP acceptance response alone is not proof.

## Source and registration

The shared workspace scaffold produces `extension.ts` with an inline manifest, `src/echo.ts`, `src/echo.test.ts`, and a README. It is used by the host and `scaffoldWorkspace` from `@ezcorp/sdk/scaffold`. The separate `scaffoldExtension` SDK helper supports tool, skill, agent, and mixed packages. Add nested source, tests, and assets as needed.

The manifest has `schemaVersion: 4`. Keep its data inline or import it inside the worker entrypoint. Use `defineExtension` and `serve` for explicit tools and methods, or `defineRuntimeManifest` and `createRuntimeExtension` for the retained SDK registration helpers. Migrated packages may retain a worker-only `ezcorp.config.ts`; the host never imports it. Register handlers before serving. Registration and discovery cannot perform host effects.

Use [the SDK entrypoint guide](../../packages/@ezcorp/sdk/src/v4/README.md) for these interfaces and [the manifest reference](manifest-schema.md) for the contract. Never import an `ezcorp.config.ts` in the host or run an extension postinstall script there.

## Tests and repair

- Test each declared contribution and the permissions it needs. Keep feature tests meaningful; do not delete an assertion to obtain a passing build.
- Test malformed input, denied capabilities, cancellation, and the expected user-visible error.
- Exercise the production runner and broker. A mocked subprocess is not isolation evidence.
- Use the same sealed release for review and activation. A source, dependency, permission, or test change needs a new build and approval.
- A failed candidate must leave the current approved release running. Repair the candidate; do not alter the active artifact.
- Inspect uncertain external effects before retrying. `outcome_unknown` is not permission to repeat a non-idempotent action.

## Data and authority

Use [host storage and virtual filesystem paths](data-storage.md). Do not discover host paths, read host environment variables, or save credentials in source, settings, logs, or test fixtures. HTTP credentials normally remain opaque host handles. Native MCP raw credentials need a separate explicit human grant.

The host supplies principal, conversation, project, release, and invocation identity. Payload fields cannot grant authority. Request only the capabilities the feature needs. Project writes require the exact approved project binding and, where required, a reviewed proposal.

Import, update, rollback, and uninstall use the same lifecycle. [Source imports](v4-imports.md) stage candidates; they never grant approval. Uninstall retains history and data. Do not add a hidden direct-install or unisolated fallback.

## Service workflows

1. Ship the workflow in the sealed release and declare delegated execution with `permissions.workflows.allowDelegated`. Do not add broad workflow names to replace job consent.
2. Build, review and activate the exact release. Separately, an authorized human previews and consents to the job for a live service account, project and limits. The host creates the consent binding; never send an `extensionReleaseBinding` field yourself.
3. Fire the job with the SDK `Workflows.runFor({ jobRef, input })`. A `started: true` reply means acceptance, not completion. Inspect the delegated run and its step results.
4. Keep the service account's identity. Do not supply the owner's user ID, create a substitute user conversation or obtain host paths from input. Service code agents receive explicit input only; direct `ctx.file`, `ctx.shell` and `ctx.llm` providers are unavailable. Use explicitly service-enabled, approved extension tools through `ctx.tools` instead.
5. Test the actual required tools and brokers, not just a transform. Verify the service principal, null human `userId`, project and capability denial, then revoke consent and prove another fire cannot create a run. A changed release requires new consent. Missing broker support must remain denied.

The [service security contract](security.md#service-workflows) explains the boundary. Pure-tool identity and revocation tests do not establish support for every storage, filesystem, network or credential operation. Do not replace a denied service broker with an unconfined host call.
