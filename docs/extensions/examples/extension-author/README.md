# extension-author

Bundled extension that lets the in-app LLM author new EZCorp
extensions on user request.

## What it does

When the user asks Ez (or any agent that allows
`extension-author/create_extension`) something like _"build me a tool
extension that returns the current weather"_, the LLM:

1. Calls `extension-author/create_extension({ name, type, description })`.
2. The host scaffolds the extension via `@ezcorp/sdk`'s
   `scaffoldExtension` (pure function — produces a file map for the
   four template types: `tool`, `skill`, `agent`, `multi`).
3. The bundled extension writes the file map under
   `<projectRoot>/.ezcorp/extension-data/extension-author/drafts/<draftId>/`.
4. It calls the new `ezcorp/drafts` reverse-RPC (bundled-only) to mint
   an `ez_drafts` row, and returns
   `{ draftId, openUrl: "/extensions/author?prefill=<draftId>", name, type }`
   to the LLM.
5. The Ez chat panel renders the result via `EzToolResultCard.svelte`
   as a one-button "Open prefilled form" pill.
6. The user clicks the pill, lands on `/extensions/author?prefill=...`,
   tweaks the manifest / index.ts as needed, and clicks **Install**.
7. The install endpoint runs `validateManifestV2`, the env-key-leak
   gate, and the smoke-spawn (for `tool`/`multi` types), then moves the
   draft dir into `<projectRoot>/.ezcorp/extensions/<name>/` and calls
   `installFromLocal(..., enabled: false)`.

The user explicitly enables the new extension after install (default
`enabled: false`).

## Tools

| Tool                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `create_extension`    | Scaffold + create the proposal-card draft                 |
| `validate_extension`  | Run `validateManifestV2` against a draft                  |
| `list_drafts`         | List the calling user's active extension-author drafts    |
| `read_draft`          | Return the file map of a draft directory                  |
| `write_draft_file`    | Patch a single file in a draft (path-allowlisted)         |
| `discard_draft`       | Delete a draft directory + mark its `ez_drafts` row consumed |

## Permissions

```ts
{
  filesystem: ["$CWD/.ezcorp/extension-data/extension-author"],
  custom: { drafts: { kinds: ["extension"] } },
}
```

No network, no shell, no env, no storage. The reverse-RPC
`ezcorp/drafts` is the only host capability it uses beyond filesystem.

The bundled-only gate is enforced by `BUNDLED_DRAFTS_ALLOWLIST` in
`src/extensions/drafts-handler.ts`. A user-installed extension that
declares `permissions.custom.drafts.kinds: ["extension"]` in its own
manifest cannot create drafts — the handler checks the calling
extension's NAME against the allowlist regardless of declared/granted
shape.

## Install gate (the LLM must read this)

User-installed extensions ride the same path as a CLI `ext:install`:
`installFromLocal(..., isBundled: false)`. The env-key-leak install
gate runs strict — any `permissions.env` name matching
`/(_API_KEY|TOKEN|SECRET)$/i` causes the install to be **REFUSED**.

When scaffolding for the user, the LLM must NOT request env grants
for credential-shaped names. If the user needs an API key, take it as
a tool input parameter at call time.

See `docs/extensions/AUTHORING.md` for the full authoring contract.

## Integration test

`e2e-server-pipeline.test.ts` spawns the extension as a subprocess via
`createTestExtension` and exercises the full round-trip: create
→ read → write → validate → discard. Mirrors the auto-note bundled
extension's pattern.
