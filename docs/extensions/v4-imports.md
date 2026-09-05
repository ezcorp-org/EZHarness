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
GitHub credential. Each source request checks the active administrator,
project membership, origin, and current credential again. Use a read-only
repository-scoped credential. No global Git identity or child-supplied token is used.
Local source and uploaded skills remain UTF-8 text snapshots; binary assets are
refused explicitly until the contract has a typed binary representation.

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
