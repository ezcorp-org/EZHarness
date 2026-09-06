# Extension source-import evidence

The evidence uses the real-auth browser server at `http://localhost:4283`, a fresh PGlite database, real isolated extension builds, and the opt-in local test marketplace surface. No external marketplace account, token, or write is used.

## Green marketplace lifecycle

Source commit: `6c7ce08a3972f4d697fa46c77e008e56c1fd2f4c`.

```
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock bash -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4283 EZCORP_E2E_EVIDENCE=1; cd web; bunx playwright test --config playwright.real.config.ts e2e/real-auth/extension-source-import.spec.ts --grep "member imports verified marketplace"'
```

Exit: `0`; one test passed in 1.4 minutes. The raw log hash is `ad1bfa7e7dc4a6067660b72aafef6484cd85f15e80965a8f852ffd0178e5e4fc`.

It proves visible marketplace import and build, human review and activation, visible transformed tool output, permission-change review, failed-update retention, uninstall, and fresh import. A same-name fresh activation is deliberately denied with `extension_name_in_use`; a distinct-name source from the fresh workspace then receives a new human approval and activates. Its storage starts empty, then writes and reads a new sentinel. A prior approval cannot activate the new release.

## Green local and public GitHub choices

Source commit: `c95b1b8df3202424b2547c3d6e0f8e5ba27c5f82`.

```
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock bash -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4283 EZCORP_E2E_EVIDENCE=1; cd web; bunx playwright test --config playwright.real.config.ts e2e/real-auth/extension-source-import.spec.ts --grep "host-owned local|pinned public GitHub"'
```

Exit: `0`; two tests passed in 53.4 seconds. The local fixture is created below the host-owned `.ezcorp/extensions` root and removed in cleanup. The GitHub import reads `ezcorp-org/EZHarness` at `2fea009e0a3015d6aec73eec35bbe45555edbb7c`, directory `docs/extensions/examples/harness-smoke-test`; it uses no credentials or external writes. Both use the visible source form and finish verified, disabled candidates.

Bundled source has separate real-auth coverage through `importAndActivateBundledExtension`. Generic Git remotes and automatic updates are unsupported and are not claimed here.

## Artifacts and limits

Compressed raw logs contain no credentials. The screenshots show the visible marketplace form, mobile form, exact review, permission update, and expanded tool output. Failed pre-green runs are retained only as sanitized raw receipts; the green receipts above are the merge evidence.

