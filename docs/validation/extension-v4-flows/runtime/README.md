# Extension v4 runtime lifecycle evidence

The replay runs all 13 cases in `web/e2e/file-organizer-real.spec.ts`; the
added durable case is titled
`lifecycle: disable denies effects; fresh human approval reactivates; uninstall retains history and refuses source re-import`.

It uses the bundled File Organizer through source import, isolated build,
browser human approval, activation, project binding, and real Hub events. It
persists real watched-folder state in the owned container. It then proves:

- disabled releases deny events;
- reactivation preserves the release but invalidates the old generation-bound
  project binding;
- the browser's Project access review creates a fresh exact-generation binding,
  after which events work again;
- uninstall denies events and listing visibility while preserving old release
  history and stored state;
- targeting the tombstoned installation returns `409` with code `uninstalled`;
- a fresh bundled import has a new disabled installation ID and no active
  release. It does not reuse the tombstoned installation's authority.

Run a final image with an empty owned receipt directory:

```sh
export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env EZ_RUNTIME_IMAGE=localhost/ezcorp-extension-v4:FINAL_TAG \
  EZ_RUNTIME_RECEIPT_DIR="$(mktemp -d /tmp/ez-runtime-receipt-XXXXXXXX)" \
  docs/validation/extension-v4-flows/runtime/replay-file-organizer-runtime.sh
```

The replay requires root and web frozen installs in the worktree. It uses only
an owned rootless runner socket, owned database and extension-data directories,
an owned Docker Compose project, and port 4282. It records source/image IDs,
test hash, Bun/Node versions, raw runner/app/Playwright logs, command exits,
and cleanup exit.

## Existing-image red receipts

`localhost/ezcorp-extension-v4:audit-final-ea445e9e` has immutable ID
`sha256:abc3644405188068cb2b0397f85199799b76d51336cb8d17e0a0d83492189962`.
Its matching source is `ea445e9e48bbaffa337452d2254a6b2b2d1dc778`; the current
runtime surface differs only in the AI-kit quickstart test.

- `artifacts/production-image-stale-binding-red.playwright.log.gz`: 12 existing
  real File Organizer cases pass; the initial lifecycle case red exposed the
  expected stale binding denial after reactivation.
- `artifacts/production-image-uninstalled-target-red.playwright.log.gz`: the
  old image returns `403 {"code":"forbidden","message":"Source target not
  found or access denied"}` for an owner targeting a tombstoned installation.
  This is actual behavior, not a predicted 500. The corresponding source fix
  returns owner-only `409` while keeping foreign and inconsistent-owner targets
  opaque.

The final green production-image replay must use an image built from commit
`0d6678aeca11a756f3d402802a362241cb67c251` or its integrated descendant.

The historical red command receipt uses the label `runner_log_exit`; that
value is the exit from `docker compose logs`, not the runner process. The
replay script records the corrected `app_log_exit` label.
