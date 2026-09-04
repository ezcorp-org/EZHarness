# Extension author migration

Extension authoring now runs through host tools: `extensions_describe`,
`extensions_workspace`, `extensions_build`, `extensions_inspect`, and
`extensions_release`.

Create or edit a workspace, build its exact revision, inspect diagnostics, and
request review of the verified release. A user approves that release and its
permissions in the host review page before activation.

This extension provides only `migration_status`. It cannot write workspaces,
install code, grant permissions, or approve a release. Old drafts must be
imported into a host workspace and rebuilt; they cannot be installed directly.
