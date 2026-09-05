# Importing extension source in version 4

Use a lifecycle workspace for source, an isolated build for executable metadata,
and a separate human review for the exact release. Import does not approve or
activate anything. The result includes the installation, workspace, queued build,
and review URL.

An active administrator in a human session can call
`POST /api/extensions/import-source` with one of these source descriptions:

- `{kind:"local",path:"/approved/root/extension"}`: a regular directory beneath
  a host-owned install root or registered project's authored-extension root.
- `{kind:"bundled",name:"scratchpad"}`: one exact first-party inventory entry.
- `{kind:"github",repository:"owner/repository",ref:"commit-or-branch",directory:"optional/subdirectory"}`:
  a GitHub tree pinned before blob collection, with redirects, links, submodules,
  traversal, environment files, and oversized input refused.
- `{kind:"marketplace",versionId:"version-id"}`: source from an integrity-checked
  published release, rebuilt locally and reviewed again before activation.

For private GitHub source, add `projectId` to the GitHub request. The selected
project must have the exact repository as its Git origin and a host-stored
GitHub credential. Each source request checks the active human,
project membership, origin, and current credential again. Use a read-only
repository-scoped credential. No global Git identity or child-supplied token is used.

Source snapshots preserve UTF-8 text as strings. Compiled source and configuration
files are text-only; collectors remove their executable bit. Shell scripts and
other executable assets retain that bit. Binary and executable assets use
`{ encoding: "base64", data: "...", executable: false }`, with canonical base64 and
an explicit executable bit. Source maps are limited to 2,000 files and 20 MiB of
decoded content. Paths cannot collide with directories. JavaScript, TypeScript,
JSON, YAML, and TOML source/control files must remain text. The runner stages
assets read-only (0444), or read/execute only (0555) when declared executable.
No asset executes on the host. Content and executable mode are bound to the
source, artifact, and published release digests.

The authoring editor can upload, download, and delete binary assets. Binary
content cannot be edited as text. Set a nested destination in the file path
field before uploading. Edits create a new revision and require a new build and
approval. The production server admits at most 128 MiB of serialized request
data; workspace validation still enforces the smaller decoded source limit.

To replace an existing installation, add `targetInstallationId` with its exact
identifier. An active human owner can import GitHub or marketplace source into
that installation, even without the administrator role. New installations and
host-local source still require an administrator. Target ownership is checked
before collection; an administrator cannot take another user's installation.
Adoption preserves its identifier, owner, data namespace, and existing links.
Legacy grants are removed. An active v4 release remains unchanged while the new
candidate is built. Source names never cause an automatic match or takeover.
Unknown request fields, including raw credentials, are rejected rather than saved.

Uploaded skills use the same lifecycle through the import wizard. See
`src/runtime/import/README.md` for script limits and interpreter requirements.
Reopen forks the active immutable source snapshot. It never copies the former
installation's host directory. Changes do not alter the active release until a
new exact release receives human approval and is activated.

## Remaining gaps

Generic non-GitHub git remotes and automatic remote-source updates are not
implemented by the v4 source collector. Import an explicitly selected supported
source revision instead. The old direct install/update entrypoints reject the
request rather than evaluate configuration or reuse old approval. Uninstall
retains source and user data; filesystem purge is not an implicit uninstall step.
These restrictions are not claims of full legacy source-format parity.

The three reserved ez-factory workflow agents are installed only when an approved
release matches this host build's checked-in first-party source digest. Agent
writes share the release publication transaction. A conflicting user-owned agent
is kept; publication fails instead of using that agent's prompt. Disabling the
release removes its live agent registrations but keeps stored user data.
Host-managed rows carry an internal installation identifier. Startup loads them
only for an acknowledged active release with the exact approved grants. Ordinary
user agents with the same name remain available, but factory workflows cannot
use them as substitutes. Migration marks only exact ownerless legacy built-ins;
it does not claim user-owned or changed rows.

Historical first-party source attestation is not yet retained across host
upgrades. If a previous host build's ez-factory source digest is no longer in the
current lock, its workflow agents do not load automatically. Build and approve
the current bundled source. An extension name alone is never proof of trust.

The old `extensions:authorAutoModifiable` setting and per-install `modifiable`
flag do not authorize v4 execution. An owner can fork and edit an immutable
workspace candidate within their permitted scope. This does not change active
code or grants. The exact verified release still requires separate human
administrator approval. Other users cannot use this change to access its source.
