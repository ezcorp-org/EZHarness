# Build an extension

## Prerequisites

Use an active account and a configured rootless extension runner. See [runner setup](../../deploy/extension-runner/README.md). The application must reach the runner through its authenticated connection; a missing runner must not cause unisolated execution.

## In the application

1. Open the extension author page, or ask the harness to build the feature.
2. Start from the current `extensions_describe` template. Add code, tests, and any assets to its workspace.
3. Build the exact revision. Inspect diagnostics and repair failed candidates.
4. Have a human administrator review the verified release and its requested access.
5. Activate that release and test the actual tool, page, skill, or agent.

The full repeatable sequence is in [Authoring](AUTHORING.md). The harness can build and request review. It cannot provide human approval.

## Local source

Run the CLI from the repository root. There is no installed `ezcorp` binary.

```sh
bun src/cli.ts ext init my-extension
bun src/cli.ts ext test ./my-extension
```

`ext init` writes the shared default v4 source scaffold. Edit its inline manifest in `extension.ts`, implementation in `src/echo.ts`, and test in `src/echo.test.ts`. `ext test`, `ext verify`, and `ext dev` all run isolated builds; `ext dev` is not a hot-reload installer. The SDK is supplied by the locked runner toolchain. Resolve any additional dependencies before building through the workspace lifecycle.

For a typed SDK template, use `bun src/cli.ts ext init my-extension --type skill`. The supported types are `tool`, `skill`, `agent`, and `multi`. These templates include a worker-only `ezcorp.config.ts`; the host does not import it. A missing or invalid type fails before source is written.

To stage local source for review, set `EZCORP_USER_ID` to the active administrator who owns the installation, then run:

```sh
bun src/cli.ts ext install ./my-extension
```

Follow the returned author-page URL. Staging does not enable the extension. `--yes` cannot approve a release.

For an update, `ext update <name>` forks the current immutable release into a workspace. It does not fetch and activate remote code. See [supported source imports](v4-imports.md) for GitHub, marketplace, uploaded skills, and existing-installation adoption.

## Publishing

Marketplace publication uses the CLI and an active publisher's token. It builds and verifies the source, collects the sealed artifact, and publishes a version. An existing version cannot be overwritten, and tests cannot be skipped. Publishing is not installation approval.

Use `publishExtension({ extDir, token })` from the host-side publishing module when an explicit source directory is needed. Do not call that host module from extension code. Keep publisher tokens outside the extension workspace.

## Verify the result

- Invoke the active feature as the intended user.
- Check that another user cannot read its private output.
- Verify denial without the required grant and after revocation.
- Verify that a failed update leaves the previous release usable.
- Use real browser checks for user-facing changes, not only mocked HTTP responses.

## Troubleshooting

Inspect the durable build operation before retrying. Repair the reported source, test, dependency, or capability error in a new workspace revision. A runner outage must not trigger execution on the application host. See [API reference](api-reference.md) and [Manifest reference](manifest-schema.md).
