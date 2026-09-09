# multi-agent-orchestrator Extension

A schema-version-4 extension that supplies a planning and execution persona for
complex development work. Its `extension.ts` entrypoint serves the manifest
through the isolated v4 runner. The package has no callable tools, but it is
still a verified release with a runtime wrapper.

## Install for review

Run this from the repository root as the active administrator:

```sh
EZCORP_USER_ID=<active-admin-id> bun src/cli.ts ext install ./docs/extensions/examples/multi-agent-orchestrator
```

The command stages and verifies source. It does not activate the extension.
Open the returned author page, have an administrator approve the verified
release, then activate it. `--yes` cannot approve a release.

## Manifest

`ezcorp.config.ts` uses `defineRuntimeManifest` from `@ezcorp/sdk/v4` and
schema version 4. Its `agent` contribution contains the planner and executor
guidance. It has no `subAgents` field. `extension.ts` creates the v4 runtime
extension and serves that manifest; it does not register callable tools.

## Testing

```sh
bun test docs/extensions/examples/multi-agent-orchestrator/index.test.ts \
  docs/extensions/examples/multi-agent-orchestrator/extension.test.ts
```

The tests check the v4 manifest contract and the runtime entrypoint.
