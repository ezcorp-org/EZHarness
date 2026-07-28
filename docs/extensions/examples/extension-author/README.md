# extension-author

Bundled extension that lets the in-app LLM author new EZCorp
extensions on user request.

## What it does

When the user asks Ez (or any agent that allows
`extension-author/create_extension`) something like _"build me a tool
extension that returns the current weather"_, the LLM:

1. Calls `extension-author/create_extension({ name, type, description })`.
2. The extension scaffolds via `@ezcorp/sdk`'s `scaffoldExtension` (pure
   function — produces a file map for the four template types: `tool`,
   `skill`, `agent`, `multi`).
3. It ships that file map to the `ezcorp/drafts` reverse-RPC
   (bundled-only), and **the host** mints the `ez_drafts` row AND
   materializes the files to
   `<projectRoot>/.ezcorp/extension-data/extension-author/drafts/<userId>/<draftId>/`.
   The sandboxed subprocess does NO filesystem work on the create path —
   that is what removes the grant-dir bootstrap deadlock (see the header
   comment in `index.ts`).
4. `create_extension` returns
   `{ draftId, openUrl: "/extensions/author?prefill=<draftId>", name, type }`
   to the LLM.
5. `create_extension` declares `cardType: "ez-draft"`, so the chat panel
   routes its result to `EzToolResultCard.svelte` and the returned
   `openUrl` renders as a one-click **Open draft editor** link.
   (`install_draft` uses `cardType: "ez-install"` for its own
   "Open extension" link.)
6. The user opens that link, lands on `/extensions/author?prefill=...`,
   tweaks the manifest / index.ts as needed, and clicks **Install**.
7. The install endpoint runs the shared acceptance gate
   (`runAuthorAcceptanceGate`: manifest load + `validateManifestV2`, plus
   a sandboxed `smokeTest` round-trip for `tool`/`multi`), then the
   env-key-leak gate, then moves the draft dir into
   `<projectRoot>/.ezcorp/extensions/<name>/` and calls
   `installFromLocal`.

**Two install paths, two enable defaults.** The web form path
(`POST /api/extensions/author/install`) installs `enabled: false` — the
user flips it on in the library. The in-chat path
(`install_draft` → `ezcorp/drafts.install`) passes `enable: true`, so an
install the user has just explicitly approved through the permission
card is immediately testable. Everything else about the two paths is
identical: same owner scope, same gate, same env-key-leak check.

## Tools

| Tool                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `create_extension`    | Scaffold + create the draft (cardType `ez-draft` — renders the "Open draft editor" link) |
| `validate_extension`  | Run the host's full acceptance gate against a draft (manifest + sandboxed `smokeTest` round-trip for tool/multi) |
| `list_drafts`         | List the calling user's active extension-author drafts    |
| `read_draft`          | Return the file map of a draft directory (plus any files it could not read) |
| `write_draft_file`    | Patch a single file in a draft (path-allowlisted)         |
| `discard_draft`       | Delete a draft directory + mark its `ez_drafts` row consumed |
| `install_draft`       | Install a validated draft as a real, ENABLED extension (cardType `ez-install`) — the REQUIRED terminal step |
| `modify_extension`    | Re-open an already-installed, user-authored extension for editing + re-install |

`validate_extension` and the preview page's **Validate** button run the
SAME gate the install runs (`runAuthorAcceptanceGate`). A green validate
means the install will not be rejected by the gate.

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
`new ExtensionProcess(...)` and exercises the round-trip: create → read
→ write → validate → discard, plus `install_draft` / `modify_extension`
against a **stubbed** `ezcorp/drafts` host (success, structured-failure,
and shape-broken-response branches). The real install pipeline is NOT
exercised here — `installAuthoredDraft` is covered by
`src/__tests__/author-install.test.ts` and
`web/src/__tests__/extension-author-install.server.test.ts`.

The suite also runs the real `verifyExtension` against this directory,
so the extension that gates other extensions has to clear its own gate.
