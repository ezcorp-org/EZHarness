# Source installation regression mapping

- [x] Canonical manifest and checksum validation: `src/__tests__/extension-crud.test.ts`.
- [x] Local source collection and GitHub immutable-tree byte preservation: the same suite uses the real collector and rootless builder.
- [x] Selected Git refs, malformed source, name conflicts, and failed upgrades: `src/__tests__/git-install.test.ts` uses real Git objects, PGlite, and rootless builds.
- [x] No automatic grants or updates: initial projection is absent before approval; each changed release needs fresh human approval.
- [x] Narrowed grants, immutable history, and uninstall retention: real lifecycle publication and storage queries verify the resulting state.
- [x] Unsupported generic Git remotes and legacy automatic update APIs fail explicitly. No legacy host execution is restored.

Check: `bun test ./src/__tests__/extension-crud.test.ts ./src/__tests__/git-install.test.ts`

Result: 35 tests pass, 69 assertions. This retains the original test count while replacing direct host installation with the supported v4 flow. GitHub HTTP responses are supplied from real local Git objects; this test does not claim live GitHub availability.
