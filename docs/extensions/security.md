# Extension Security Model

EZCorp ships with a layered permission system. This document covers
the maintainer-facing surface for the **bundled extension** subset:
the hardcoded capability ceiling and the manifest lockfile.

For the runtime permission model (the Policy Decision Point,
per-capability approval, grant expiry, audit trail) see the docs under
[`docs/permissions/`](../permissions/):
[four-scope-modal.md](../permissions/four-scope-modal.md),
[capability-expiry.md](../permissions/capability-expiry.md), and
[audit-drilldown.md](../permissions/audit-drilldown.md).

## Bundled extensions vs. user-installed extensions

| | Bundled | User-installed |
|---|---|---|
| Source | shipped in this repo | git clone / GitHub release |
| Trust root | code review on the repo | per-install user prompt |
| Integrity check at spawn | skipped (files legitimately change with the repo) | full checksum gate |
| Capability ceiling | `src/extensions/bundled-ceiling.ts` (Phase 5) | manifest declaration |
| Manifest tamper detection | `manifest.lock.json` (Phase 5) | per-package checksums |

## The capability ceiling (`bundled-ceiling.ts`)

Every bundled extension has a hardcoded entry in
`src/extensions/bundled-ceiling.ts:BUNDLED_CEILING`. The ceiling is
the **maximum** grant that will ever be persisted for that extension,
no matter what the manifest declares or what the install caller
requests.

The install path in `bundled.ts` calls `clampToBundledCeiling()`
before persisting the grant. If the ceiling narrows the request, an
audit row with action `ext:bundled:ceiling-clamp` is written; the
admin UI will surface this as a Phase 6 follow-up.

**When you add or modify a bundled extension's `permissions` block**,
update `BUNDLED_CEILING[<name>]` in the same PR. Ceiling values
should mirror the new declaration — a divergence is a behavior
change at install (new installs after the PR will be clamped to the
narrower side).

**The ceiling is independent of the manifest.** If a maintainer
adds `network: ["evil.com"]` to a bundled extension's manifest
without also widening the ceiling, the install path silently clamps
to the ceiling. That is the intended supply-chain defense — a
malicious manifest cannot grant itself fresh permissions.

## The manifest lockfile (`manifest.lock.json`)

`manifest.lock.json` lives at the repo root and records, for each
bundled extension:

- `version` (manifest.version)
- `entrypoint` (manifest.entrypoint)
- `toolsHash` — SHA-256 of the canonicalized tools array

Canonicalization: tools sorted by name, each tool's keys sorted
alphabetically, `inputSchema` recursively sorted, arrays preserve
order. Hashes are prefixed `sha256-<base64>` so a future digest
migration can prefix-discriminate.

On every server boot, `bundled.ts`'s manifest-refresh path calls
`verifyManifestAgainstLock(name, manifest)`. Any mismatch on any
of the three fields is fail-closed: the extension is disabled, an
audit row with action `ext:bundled:manifest-tamper` is written, and
the on-disk manifest is NOT applied. Lockfile MISSING and MALFORMED
are also fail-closed.

### When to regenerate

Regenerate the lockfile any time you legitimately:

- Add a tool to a bundled extension's `manifest.tools`
- Remove a tool
- Rename a tool
- Modify a tool's `inputSchema` or `description`
- Change the manifest's `version` or `entrypoint`

Run:

```bash
# Show the diff without writing — review before committing
bun run scripts/regenerate-manifest-lock.ts --dry-run

# Write the lockfile
bun run scripts/regenerate-manifest-lock.ts

# Commit the lockfile alongside your manifest change
git add manifest.lock.json docs/extensions/examples/<name>/ezcorp.config.ts
git commit
```

The script's diff output (added / removed / changed) belongs in your
PR description so the reviewer can confirm the lockfile change matches
the manifest change.

### Why we still need the lockfile if we have the ceiling

The ceiling guards the **permission grant**. The lockfile guards the
**tool surface**. A compromised manifest could add a new tool that
exercises an EXISTING granted permission in an unforeseen way (e.g.
adding a `dump_database` tool to an extension that already has
`storage: true`). The lockfile catches this — adding a tool flips the
`toolsHash` and the boot path refuses to load until the maintainer
explicitly regenerates.

Both protections compose: a malicious PR has to widen the ceiling AND
regenerate the lockfile AND get review approval before reaching
end-user installs.

### Re-approval gate (Phase 5 extension to S9)

`detectVersionBumpRequiringReapproval` in `bundled.ts` originally
fired only on (version-changed AND permissions-changed). Phase 5
extends it to ALSO fire on tool-list signature drift, regardless of
version or permission changes — a tool-list change is always a
re-approval event. The legacy "pure version bump → no re-approval"
path is preserved for unchanged tool lists.

## Re-opening user-authored extensions for LLM edit

The bundled `extension-author.modify_extension` tool re-opens an
already-installed extension as an editable draft (`ezcorp/drafts.reopen`).
Three independent gates protect this — defence in depth:

1. **Owner-scoping.** `reopen` only resolves extensions whose
   `creator_user_id` matches the requesting user's token-backed `userId`
   (never RPC-supplied). A miss / not-owned / bundled all return the same
   opaque `NOT_FOUND_OR_NOT_MODIFIABLE` so the in-chat LLM cannot probe
   other users' extensions.
2. **Mandatory always-prompt.** `ezcorp:extension:modify` is in
   `SENSITIVE_KINDS`, carved out of the bundled auto-allow, and is
   **never persisted** — the user must Allow a permission card on *every*
   `modify_extension` call. This is the load-bearing "the assistant can
   never silently rewrite my extension" guarantee.
3. **The `modifiable` admin gate** (`extensions.modifiable`, default
   `false`). A per-extension flag an admin flips (Library → the
   extension → "Allow extension to be modified"). Distinct from gate 2: it is a
   multi-tenant *policy* lever — "even the owner needs admin sign-off to
   use the LLM-modify flow on this extension."

### Setting: `extensions:authorAutoModifiable`

Boolean deployment setting, **default `false`**, toggled by an admin in
Security settings. When `false` (default — unchanged behaviour for every
existing/upgraded deployment), gate 3 requires a manual admin flip per
authored extension. When `true`, an extension created via the in-chat
authoring flow (`creator_user_id != null`) is persisted with
`modifiable = true` so its creator can ask the assistant to edit it
without the per-extension admin step.

Safety: this relaxes **only gate 3**. Gates 1 and 2 are untouched, so
the assistant still cannot silently modify anything and cannot reach
another user's extensions. The setting is read strictly (`=== true`) at
`installer.ts` install time, so an unset/non-boolean value fail-safes to
the historical secure default. It is **going-forward only** — it never
backfills existing rows, and same-name reinstall / in-place modify
preserves the existing `modifiable`. Non-authored installs
(bundled/github/mcp/CLI, `creator_user_id == null`) are never affected
regardless of the setting.
